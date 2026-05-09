import assert from "node:assert/strict";
import test from "node:test";

import {
  handleDepositIntent,
  handleDepositQuote,
  handleDepositSettle,
} from "../tmp/test-build/deposit-handlers.js";
import { signSessionState } from "../tmp/test-build/signed-state.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const MALICIOUS_OWNER = "0x2222222222222222222222222222222222222222";
const DEV_PROOF = "unit-test-dev-proof";

test("direct deposit settlement uses the signed quote owner, not the request body owner", async () => {
  const env = makeEnv();
  const quote = await createQuote(env);

  const response = await handleDepositSettle(
    jsonRequest("/api/deposits/settle", {
      payment_id: quote.payment_id,
      quote_token: quote.quote_token,
      dev_proof: DEV_PROOF,
      owner_address: MALICIOUS_OWNER,
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(env.DB.insertedAccountOwner?.toLowerCase(), OWNER.toLowerCase());
});

test("scan deposit settlement uses the signed intent owner, not the request body owner", async () => {
  const env = makeEnv();
  const quote = await createQuote(env);
  const intentResponse = await handleDepositIntent(
    new Request(`https://meteria.test/api/deposits/intent?i=${encodeURIComponent(quote.intent_token)}`),
    env,
  );
  const intent = await intentResponse.json();

  const response = await handleDepositSettle(
    jsonRequest("/api/deposits/settle", {
      payment_id: intent.payment_id,
      deposit_intent: intent.deposit_intent,
      dev_proof: DEV_PROOF,
      owner_address: MALICIOUS_OWNER,
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(env.DB.insertedAccountOwner?.toLowerCase(), OWNER.toLowerCase());
});

async function createQuote(env) {
  const session = await signSessionState(env, {
    owner: OWNER,
    autopay_url: "https://autopay.example.test",
    expires_at: Date.now() + 60_000,
  });
  const response = await handleDepositQuote(
    new Request("https://meteria.test/api/deposits/quote", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `meteria402_session=${encodeURIComponent(session)}`,
      },
      body: JSON.stringify({ amount: "5.00" }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  return response.json();
}

function jsonRequest(path, body) {
  return new Request(`https://meteria.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeEnv() {
  return {
    DB: new FakeD1(),
    X402_RECIPIENT_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    X402_RECIPIENT_ADDRESS: "0x3333333333333333333333333333333333333333",
    X402_NETWORK: "eip155:8453",
    X402_ASSET: "0x4444444444444444444444444444444444444444",
    X402_ASSET_SYMBOL: "USDC",
    X402_ASSET_DECIMALS: "6",
    DEFAULT_MIN_DEPOSIT: "5.00",
    DEFAULT_CONCURRENCY_LIMIT: "8",
    ALLOW_DEV_PAYMENTS: "true",
    DEV_PAYMENT_PROOF: DEV_PROOF,
  };
}

class FakeD1 {
  insertedAccountOwner = null;

  prepare(sql) {
    return new FakeD1PreparedStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) {
      if (statement.sql.includes("INSERT INTO meteria402_accounts")) {
        this.insertedAccountOwner = statement.bindings[1];
      }
    }
    return statements.map(() => ({ success: true }));
  }
}

class FakeD1PreparedStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new FakeD1PreparedStatement(this.db, this.sql, bindings);
  }

  async first() {
    return null;
  }

  async run() {
    return { success: true };
  }
}
