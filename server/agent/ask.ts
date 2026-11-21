import {
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "../accounts/claude.ts";
import { PROVIDER_LABEL, accountView, engineUsable, pickEngine, providerOf } from "../accounts/index.ts";
import { CONFIG } from "../config.ts";
import { AgyChat, type ChatOptions } from "../engines/antigravity/chat.ts";
import { effortFor, getSettings, modelFor, validModelId } from "../settings.ts";
import { askContext, workspaceForTask } from "../context.ts";
import { ARTIFACT_TOOLS, DENY_ALWAYS } from "../roles.ts";
import { addAskCost, getTask, taskDir } from "../tasks.ts";
import { ENGINE_IDS, isEngineId, type EngineId } from "../types.ts";

export type AskMessage = {
  role: "user" | "assistant";
  text: string;
  /** Mesin dan model yang menjawab (jawaban saja). */
  engine?: EngineId;
  model?: string;
  costUsd?: number;
  ts: string;
};

export type AskState = { messages: AskMessage[]; busy: boolean; costUsd: number };

/** Event panel Tanya: hidup hanya selama koneksi, tidak pernah ditulis ke mana pun. */
export type AskEvent =
  | { type: "delta"; text: string }
  | { type: "answer"; message: AskMessage }
  | { type: "busy"; busy: boolean }
  | { type: "error"; message: string };

const READ_TOOLS = ["Read", "Grep", "Glob"];

/** Pesan saat tidak ada mesin yang bisa menjawab. */
export const ASK_NEEDS_ACCOUNT = "Tanya butuh akun Claude atau Gemini — tambahkan di Pengaturan → Akun AI";

/**
 * Bawaan panel Tanya dari Pengaturan → Bot (baris Panel Tanya). Panel memilih mesin dan model sendiri per
 * pertanyaan; ini hanya pilihan awalnya dan isi opsi "Bawaan".
 */
export type AskDefaults = {
  /** Mesin di Pengaturan. */
  preferred: EngineId;
  /** Mesin yang benar-benar dipakai kalau panel tidak memilih: `preferred` kalau akunnya siap; kosong = tidak ada akun. */
  engine?: EngineId;
  /** Model bawaan per mesin: Pengaturan, lalu `MODEL_ASK` (Claude); Gemini kosong = bawaan akun agy. */
  models: Record<EngineId, string | undefined>;
};

export function askDefaults(): AskDefaults {
  const preferred = getSettings().askEngine;
  return {
    preferred,
    engine: pickEngine(preferred),
    models: { claude: modelFor("ask", "claude"), antigravity: modelFor("ask", "antigravity") },
  };
}

export type AskChoice = { engine: EngineId; model?: string };

/**
 * Pilihan mesin + model dari panel → pilihan yang dijalankan. Model harus ada di daftar model akunnya
 * (kalau daftar itu terbaca); kosong = bawaan Tanya.
 */
export function resolveAskChoice(input: { engine?: unknown; model?: unknown }):
  | { ok: true; choice: AskChoice }
  | { ok: false; status: number; error: string } {
  const defaults = askDefaults();
  if (!defaults.engine) return { ok: false, status: 409, error: ASK_NEEDS_ACCOUNT };
  if (input.engine !== undefined && input.engine !== "" && !isEngineId(input.engine)) {
    return { ok: false, status: 400, error: `mesin tidak dikenal (${ENGINE_IDS.join("/")})` };
  }
  const engine = isEngineId(input.engine) ? input.engine : defaults.engine;
  const usable = engineUsable(engine);
  if (!usable.ok) return { ok: false, status: 409, error: `Tanya: ${usable.reason}` };

  const requested = typeof input.model === "string" ? input.model.trim() : "";
  if (!requested) return { ok: true, choice: { engine, model: defaults.models[engine] } };
  if (!validModelId(requested)) return { ok: false, status: 400, error: "id model tidak sah" };
  const known = accountView(providerOf(engine)).models;
  if (known.length > 0 && !known.some((item) => item.id === requested) && requested !== defaults.models[engine]) {
    return { ok: false, status: 400, error: `model ${requested} tidak ada di akun ${PROVIDER_LABEL[providerOf(engine)]}` };
  }
  return { ok: true, choice: { engine, model: requested } };
}

/** Panel ini hanya membaca; apa pun yang bisa mengubah sesuatu ditolak diam-diam. */
export function askOptions(taskId: string, model: string, history: AskMessage[]): Options {
  const denyTool: CanUseTool = async (toolName, input) =>
    READ_TOOLS.includes(toolName)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `Panel Tanya hanya boleh membaca (${READ_TOOLS.join(", ")}).` };

  return {
    systemPrompt: askContext(taskId, history),
    model,
    effort: effortFor("ask"),
    cwd: workspaceForTask(taskId),
    additionalDirectories: [taskDir(taskId)],
    settingSources: [],
    settings: {
      permissions: {
        allow: READ_TOOLS,
        ask: [],
        deny: [
          "Bash",
          "Edit",
          "Write",
          "NotebookEdit",
          "WebFetch",
          "WebSearch",
          "Task",
          "TodoWrite",
          "mcp__*",
          ...DENY_ALWAYS,
        ],
      },
    },
    allowedTools: READ_TOOLS,
    disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite", "mcp__*", ...ARTIFACT_TOOLS],
    permissionMode: "default",
    canUseTool: denyTool,
    includePartialMessages: true,
    // Inti "incognito": tidak ada transcript yang ditulis ke ~/.claude.
    persistSession: false,
    env: claudeEnv(),
  };
}

