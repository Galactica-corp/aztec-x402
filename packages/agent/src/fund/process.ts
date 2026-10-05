/**
 * Drive one deposit from "L1 tx sent" to "claimed on Aztec". Resumable: every
 * step persists to deposits.json, so `aztec-x402 fund claim` can finish a
 * deposit whose funding page or process went away.
 */
import { Fr } from "@aztec/aztec.js/fields";
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { Session } from "../aztec/session.js";
import { CliError } from "../errors.js";
import { progress } from "../output.js";
import { toHex, type BridgeAdapter } from "./bridge.js";
import { saveDeposit, type DepositRecord } from "./deposits.js";

const MESSAGE_POLL_MS = 10_000;
/** L1→L2 messages become consumable after the next checkpoint, usually minutes. */
const MESSAGE_TIMEOUT_MS = 30 * 60_000;
/** A recorded L1 deposit still unmined after this long was dropped or never sent. */
const L1_GIVE_UP_MS = 60 * 60_000;

export type Phase = "waiting_l1" | "waiting_message" | "claiming" | "done" | "failed";

export async function completeDeposit(
  record: DepositRecord,
  bridge: BridgeAdapter,
  /** Opened only once the L1 side is settled: the PXE sync is slow. */
  getSession: () => Promise<Session>,
  dataDir: string,
  onPhase: (phase: Phase) => void = () => {},
  opts: { l1TimeoutMs?: number } = {},
): Promise<DepositRecord> {
  try {
    if (record.status === "awaiting_l1") {
      if (!record.l1TxHash) throw new CliError("Deposit has no L1 transaction yet", "no_l1_tx");
      onPhase("waiting_l1");
      progress(`Waiting for L1 deposit ${record.l1TxHash}...`);
      let deposit;
      try {
        deposit = await bridge.readDeposit(toHex(record.l1TxHash), opts.l1TimeoutMs);
      } catch (error) {
        const unmined = error instanceof Error && error.name === "WaitForTransactionReceiptTimeoutError";
        if (unmined && Date.now() - Date.parse(record.createdAt) > L1_GIVE_UP_MS) {
          record = { ...record, status: "failed" };
          throw new CliError(`L1 transaction ${record.l1TxHash} was never mined; nothing to claim`, "l1_not_mined");
        }
        throw error;
      }
      if (deposit.secretHash.toLowerCase() !== record.secretHash.toLowerCase()) {
        throw new CliError("L1 deposit was made with a different secret hash", "secret_mismatch");
      }
      if (deposit.recipient.toLowerCase() !== record.recipient.toLowerCase()) {
        throw new CliError("L1 deposit names a different Aztec recipient", "recipient_mismatch");
      }
      // The user may have changed the amount in the wallet; the event is authoritative.
      record = {
        ...record,
        status: "l1_confirmed",
        amount: deposit.amount.toString(),
        messageHash: deposit.messageHash,
        leafIndex: deposit.leafIndex.toString(),
      };
      saveDeposit(dataDir, record);
    }

    if (record.status === "l1_confirmed" || record.status === "claiming") {
      onPhase("waiting_message");
      progress("L1 deposit confirmed. Waiting for the message to reach Aztec (usually a few minutes)...");
      const session = await getSession();
      const messageHash = Fr.fromString(record.messageHash ?? "");
      const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
      while (!(await isL1ToL2MessageReady(session.node, messageHash))) {
        if (Date.now() > deadline) {
          throw new CliError(
            "L1→L2 message not ready after 30 minutes; run `aztec-x402 fund claim` later",
            "message_timeout",
          );
        }
        await new Promise((r) => setTimeout(r, MESSAGE_POLL_MS));
      }

      onPhase("claiming");
      record = { ...record, status: "claiming" };
      saveDeposit(dataDir, record);
      progress("Message ready. Proving the claim on Aztec (takes ~30-90s)...");
      const claimTxHash = await bridge.claim(session, record);
      record = { ...record, status: "claimed", claimTxHash };
      saveDeposit(dataDir, record);
    }
    onPhase("done");
    return record;
  } catch (error) {
    // Keep the record resumable; only note the error.
    const message = error instanceof Error ? error.message : String(error);
    saveDeposit(dataDir, { ...record, error: message });
    onPhase("failed");
    throw error;
  }
}
