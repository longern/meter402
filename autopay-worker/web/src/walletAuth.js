import { getAddress } from "viem";

export function checksumAddress(address) {
  return getAddress(address);
}

export function buildSiweMessage({ authRequest, requestId, ownerAddress, origin, host }) {
  const policy = authRequest.policy;
  const chainId = Number(policy.network.split(":")[1] || "8453");
  const authorizeUrl = new URL("/authorize", origin);
  authorizeUrl.searchParams.set("request_id", requestId);

  return [
    `${host} wants you to sign in with your Ethereum account:`,
    ownerAddress,
    "",
    "Authorize meter402 autopay for the listed payment policy.",
    "",
    `URI: ${authorizeUrl.toString()}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${authRequest.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    `Expiration Time: ${policy.validBefore}`,
    "Resources:",
    ...authRequest.resources.map((resource) => `- ${resource}`),
  ].join("\n");
}