type Listener = (event: AskEvent) => void;

/** Sesi tanya satu mesin. Ganti mesin di tengah percakapan = tutup sesi lama, mulai baru dengan riwayat panel. */
interface EngineAskSession {
  readonly engine: EngineId;
  ask(text: string, model: string | undefined, history: AskMessage[]): Promise<AskMessage>;
  close(): void | Promise<void>;
}

/**
 * Satu sesi tanya-jawab per tugas, hidup di memori.
 * Terpisah total dari TaskRunner: tidak memakai bus/transcript tugas, tidak
 * menulis ke task.json selain biaya, dan tidak pernah memunculkan kartu persetujuan.
 */
type Answer = { text: string; costUsd?: number };

export class AskSession implements EngineAskSession {
  readonly engine = "claude" as const;
  private q?: Query;
  private pending?: string;
  private wake?: () => void;
  private generation = 0;
  private closed = false;
  private model?: string;
  private idleTimer?: NodeJS.Timeout;
  /** Jawaban yang sedang ditunggu; diselesaikan oleh consume() saat event result datang. */
  private inflight?: { resolve: (answer: Answer) => void; reject: (error: Error) => void; text: string };

  constructor(
    private readonly taskId: string,
    private readonly emit: Listener,
  ) {}

  private async *input(): AsyncGenerator<SDKUserMessage> {
    const generation = this.generation;
    while (!this.closed && generation === this.generation) {
      if (this.pending === undefined) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            if (this.wake === wake) this.wake = undefined;
            resolve();
          };
          this.wake = wake;
        });
        continue;
      }
      const text = this.pending;
      this.pending = undefined;
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
  }

  private start(model: string, history: AskMessage[]): Query {
    this.generation += 1;
    this.wake?.();
    this.model = model;
    const instance = query({ prompt: this.input(), options: askOptions(this.taskId, model, history) });
    this.q = instance;
    // Konsumer berumur panjang: keluar dari for-await akan menutup aliran, dan
    // pertanyaan berikutnya jatuh ke sesi yang sudah mati.
    void this.consume(instance);
    return instance;
  }

  private async consume(instance: Query): Promise<void> {
    let answer = "";
    // `total_cost_usd` kumulatif per sesi; persistSession:false → tiap instance mulai dari 0.
    let mark = 0;
    let failure: Error | undefined;
    try {
      for await (const message of instance) {
        // Sesi yang sudah ditutup: delta dan jawabannya bukan milik pertanyaan yang sekarang.
        if (this.q !== instance) continue;
        if (message.type === "stream_event") {
          const event = message.event as { type: string; delta?: { type?: string; text?: string } };
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            this.emit({ type: "delta", text: event.delta.text });
          }
          continue;
        }
        if (message.type === "assistant") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content as unknown as Array<Record<string, unknown>>) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) answer = block.text;
            }
          }
          continue;
        }
        if (message.type === "result") {
          const result = message as unknown as Record<string, unknown>;
          const total = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined;
          let costUsd: number | undefined;
          if (total !== undefined && total > 0) {
            costUsd = Number((total >= mark ? total - mark : total).toFixed(6));
            mark = total;
            if (costUsd > 0) addAskCost(this.taskId, costUsd);
          }
          this.inflight?.resolve({ text: answer, costUsd });
          this.inflight = undefined;
          answer = "";
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    // Instance lama (sudah diganti setelah idle/stop) tidak boleh menggagalkan pertanyaan sesi baru.
    if (this.q !== instance) return;
    this.q = undefined;
    this.inflight?.reject(failure ?? new Error("sesi tanya berakhir sebelum jawaban selesai"));
    this.inflight = undefined;
  }

  /** Satu pertanyaan → satu jawaban. Pemanggil menjaga agar tidak ada dua sekaligus. */
  async ask(text: string, requested: string | undefined, history: AskMessage[]): Promise<AskMessage> {
    const model = requested ?? modelFor("ask", "claude") ?? CONFIG.models.ask;
    this.clearIdle();
    if (!this.q) this.start(model, history);
    else if (model !== this.model) {
      await this.q.setModel(model).catch(() => undefined);
      this.model = model;
    }

    // CLI yang macet tidak boleh mengunci panel ini selamanya (state.busy).
    const timer = setTimeout(() => {
      const inflight = this.inflight;
      this.inflight = undefined;
      inflight?.reject(
        new Error(`Jawaban melewati ${Math.round(CONFIG.askTimeoutMs / 60_000)} menit — sesi tanya dihentikan.`),
      );
      this.stop();
    }, CONFIG.askTimeoutMs);
    timer.unref();
    let answer: Answer;
    try {
      answer = await new Promise<Answer>((resolve, reject) => {
        this.inflight = { resolve, reject, text };
        this.pending = text;
        this.wake?.();
      });
    } finally {
      clearTimeout(timer);
    }

    this.startIdle();
    return {
      role: "assistant",
      text: answer.text || "(tidak ada jawaban)",
      engine: "claude",
      model,
      costUsd: answer.costUsd,
      ts: new Date().toISOString(),
    };
  }

  private startIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.stop(), CONFIG.idleShutdownMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Tutup subprocess; pertanyaan berikutnya memulai sesi baru yang di-seed riwayat panel. */
  stop(): void {
    this.clearIdle();
    this.generation += 1;
    this.wake?.();
    const instance = this.q;
    this.q = undefined;
    try {
      instance?.close();
    } catch {
      // proses mungkin sudah mati
    }
    // Sesi yang ditutup tidak akan menjawab lagi; pertanyaan yang berjalan jangan dibiarkan menggantung.
    const inflight = this.inflight;
    this.inflight = undefined;
    inflight?.reject(new Error("sesi tanya ditutup"));
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}

