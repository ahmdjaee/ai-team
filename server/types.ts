import type { AccountView as BaseAccountView, ModelOption as BaseModelOption } from "ai-agent-auth/types";

export type RoleId = "qa" | "engineer" | "devops" | "uiux";

/** Seberapa bebas agen bertindak dalam satu tugas. */
export type AutonomyMode = "auto" | "ask" | "readonly";

/** Mesin agen yang menjalankan satu penugasan: Claude Agent SDK, atau Antigravity CLI (`agy acp`). */
export type EngineId = "claude" | "antigravity";

export const ENGINE_IDS: EngineId[] = ["claude", "antigravity"];

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as string[]).includes(value);
}

/** Penyedia akun yang login di dalam app; satu akun per penyedia. */
export type ProviderId = "claude" | "gemini";

export const PROVIDER_IDS: ProviderId[] = ["claude", "gemini"];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as string[]).includes(value);
}

/** Mesin agen yang dijalankan dengan akun penyedia ini. */
export const PROVIDER_ENGINE: Record<ProviderId, EngineId> = { claude: "claude", gemini: "antigravity" };

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

/** Akun AI milik app (ai-agent-auth): pilihan model, status akun, dan status login. */
export type { AccountState, LoginPhase, LoginView, ModelOption } from "ai-agent-auth/types";

/** Akun yang menjalankan mesin Claude: login claude.ai milik app, atau gateway (base URL + token). */
export type ClaudeSource = "oauth" | "gateway";

/**
 * Gateway Claude yang kompatibel dengan API Anthropic (seperti alias `claude-gw` di terminal). Tokennya
 * tidak pernah dikirim ke web; `tokenHint` hanya beberapa karakter terakhir.
 */
export type GatewayView = {
  state: "ok" | "expired" | "error";
  baseUrl: string;
  host: string;
  tokenHint: string;
  models: BaseModelOption[];
  addedAt: string;
  checkedAt?: string;
  reason?: string;
};

/**
 * View akun dari library + mesin agen yang memakai akun ini. Akun `claude` juga membawa gateway-nya
 * (kalau ada) dan akun mana yang sedang dipakai bot.
 */
export type AccountView = BaseAccountView<ProviderId> & { engine: EngineId; gateway?: GatewayView; claudeSource?: ClaudeSource };

/** Hal yang pantas menarik perhatian pemilik produk, lintas tugas. */
export type AttentionEvent = {
  kind: "approval" | "question" | "needs_review" | "failed";
  taskId: string;
  role: RoleId;
  title: string;
  detail?: string;
  at: string;
  /** Tidak perlu notifikasi browser (Stop dari owner sendiri, atau turn berikutnya langsung jalan); kurator tetap terpicu. */
  silent?: boolean;
};

/** Status runner agen untuk satu tugas (beda dengan status tugas itu sendiri). */
export type WorkerStatus = "idle" | "starting" | "working" | "waiting" | "error";

export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

/** Pemakaian konteks sesi; maxTokens adalah batas tempat auto-compact terjadi. */
export type ContextUsage = { usedTokens: number; maxTokens: number; percentage: number };

export type UiEvent =
  | { type: "user"; text: string; from?: "owner" | "system"; attachments?: string[] }
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | { type: "delta"; kind: "text" | "thinking"; text: string }
  | { type: "tool"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; preview: string }
  | {
      type: "approval";
      approvalId: string;
      toolName: string;
      input: unknown;
      title?: string;
      description?: string;
      reason?: string;
      canRemember: boolean;
    }
  | { type: "approval_resolved"; approvalId: string; decision: "allow" | "deny"; remember?: boolean; message?: string }
  | { type: "question"; questionId: string; questions: AskQuestion[] }
  | { type: "question_resolved"; questionId: string; answers: Record<string, string> }
  | { type: "status"; status: WorkerStatus }
  | {
      type: "init";
      sessionId: string;
      model: string;
      permissionMode?: string;
      apiKeySource: string;
      toolCount: number;
      mcpServers: { name: string; status: string }[];
      /** Kosong di event lama = Claude. */
      engine?: EngineId;
    }
  | {
      type: "result";
      subtype: string;
      isError: boolean;
      durationMs: number;
      numTurns: number;
      /** Total berjalan sesi (`total_cost_usd`), bukan biaya turn ini. */
      costUsd?: number;
      /** Biaya turn ini saja: selisih total sesi terhadap result sebelumnya. Kosong di event lama. */
      turnCostUsd?: number;
      /** Turn dihentikan owner (Stop/batal/oper) — bukan kegagalan. */
      interrupted?: boolean;
      /** Turn yang dimulai CLI sendiri (mis. notifikasi Bash background), bukan jawaban atas pesan kita. */
      background?: boolean;
      /** Token turn ini (mesin yang tidak melaporkan biaya, mis. Antigravity). */
      tokens?: number;
    }
  | { type: "handoff"; from: RoleId; to: RoleId; note?: string; fromEngine?: EngineId; toEngine?: EngineId }
  | { type: "notice"; text: string }
  /** report.md baru saja ditulis agen — tab Laporan memuat ulang. Tidak disimpan. */
  | { type: "report_changed" }
  | { type: "compact"; trigger: "auto" | "manual"; preTokens: number; postTokens?: number }
  | ({ type: "context" } & ContextUsage)
  | { type: "error"; message: string };

export type StoredEvent = UiEvent & { seq: number; ts: string; taskId: string; role: RoleId };

/** Event yang hanya relevan saat live, tidak ditulis ke transcript. */
export const EPHEMERAL_EVENTS = new Set(["delta", "status", "context", "report_changed"]);
