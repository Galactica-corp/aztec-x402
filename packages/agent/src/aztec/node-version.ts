import { CliError } from "../errors.js";

/** Major Aztec version this client is built against (`@aztec-labs/*@6.0.0-rc.3`). */
export const EXPECTED_AZTEC_MAJOR = 6;

/**
 * A saved `nodeUrl` from an older network still answers `getNodeInfo`. Reject it
 * before the PXE syncs or any transaction is built.
 */
export function assertNodeVersion(nodeVersion: string, nodeUrl: string): void {
  const major = Number(/^(\d+)/.exec(nodeVersion)?.[1]);
  if (major === EXPECTED_AZTEC_MAJOR) return;
  throw new CliError(
    `Aztec node ${nodeUrl} reports version ${nodeVersion}, but this client requires Aztec ${EXPECTED_AZTEC_MAJOR}.x. Point it at a ${EXPECTED_AZTEC_MAJOR}.x node with \`aztec-x402 config set nodeUrl <url>\` or AZTEC_X402_NODE_URL.`,
    "node_version",
    { nodeUrl, nodeVersion, expectedMajor: EXPECTED_AZTEC_MAJOR },
  );
}
