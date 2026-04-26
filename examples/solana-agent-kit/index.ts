/**
 * Holdfast plugin for Solana Agent Kit (SAK v2)
 *
 * Adds four actions to any SolanaAgentKit instance:
 *   GET_HOLDFAST_REPUTATION      — read an agent's on-chain reputation
 *   CHECK_HOLDFAST_REQUIREMENTS  — pre-flight: does an agent meet score/tier/pact thresholds?
 *   CREATE_HOLDFAST_PACT         — initialise and fund an escrow pact
 *   GET_HOLDFAST_PACT            — read current pact / escrow state
 *
 * DEVNET ONLY — @holdfastprotocol/sdk is pre-audit; mainnet blocked by an on-package guard.
 *
 * Usage
 * -----
 *   import { SolanaAgentKit } from "@solana-agent-kit/core";
 *   import { holdfastPlugin } from "./index";      // or from "@holdfast/sak-plugin" once published
 *
 *   const agent = new SolanaAgentKit(keypair, rpcUrl, {});
 *   agent.use(holdfastPlugin);
 *
 * Peer deps: @solana-agent-kit/core, @holdfastprotocol/sdk@devnet, zod, @solana/web3.js
 */

import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import {
  createHoldfastClient,
  VerifTier,
  type HoldfastClientOptions,
  type CreatePactParams,
  ReputationNotFoundError,
  EscrowNotFoundError,
  ReputationThresholdNotMet,
  EscrowSignerRequiredError,
  EscrowAgentWalletRequiredError,
} from "@holdfastprotocol/sdk";

// ---------------------------------------------------------------------------
// Types re-exported from SAK so this file compiles standalone in examples/
// ---------------------------------------------------------------------------

