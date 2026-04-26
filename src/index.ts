export {
  HoldfastClient,
  createHoldfastClient,
  PREAUDIT_WARNING,
  HOLDFAST_PROGRAM_ID,
  HOLDFAST_ESCROW_PROGRAM_ID,
} from "./client.js";
export type { HoldfastClientOptions } from "./client.js";

export {
  ReputationModule,
  ReputationNotFoundError,
  ReputationAccountCorruptError,
  IndexerRequestError,
} from "./reputation/index.js";

export {
  EscrowModule,
  EscrowNotFoundError,
  EscrowAccountCorruptError,
  EscrowSignerRequiredError,
  EscrowAgentWalletRequiredError,
  ReputationThresholdNotMet,
} from "./escrow/index.js";
export type { CreatePactParams } from "./escrow/index.js";

export {
  VerifTier,
  PactOutcome,
  EscrowStatus,
} from "./types.js";

export {
  HoldfastSdkError,
  sendAndConfirmWithRetry,
  pollTxStatus,
} from "./resilience.js";
export type { RetryOptions, PollOptions, TxStatus } from "./resilience.js";

export {
  registerAgentWallet,
  deriveAgentWalletPda,
} from "./registration/index.js";
export type {
  RegisterAgentWalletParams,
  RegisterAgentWalletResult,
} from "./registration/index.js";
export type {
  ReputationAccount,
  ReputationRequirements,
  HistEntry,
  HistoryPage,
  GetHistoryOptions,
  EscrowAccount,
  PactPage,
  ListPactsOptions,
  ReleaseCondition,
  TaskRelease,
  MilestoneRelease,
  TimedRelease,
} from "./types.js";
