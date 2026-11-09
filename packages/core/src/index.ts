export {
  type AztecNetwork,
  type ExactAztecPayload,
  type ClientAztecSigner,
  type FacilitatorAztecSigner,
  type AztecClientConfig,
  type AztecFacilitatorConfig,
  type AztecServerConfig,
  type PaymentNoteVerification,
  type PrepareCommitmentResult,
  AZTEC_NETWORKS,
  SCHEME,
  CAIP_FAMILY,
} from "./types.js";

export {
  DEFAULT_TOKEN_DECIMALS,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  NOTE_DISCOVERY_POLL_INTERVAL_MS,
  NOTE_DISCOVERY_TIMEOUT_MS,
  NOTE_DISCOVERY_MAX_RETRIES,
} from "./constants.js";

export {
  generateCorrelationId,
  parsePrice,
  formatAmount,
  isValidAztecAddress,
  isAztecNetwork,
} from "./utils.js";

export {
  AztecNetworkSchema,
  AztecPaymentExtraSchema,
  AztecPrepareRequestSchema,
  AztecSdkResultSchema,
  AztecOffchainMessageSchema,
  AztecOffchainMessagesSchema,
  AztecTxEffectSchema,
  parseAztecPaymentExtra,
  unwrapAztecSdkResult,
  getAztecTxEffectArray,
  type AztecPaymentExtra,
  type AztecPrepareRequest,
  type AztecOffchainMessage,
} from "./schemas.js";

export {
  PAYMENT_MODES,
  PaymentModeSchema,
  OFFCHAIN_MESSAGE_TTL_MS,
  PAYMENT_ALREADY_USED,
  MAX_PROOF_MESSAGES,
  MAX_CIPHERTEXT_FIELDS,
  RefProofMessageSchema,
  RefPaymentProofSchema,
  SplitPaymentProofSchema,
  RefAztecPayloadSchema,
  SplitAztecPayloadSchema,
  SplitTermsSchema,
  payloadMode,
  type PaymentMode,
  type RefProofMessage,
  type RefPaymentProof,
  type SplitPaymentProof,
  type RefAztecPayload,
  type SplitAztecPayload,
  type SplitTerms,
  type ModeVerification,
} from "./modes.js";

export { MAX_PROOFS_PER_REF } from "./store.js";
export type {
  StoredProof,
  StoredSplitClaim,
  SplitClaimStatus,
  PaymentStateStore,
} from "./store.js";
