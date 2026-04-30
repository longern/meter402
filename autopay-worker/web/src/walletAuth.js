import { getAddress } from "viem";

export function checksumAddress(address) {
  return getAddress(address);
}

export function buildSiweMessage({ authRequest, requestId, ownerAddress, origin, host }) {
  const policy = authRequest.policy;
  const network = policy?.network || authRequest.network || "eip155:8453";
  const chainId = Number(network.split(":")[1] || "8453");
  const authorizeUrl = new URL("/authorize", origin);
  authorizeUrl.searchParams.set("request_id", requestId);
  const statement = authRequest.kind === "login"
    ? "Sign in to Meteria402 with your owner wallet."
    : "Authorize Meteria402 payment for the listed payment policy.";
  const expirationTime = policy?.validBefore || authRequest.expires_at;

  return [
    `${host} wants you to sign in with your Ethereum account:`,
    ownerAddress,
    "",
    statement,
    "",
    `URI: ${authorizeUrl.toString()}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${authRequest.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    `Expiration Time: ${expirationTime}`,
    "Resources:",
    ...authRequest.resources.map((resource) => `- ${resource}`),
  ].join("\n");
}