// These come from @solana-agent-kit/core in a real plugin package.
// Typed inline here so the example is self-contained without installing SAK.
interface SolanaAgentKit {
  connection: { rpcEndpoint: string };
  wallet: { publicKey: PublicKey; signTransaction: unknown; signAllTransactions: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface Action<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  similes: string[];
  description: string;
  examples: Array<Array<{ input: Record<string, unknown>; output: string; explanation: string }>>;
  schema: T;
  handler: (agent: SolanaAgentKit, input: z.infer<T>) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientOptions(agent: SolanaAgentKit): HoldfastClientOptions {
  return { rpcUrl: agent.connection.rpcEndpoint };
}

function tierLabel(tier: VerifTier): string {
  return tier === VerifTier.Hardline
    ? "Hardline"
    : tier === VerifTier.Attested
    ? "Attested"
    : "Unverified";
}

// ---------------------------------------------------------------------------
// Action 1 — GET_HOLDFAST_REPUTATION
// ---------------------------------------------------------------------------

const getReputationSchema = z.object({
  agentPubkey: z
    .string()
    .describe("Base58 Solana public key of the agent whose reputation to fetch"),
});

const getReputationAction: Action<typeof getReputationSchema> = {
  name: "GET_HOLDFAST_REPUTATION",
  similes: [
    "check holdfast reputation",
    "get reputation score",
    "query agent reputation",
    "lookup agent trust score",
    "holdfast reputation",
  ],
  description:
    "Fetches the on-chain Holdfast reputation for a Solana agent. " +
    "Returns score (0–10000 basis points; 5000 = neutral), verification tier " +
    "(Unverified | Attested | Hardline), lifetime pact count, dispute count, " +
    "and last-updated timestamp. Reads directly from devnet RPC — no signer needed.",
  examples: [
    [
      {
        input: { agentPubkey: "AgentPubkeyBase58..." },
        output: JSON.stringify({
          agentPubkey: "AgentPubkeyBase58...",
          score: 7500,
          tier: "Attested",
          totalPacts: 42,
          disputeCount: 1,
          lastUpdated: 1744000000,
        }),
        explanation: "Agent has an above-neutral score (7500/10000) and secp256r1 attestation.",
      },
    ],
  ],
  schema: getReputationSchema,
  handler: async (agent, input) => {
    const client = createHoldfastClient(clientOptions(agent));
    try {
      const rep = await client.reputation.get(input.agentPubkey);
      return JSON.stringify({
        agentPubkey: input.agentPubkey,
        score: rep.score,
        tier: tierLabel(rep.tier),
        totalPacts: rep.totalPacts,
        disputeCount: rep.disputeCount,
        lastUpdated: rep.lastUpdated,
      });
    } catch (err) {
      if (err instanceof ReputationNotFoundError) {
        return JSON.stringify({
          agentPubkey: input.agentPubkey,
          error: "REPUTATION_NOT_FOUND",
          message: "No Holdfast reputation account found for this agent.",
        });
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Action 2 — CHECK_HOLDFAST_REQUIREMENTS
// ---------------------------------------------------------------------------

const checkRequirementsSchema = z.object({
  agentPubkey: z
    .string()
    .describe("Base58 public key of the agent to validate"),
  minScore: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe("Minimum acceptable reputation score (0–10000 bp). Default: 0"),
  minTier: z
    .enum(["Unverified", "Attested", "Hardline"])
    .optional()
    .describe("Minimum verification tier. Attested = secp256r1 key, Hardline = TEE-attested"),
  minPacts: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minimum number of lifetime completed pacts"),
});

const tierFromString = (s: string): VerifTier => {
  if (s === "Hardline") return VerifTier.Hardline;
  if (s === "Attested") return VerifTier.Attested;
  return VerifTier.Unverified;
};

const checkRequirementsAction: Action<typeof checkRequirementsSchema> = {
  name: "CHECK_HOLDFAST_REQUIREMENTS",
  similes: [
    "verify holdfast requirements",
    "check if agent qualifies",
    "preflight reputation check",
    "does agent meet trust requirements",
    "validate holdfast reputation",
  ],
  description:
    "Pre-flight check: returns whether an agent meets the specified Holdfast reputation " +
    "requirements (minimum score, tier, and/or pact count). Returns false — not an error — " +
    "for unregistered agents. Mirrors the on-chain validate_reputation_for_pact constraint " +
    "so your pre-flight matches what the program enforces.",
  examples: [
    [
      {
        input: {
          agentPubkey: "AgentPubkeyBase58...",
          minScore: 6000,
          minTier: "Attested",
          minPacts: 3,
        },
        output: JSON.stringify({
          agentPubkey: "AgentPubkeyBase58...",
          qualifies: true,
          score: 7500,
          tier: "Attested",
          totalPacts: 42,
        }),
        explanation:
          "Agent passes all three thresholds (score 7500 ≥ 6000, Attested ≥ Attested, 42 ≥ 3).",
      },
    ],
    [
      {
        input: { agentPubkey: "UnknownPubkey...", minScore: 5000 },
        output: JSON.stringify({
          agentPubkey: "UnknownPubkey...",
          qualifies: false,
          reason: "REPUTATION_NOT_FOUND",
        }),
        explanation: "Agent has no reputation account yet.",
      },
    ],
  ],
  schema: checkRequirementsSchema,
  handler: async (agent, input) => {
    const client = createHoldfastClient(clientOptions(agent));
    const requirements = {
      minScore: input.minScore,
      minTier: input.minTier ? tierFromString(input.minTier) : undefined,
      minPacts: input.minPacts,
    };
    try {
      const qualifies = await client.reputation.meetsRequirements(
        input.agentPubkey,
        requirements,
      );
      if (!qualifies) {
        const rep = await client.reputation.get(input.agentPubkey).catch(() => null);
        return JSON.stringify({
          agentPubkey: input.agentPubkey,
          qualifies: false,
          ...(rep
            ? { score: rep.score, tier: tierLabel(rep.tier), totalPacts: rep.totalPacts }
            : { reason: "REPUTATION_NOT_FOUND" }),
        });
      }
      const rep = await client.reputation.get(input.agentPubkey);
      return JSON.stringify({
        agentPubkey: input.agentPubkey,
        qualifies: true,
        score: rep.score,
        tier: tierLabel(rep.tier),
        totalPacts: rep.totalPacts,
      });
    } catch (err) {
      if (err instanceof ReputationNotFoundError) {
        return JSON.stringify({
          agentPubkey: input.agentPubkey,
          qualifies: false,
          reason: "REPUTATION_NOT_FOUND",
        });
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Action 3 — CREATE_HOLDFAST_PACT
// ---------------------------------------------------------------------------

const createPactSchema = z.object({
  counterpartyPubkey: z
    .string()
    .describe("Base58 public key of the counterparty (beneficiary) agent"),
  counterpartyAgentWallet: z
    .string()
    .describe("Base58 address of the counterparty's AgentWallet PDA"),
  mint: z
    .string()
    .describe(
      "Base58 address of the SPL token mint. Use So11111111111111111111111111111111111111112 for wrapped SOL",
    ),
  amount: z
    .string()
    .describe(
      "Escrow amount in token base units (lamports for wSOL). Pass as string to avoid JS number precision loss",
    ),
  releaseKind: z
    .enum(["task", "milestone", "timed"])
    .describe(
      "task = manual release by initiator; " +
        "milestone = requires arbiter verification; " +
        "timed = auto-release via crank after timeLockSecs",
    ),
  timeLockSecs: z
    .number()
    .int()
    .positive()
    .describe("Seconds from now until the time-lock expires"),
  agentWallet: z
    .string()
    .describe(
      "Base58 address of the signing agent's own AgentWallet PDA. " +
        "Required — agent must be registered with Holdfast before creating pacts.",
    ),
  arbiter: z
    .string()
    .optional()
    .describe("Base58 public key of an optional arbiter for dispute resolution"),
  minCounterpartyScore: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe("Pre-flight: reject counterparty if their score is below this threshold"),
  minCounterpartyTier: z
    .enum(["Unverified", "Attested", "Hardline"])
    .optional()
    .describe("Pre-flight: reject counterparty if below this verification tier"),
  deliverablesUri: z
    .string()
    .url()
    .optional()
    .describe("Optional IPFS or Arweave URI pointing to deliverables specification"),
});

const createPactAction: Action<typeof createPactSchema> = {
  name: "CREATE_HOLDFAST_PACT",
  similes: [
    "create holdfast pact",
    "create escrow pact",
    "initialize holdfast escrow",
    "start holdfast contract",
    "open holdfast agreement",
  ],
  description:
    "Creates and funds a Holdfast escrow pact. The signing agent is the initiator; " +
    "funds are locked in a vault PDA until the release condition is met. " +
    "Optionally enforces a minimum reputation threshold on the counterparty before " +
    "submitting the transaction. " +
    "DEVNET ONLY — requires a registered Holdfast AgentWallet.",
  examples: [
    [
      {
        input: {
          counterpartyPubkey: "CounterpartyPubkey...",
          counterpartyAgentWallet: "CounterpartyWalletPDA...",
          mint: "So11111111111111111111111111111111111111112",
          amount: "1000000000",
          releaseKind: "timed",
          timeLockSecs: 604800,
          agentWallet: "MyAgentWalletPDA...",
          minCounterpartyScore: 5000,
        },
        output: JSON.stringify({
          escrowId: "a1b2c3d4e5f6...",
          escrowAddress: "EscrowPDABase58...",
          status: "Funded",
          amount: "1000000000",
          vault: "VaultATABase58...",
        }),
        explanation:
          "Creates a 1 SOL timed-release pact funded immediately, counterparty must score ≥ 5000.",
      },
    ],
  ],
  schema: createPactSchema,
  handler: async (agent, input) => {
    const timeLockExpiresAt = Math.floor(Date.now() / 1000) + input.timeLockSecs;

    const reputationThreshold =
      input.minCounterpartyScore !== undefined || input.minCounterpartyTier !== undefined
        ? {
            minScore: input.minCounterpartyScore,
            minTier: input.minCounterpartyTier
              ? tierFromString(input.minCounterpartyTier)
              : undefined,
          }
        : undefined;

    const params: CreatePactParams = {
      counterparty: new PublicKey(input.counterpartyPubkey),
      counterpartyWallet: new PublicKey(input.counterpartyAgentWallet),
      mint: new PublicKey(input.mint),
      amount: BigInt(input.amount),
      releaseCondition: { kind: input.releaseKind, timeLockExpiresAt },
      agentWallet: new PublicKey(input.agentWallet),
      ...(input.arbiter ? { arbiter: new PublicKey(input.arbiter) } : {}),
      ...(reputationThreshold ? { reputationThreshold } : {}),
      ...(input.deliverablesUri ? { deliverablesUri: input.deliverablesUri } : {}),
    };

    const client = createHoldfastClient({
      ...clientOptions(agent),
      signer: agent.wallet as Parameters<typeof createHoldfastClient>[0]["signer"],
      agentWallet: new PublicKey(input.agentWallet),
    });

    try {
      const escrow = await client.escrow.createPact(params);
      const escrowPubkey = new PublicKey(Buffer.from(escrow.escrowId, "hex"));
      await client.escrow.depositEscrow(escrowPubkey);
      const funded = await client.escrow.getPact(escrowPubkey);

      return JSON.stringify({
        escrowId: escrow.escrowId,
        escrowAddress: escrow.address,
        status: EscrowStatusLabel[funded.status] ?? funded.status,
        amount: funded.escrowAmount.toString(),
        vault: funded.vault,
        timeLockExpiresAt,
      });
    } catch (err) {
      if (err instanceof ReputationThresholdNotMet) {
        return JSON.stringify({
          error: "REPUTATION_THRESHOLD_NOT_MET",
          message: err.message,
        });
      }
      if (err instanceof EscrowSignerRequiredError) {
        return JSON.stringify({
          error: "SIGNER_REQUIRED",
          message: "Agent wallet signer is required to create a pact.",
        });
      }
      if (err instanceof EscrowAgentWalletRequiredError) {
        return JSON.stringify({
          error: "AGENT_WALLET_REQUIRED",
          message:
            "agentWallet PDA is required. Register your agent with Holdfast first.",
        });
      }
      throw err;
    }
  },
};

// Mirrors EscrowStatus enum from SDK (not re-exported as a const enum)
const EscrowStatusLabel: Record<number, string> = {
  0: "Pending",
  1: "Funded",
  2: "Locked",
  3: "Released",
  4: "Disputed",
  5: "Refunded",
  6: "Closed",
  7: "Claimed",
};

// ---------------------------------------------------------------------------
// Action 4 — GET_HOLDFAST_PACT
// ---------------------------------------------------------------------------

const getPactSchema = z.object({
  escrowAddress: z.string().describe("Base58 address of the EscrowAccount PDA to read"),
});

const getPactAction: Action<typeof getPactSchema> = {
  name: "GET_HOLDFAST_PACT",
  similes: [
    "get holdfast pact",
    "check pact status",
    "fetch escrow status",
    "lookup holdfast pact",
    "read holdfast contract",
  ],
  description:
    "Reads the current state of a Holdfast escrow pact directly from devnet RPC. " +
    "Returns status, parties, amount, vault address, and relevant timestamps. " +
    "No signer required.",
  examples: [
    [
      {
        input: { escrowAddress: "EscrowPDABase58..." },
        output: JSON.stringify({
          escrowAddress: "EscrowPDABase58...",
          escrowId: "a1b2c3d4...",
          status: "Funded",
          initiator: "InitiatorBase58...",
          beneficiary: "BeneficiaryBase58...",
          amount: "1000000000",
          timeLockExpiresAt: 1744604800,
          createdAt: 1744000000,
        }),
        explanation: "Pact is funded and waiting for beneficiary to stake.",
      },
    ],
  ],
  schema: getPactSchema,
  handler: async (agent, input) => {
    const client = createHoldfastClient(clientOptions(agent));
    try {
      const pact = await client.escrow.getPact(new PublicKey(input.escrowAddress));
      return JSON.stringify({
        escrowAddress: pact.address,
        escrowId: pact.escrowId,
        status: EscrowStatusLabel[pact.status as number] ?? pact.status,
        initiator: pact.initiator,
        beneficiary: pact.beneficiary,
        arbiter: pact.arbiter !== "11111111111111111111111111111111" ? pact.arbiter : null,
        mint: pact.mint,
        vault: pact.vault,
        amount: pact.escrowAmount.toString(),
        initiatorStake: pact.initiatorStake.toString(),
        beneficiaryStake: pact.beneficiaryStake.toString(),
        timeLockExpiresAt: pact.timeLockExpiresAt,
        disputeWindowEndsAt: pact.disputeWindowEndsAt || null,
        createdAt: pact.createdAt,
        lockedAt: pact.lockedAt || null,
        releasedAt: pact.releasedAt || null,
      });
    } catch (err) {
      if (err instanceof EscrowNotFoundError) {
        return JSON.stringify({
          escrowAddress: input.escrowAddress,
          error: "ESCROW_NOT_FOUND",
          message: "No Holdfast escrow account found at this address.",
        });
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const holdfastPlugin = {
  name: "holdfast",
  actions: [
    getReputationAction,
    checkRequirementsAction,
    createPactAction,
    getPactAction,
  ] satisfies Action[],
};

export {
  getReputationAction,
  checkRequirementsAction,
  createPactAction,
  getPactAction,
};
