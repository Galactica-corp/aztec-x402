import type { ClientAztecSigner } from "@aztech-x402/core";
import { ExactAztecClientScheme } from "@aztech-x402/mechanism/exact/client";
import { wrapFetchWithPayment } from "@aztech-x402/client";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4402";
const SENDER_ADDRESS = "0x" + "aa".repeat(32);

// ---------------------------------------------------------------------------
// Mock client signer — simulates an Aztec wallet
// ---------------------------------------------------------------------------

const mockClientSigner: ClientAztecSigner = {
  async getAddress() {
    return SENDER_ADDRESS;
  },

  async transferPrivateToPrivate(
    _tokenAddress: string,
    _to: string,
    amount: bigint,
  ) {
    // In production, this calls the Aztec token contract
    console.log(`  → Executing private transfer of ${amount} tokens...`);
    return "0x" + "ff".repeat(32); // Mock tx hash
  },
};

// ---------------------------------------------------------------------------
// Client flow
// ---------------------------------------------------------------------------

const scheme = new ExactAztecClientScheme(mockClientSigner);
const payFetch = wrapFetchWithPayment(fetch, scheme);

console.log(`Fetching ${SERVER_URL}/api/weather (payment-gated)\n`);

const response = await payFetch(`${SERVER_URL}/api/weather`);
const data = await response.json();

console.log(`\nResponse (${response.status}):`);
console.log(JSON.stringify(data, null, 2));
