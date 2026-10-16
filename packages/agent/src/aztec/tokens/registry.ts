/**
 * From a token address to its {@link TokenAdapter}.
 *
 * The kind is read from the chain, not configured: the deployed contract's
 * class id is matched against the artifacts this package ships. So a merchant
 * names a token only by address, a buyer needs nothing but the challenge's
 * `asset`, and a contract of any other class is refused instead of being
 * called with the wrong ABI.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { TokenContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js";
import type { PaymentGate, PaymentStore } from "@galactica-net/inference-money-core";
import { UsageError } from "../../errors.js";
import type { TokenAdapter, TokenContext, TokenKind } from "./adapter.js";
import { Aip20Token } from "./aip20.js";

const classIds = new Map<TokenKind, Promise<Fr>>();

function classIdOf(kind: TokenKind, artifact: () => Promise<ContractArtifact>): Promise<Fr> {
  let id = classIds.get(kind);
  if (!id) {
    id = artifact().then(async (a) => (await getContractClassFromArtifact(a)).id);
    classIds.set(kind, id);
  }
  return id;
}

/** Kinds in the order they are tried; the inference-money SDK loads only if AIP-20 did not match. */
const KINDS: ReadonlyArray<[TokenKind, () => Promise<ContractArtifact>]> = [
  ["aip20", async () => TokenContract.artifact],
  ["inference-money", async () => (await import("./inference.js")).inferenceTokenArtifact],
];

/** The kind of the token deployed at `address`; throws if none is deployed or its class is unknown. */
export async function identifyToken(node: Pick<AztecNode, "getContract">, address: string) {
  const instance = await node.getContract(AztecAddress.fromStringUnsafe(address));
  if (!instance) {
    throw new UsageError(`Token contract ${address} is not deployed on this network.`, "token_not_found");
  }
  for (const [kind, artifact] of KINDS) {
    if (instance.currentContractClassId.equals(await classIdOf(kind, artifact))) {
      return { kind, instance, artifact: await artifact() };
    }
  }
  throw new UsageError(
    `Contract ${address} is not a supported token (class ${instance.currentContractClassId}). Supported: ${KINDS.map(([k]) => k).join(", ")}.`,
    "unsupported_token",
  );
}

/**
 * The payment gate a buyer's wallet must be built through to pay `tokenAddress`,
 * or undefined when its kind needs none. Called before the wallet exists.
 */
export async function paymentGateFor(
  node: AztecNode,
  tokenAddress: string,
  store?: () => PaymentStore,
): Promise<PaymentGate | undefined> {
  if ((await identifyToken(node, tokenAddress)).kind !== "inference-money") return undefined;
  const { createPaymentGate } = await import("./inference.js");
  return createPaymentGate(node, store?.());
}

/** The tokens one wallet account uses, each identified and registered with the PXE on first use. */
export class TokenRegistry {
  private readonly tokens = new Map<string, Promise<TokenAdapter>>();

  constructor(private readonly ctx: TokenContext) {}

  get(address: string): Promise<TokenAdapter> {
    const key = address.toLowerCase();
    let token = this.tokens.get(key);
    if (!token) {
      token = this.load(address);
      this.tokens.set(key, token);
      // A failed lookup (node hiccup, token not deployed yet) is retried on the next call.
      token.catch(() => this.tokens.delete(key));
    }
    return token;
  }

  private async load(address: string): Promise<TokenAdapter> {
    const { kind, instance, artifact } = await identifyToken(this.ctx.node, address);
    await this.ctx.wallet.registerContract(instance, artifact);
    if (kind === "aip20") {
      return new Aip20Token(this.ctx, instance.address, TokenContract.at(instance.address, this.ctx.wallet));
    }
    const { InferenceMoneyToken } = await import("./inference.js");
    return new InferenceMoneyToken(this.ctx, instance.address);
  }
}