/** Uji menyuntik agen ACP palsu; server memakai `agy` dan keyring akun Gemini app. */
export type GeminiDeps = Pick<ChatOptions, "launch" | "accountEnv">;

/**
 * Padanan `AskSession` di Gemini: satu sesi `agy` hanya-baca per tugas, percakapan berlanjut di sesi itu.
 * Ditutup saat menganggur, saat jawaban melewati batas waktu, atau saat gagal; pertanyaan berikutnya
 * memulai sesi baru yang di-seed riwayat panel. agy tidak melaporkan biaya.
 */
export class GeminiAskSession implements EngineAskSession {
  readonly engine = "antigravity" as const;
  private chat?: AgyChat;
  private abort?: AbortController;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly taskId: string,
    private readonly emit: Listener,
    private readonly deps: GeminiDeps = {},
  ) {}

  async ask(text: string, model: string | undefined, history: AskMessage[]): Promise<AskMessage> {
    this.clearIdle();
    if (this.chat?.ended) await this.stop();
    if (!this.chat) {
      this.chat = new AgyChat({
        ...this.deps,
        cwd: workspaceForTask(this.taskId),
        additionalDirectories: [taskDir(this.taskId)],
        areaDir: taskDir(this.taskId),
        systemPrompt: askContext(this.taskId, history),
        model,
        effort: effortFor("ask"),
        onText: (delta) => this.emit({ type: "delta", text: delta }),
      });
    } else {
      await this.chat.setModel(model);
    }
    const chat = this.chat;

    // CLI yang macet tidak boleh mengunci panel ini selamanya (state.busy).
    const abort = new AbortController();
    this.abort = abort;
    const timer = setTimeout(
      () => abort.abort(new Error(`Jawaban melewati ${Math.round(CONFIG.askTimeoutMs / 60_000)} menit — sesi tanya dihentikan.`)),
      CONFIG.askTimeoutMs,
    );
    timer.unref();
    try {
      const reply = await chat.prompt(text, abort.signal);
      if (reply.stopReason !== "end_turn" && !reply.text) throw new Error(`Gemini berhenti sebelum menjawab (${reply.stopReason}).`);
      this.startIdle();
      return {
        role: "assistant",
        text: reply.text || "(tidak ada jawaban)",
        engine: "antigravity",
        model: reply.model ?? model,
        ts: new Date().toISOString(),
      };
    } catch (error) {
      if (this.chat === chat) await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private startIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.stop(), CONFIG.idleShutdownMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Tutup proses agy; pertanyaan yang berjalan ditolak. */
  async stop(): Promise<void> {
    this.clearIdle();
    this.abort?.abort(new Error("sesi tanya ditutup"));
    this.abort = undefined;
    const chat = this.chat;
    this.chat = undefined;
    await chat?.close();
  }

  close(): Promise<void> {
    return this.stop();
  }
}

export class AskHub {
  private readonly states = new Map<string, AskState>();
  private readonly sessions = new Map<string, EngineAskSession>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly gemini: GeminiDeps = {}) {}

  state(taskId: string): AskState {
    return this.states.get(taskId) ?? { messages: [], busy: false, costUsd: 0 };
  }

  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  private emit(taskId: string, event: AskEvent): void {
    for (const listener of this.listeners.get(taskId) ?? []) {
      try {
        listener(event);
      } catch {
        // satu penyimak yang error tidak boleh menjatuhkan sesi
      }
    }
  }

  async ask(taskId: string, text: string, choice: AskChoice): Promise<AskMessage> {
    if (!getTask(taskId)) throw new Error("tugas tidak ditemukan");
    const state = this.states.get(taskId) ?? { messages: [], busy: false, costUsd: 0 };
    this.states.set(taskId, state);
    if (state.busy) throw new Error("masih menjawab pertanyaan sebelumnya");

    const history = [...state.messages];
    state.messages.push({ role: "user", text, ts: new Date().toISOString() });
    state.busy = true;
    this.emit(taskId, { type: "busy", busy: true });

    let session = this.sessions.get(taskId);
    if (session && session.engine !== choice.engine) {
      // Ganti mesin: sesi baru di mesin lain menerima riwayat panel lewat system prompt.
      void session.close();
      session = undefined;
    }
    if (!session) {
      const emit = (event: AskEvent) => this.emit(taskId, event);
      session = choice.engine === "claude" ? new AskSession(taskId, emit) : new GeminiAskSession(taskId, emit, this.gemini);
      this.sessions.set(taskId, session);
    }

    try {
      const answer = await session.ask(text, choice.model, history);
      state.messages.push(answer);
      state.costUsd = Number((state.costUsd + (answer.costUsd ?? 0)).toFixed(6));
      this.emit(taskId, { type: "answer", message: answer });
      return answer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(taskId, { type: "error", message });
      throw error;
    } finally {
      state.busy = false;
      this.emit(taskId, { type: "busy", busy: false });
    }
  }

  clear(taskId: string): void {
    void this.sessions.get(taskId)?.close();
    this.sessions.delete(taskId);
    this.states.delete(taskId);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.states.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}

export const askHub = new AskHub();
