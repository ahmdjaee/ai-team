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

/** Satu pilihan model dari akun (Claude: `supportedModels()`, Gemini: config option `model` di agy). */
export type ModelOption = { id: string; name: string; description?: string };

/**
 * `none` belum ditambahkan · `ok` siap · `expired` perlu login ulang · `error` pemeriksaan terakhir
 * gagal karena hal lain · `unavailable` tidak bisa dipakai di mesin ini (program belum terpasang).
 */
export type AccountState = "none" | "ok" | "expired" | "error" | "unavailable";

export type LoginPhase = "starting" | "awaiting_code" | "verifying" | "done" | "failed" | "cancelled";

/** Status login yang sedang berjalan. URL hanya untuk pemilik — tidak pernah dicatat di log. */
export type LoginView = { phase: LoginPhase; url?: string; error?: string; startedAt: string; expiresAt: string };

export type AccountView = {
  provider: ProviderId;
  engine: EngineId;
  label: string;
  state: AccountState;
  email?: string;
  plan?: string;
  reason?: string;
  models: ModelOption[];
  defaultModel?: string;
  checkedAt?: string;
  addedAt?: string;
  login?: LoginView;
};

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
  | { type: "user"; text: string; from?: "owner" | "system" }
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
