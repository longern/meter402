import { makeId } from "./crypto";
import { errorResponse, jsonResponse, readJsonObject } from "./http";
import type { Env } from "./types";

type GateLease = {
  requestId: string;
  expiresAt: number;
};

type GateState = {
  leases: Record<string, GateLease>;
};

const STATE_KEY = "state";

export class AccountGate implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/claim") {
      const body = await readJsonObject(request);
      const requestId = String(body.request_id ?? "");
      const limit = positiveInt(body.concurrency_limit, 1);
      const leaseSeconds = positiveInt(body.lease_seconds, 3600);
      if (!requestId) {
        return errorResponse(400, "invalid_request_id", "Request ID is required.");
      }

      const now = Date.now();
      const state = await this.readState();
      this.dropExpired(state, now);
      if (Object.keys(state.leases).length >= limit) {
        await this.writeState(state);
        return jsonResponse(
          {
            ok: false,
            active_count: Object.keys(state.leases).length,
            concurrency_limit: limit,
          },
          { status: 429 },
        );
      }

      const leaseId = makeId("lease");
      state.leases[leaseId] = {
        requestId,
        expiresAt: now + leaseSeconds * 1000,
      };
      await this.writeState(state);
      return jsonResponse({
        ok: true,
        lease_id: leaseId,
        active_count: Object.keys(state.leases).length,
        expires_at: new Date(state.leases[leaseId].expiresAt).toISOString(),
      });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = await readJsonObject(request);
      const leaseId = String(body.lease_id ?? "");
      const state = await this.readState();
      this.dropExpired(state, Date.now());
      if (leaseId) delete state.leases[leaseId];
      await this.writeState(state);
      return jsonResponse({
        ok: true,
        active_count: Object.keys(state.leases).length,
      });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const state = await this.readState();
      this.dropExpired(state, Date.now());
      await this.writeState(state);
      return jsonResponse({
        active_count: Object.keys(state.leases).length,
      });
    }

    return errorResponse(404, "not_found", "No account gate route matches this request.");
  }

  async alarm(): Promise<void> {
    const state = await this.readState();
    this.dropExpired(state, Date.now());
    await this.writeState(state);
  }

  private async readState(): Promise<GateState> {
    return (
      (await this.ctx.storage.get<GateState>(STATE_KEY)) ?? {
        leases: {},
      }
    );
  }

  private async writeState(state: GateState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
    const nextExpiry = Math.min(
      ...Object.values(state.leases).map((lease) => lease.expiresAt),
    );
    if (Number.isFinite(nextExpiry)) {
      await this.ctx.storage.setAlarm(nextExpiry);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private dropExpired(state: GateState, now: number): void {
    for (const [leaseId, lease] of Object.entries(state.leases)) {
      if (lease.expiresAt <= now) delete state.leases[leaseId];
    }
  }
}

export async function claimAccountGate(
  env: Env,
  accountId: string,
  requestId: string,
  concurrencyLimit: number,
  leaseSeconds: number,
): Promise<{ ok: true; leaseId: string } | { ok: false; activeCount: number }> {
  const response = await accountGateStub(env, accountId).fetch(
    "https://account-gate.local/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        concurrency_limit: concurrencyLimit,
        lease_seconds: leaseSeconds,
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as
    | { lease_id?: string; active_count?: number }
    | null;
  if (response.ok && body?.lease_id) {
    return { ok: true, leaseId: body.lease_id };
  }
  return {
    ok: false,
    activeCount: numberFromUnknown(body?.active_count),
  };
}

export async function releaseAccountGate(
  env: Env,
  accountId: string,
  leaseId: string | null | undefined,
): Promise<void> {
  if (!leaseId) return;
  await accountGateStub(env, accountId).fetch("https://account-gate.local/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lease_id: leaseId }),
  });
}

export async function accountGateActiveCount(
  env: Env,
  accountId: string,
): Promise<number> {
  const response = await accountGateStub(env, accountId).fetch(
    "https://account-gate.local/status",
  );
  const body = (await response.json().catch(() => null)) as
    | { active_count?: number }
    | null;
  return numberFromUnknown(body?.active_count);
}

function accountGateStub(env: Env, accountId: string): DurableObjectStub {
  return env.ACCOUNT_GATES.get(env.ACCOUNT_GATES.idFromName(accountId));
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? Math.floor(value) : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}
