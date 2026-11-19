import * as acp from "@agentclientprotocol/sdk";
import { BrowserSession, closeBrowserFor, createBrowserServer } from "../../browser/mcp.ts";
import { control } from "../../browser/control.ts";
import { CONFIG, agentEnv } from "../../config.ts";
import { contextBlock, workspaceForTask } from "../../context.ts";
import { localBaseUrl, registerMcpEndpoint, type McpEndpoint } from "../../mcp-http.ts";
import { ROLES } from "../../roles.ts";
import { taskDir } from "../../tasks.ts";
import { createTeamServer } from "../../team/mcp.ts";
import type { AskQuestion, AutonomyMode, RoleId, UiEvent, WorkerStatus } from "../../types.ts";
import { bus } from "../../agent/bus.ts";
import { commandVerdict } from "../../agent/guard.ts";
import type { AgentRunner } from "../../agent/runner-api.ts";
import type { ApprovalDecision, RunnerHooks } from "../../agent/runner.ts";
import { AcpEventMapper } from "./events.ts";
import { HOOK_PATH, registerHookHandler, type HookAnswer, type HookPayload } from "./hooks.ts";
import { decideTool } from "./permissions.ts";
import { spawnAgy, type AgyProcess, type Launcher } from "./process.ts";
import { toAskQuestions, uiTool } from "./tools.ts";

const MODE_LABEL: Record<AutonomyMode, string> = { auto: "Auto", ask: "Minta approval", readonly: "Hanya baca" };

/** Effort role (Claude) → `thought_level` agy. */
const THOUGHT_LEVEL: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/**
 * Catatan untuk persona yang ditulis dengan nama tool Claude Code. Persona tidak disalin per mesin:
 * cukup padanan nama di sini.
 */
const ENGINE_NOTES = `

# Catatan mesin (Antigravity)
Anda berjalan di Antigravity CLI, bukan Claude Code. Padanan nama tool yang disebut di atas:
- AskUserQuestion → \`ask_question\`. Setelah memanggilnya, akhiri giliran; jawaban owner datang di pesan berikutnya.
- \`mcp__team__<tool>\` → \`mcp_team_<tool>\`, \`mcp__browser__<tool>\` → \`mcp_browser_<tool>\`.
- Bash → \`run_command\`; Read/Edit/Write → \`read_file\`/\`edit_file\`/\`write_file\`.
Aturan AI Team untuk mesin ini:
- Jangan memakai subagen, swarm, workflow, schedule, atau browser bawaan Antigravity — semuanya ditolak. Kerjakan langsung di sesi ini.
- Setiap tool dinilai pagar AI Team sebelum berjalan. Kalau ditolak, baca alasannya dan sesuaikan rencana; jangan mencari jalan memutar.
`;

type PendingRequest = { kind: "approval" | "question"; event: UiEvent; resolve: (value: unknown) => void };

type Turn = {
  stopped: boolean;
  /** `session/prompt` sedang berjalan di agy. */
  prompting: boolean;
  startedAt: number;
  prompts: number;
  tokens: number;
};

type LiveProcess = AgyProcess & { mcp: McpEndpoint };

type ConfigSelect = { id: string; category?: string; currentValue?: unknown; options?: unknown[] };

function configValues(option: ConfigSelect): string[] {
  const values: string[] = [];
  for (const item of option.options ?? []) {
    const record = item as Record<string, unknown>;
    if (typeof record.value === "string") values.push(record.value);
    if (Array.isArray(record.options)) values.push(...configValues({ id: "", options: record.options }));
  }
  return values;
}

function describeRequest(event: UiEvent): string | undefined {
  if (event.type === "approval") {
    const input = event.input as Record<string, unknown> | null;
    const command = input && typeof input.command === "string" ? input.command : undefined;
    const file = input && typeof input.file_path === "string" ? input.file_path : undefined;
    return (command ?? file ?? event.toolName).slice(0, 180);
  }
  if (event.type === "question") return event.questions[0]?.question.slice(0, 180);
  return undefined;
}

/** Jawaban kartu pertanyaan → pesan untuk agen. */
function answerText(questions: AskQuestion[], answers: Record<string, string>): string {
  const lines = questions.map((item) => `- ${item.question} → ${answers[item.question]?.trim() || "(tidak dijawab)"}`);
  return `Jawaban owner atas pertanyaanmu:\n${lines.join("\n")}`;
}

/**
 * Runner mesin Antigravity: satu proses `agy acp` per runner, satu sesi ACP per penugasan.
 * Perilaku luarnya sama dengan `TaskRunner`: status, slot & kunci workspace, kartu persetujuan dan
 * pertanyaan, Stop, idle shutdown, dan resume dari sessionId.
 */
export class AcpTaskRunner implements AgentRunner {
  readonly engine = "antigravity" as const;
  status: WorkerStatus = "idle";
  sessionId?: string;

  private proc?: LiveProcess;
  private starting?: Promise<boolean>;
  /** cwd sesi agy yang hidup — folder inilah yang dikunci, walau tugas dipindah project. */
  private sessionDir?: string;
  /** `session/load` sedang memutar ulang riwayat: update-nya bukan kejadian baru. */
  private loading = false;
  private readonly inbox: string[] = [];
  private busy = false;
  private closed = false;
  private release?: () => void;
  private lockRelease?: () => void;
  private slotEpoch = 0;
  private reacquiring?: Promise<void>;
  private turn?: Turn;
  /** Pertanyaan `ask_question` yang menunggu owner; jawabannya menjadi prompt berikutnya di turn yang sama. */
  private question?: { id: string; toolCallId: string; questions: AskQuestion[]; answer?: string };
  private answerWaiter?: (text: string | undefined) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancelled = new Set<string>();
  /** Keputusan hook per toolCallId — `session/request_permission` dijawab dari sini. */
  private readonly decisions = new Map<string, "allow" | "deny">();
  /** Alasan tolak per toolCallId, untuk isi hasil tool (agy tidak mengirim pesan error-nya). */
  private readonly denyReasons = new Map<string, string>();
  private readonly mapper: AcpEventMapper;
  private backgroundTurn = false;
  private backgroundStarted = 0;
  private backgroundTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private stopGrace?: NodeJS.Timeout;
  private browser?: BrowserSession;
  private readonly hook: { token: string; revoke: () => void };
  private currentModel?: string;

  constructor(
    readonly taskId: string,
    readonly role: RoleId,
    private readonly hooks: RunnerHooks,
    sessionId: string | undefined,
    private mode: AutonomyMode = "ask",
    private readonly model?: string,
    private readonly launch: Launcher = spawnAgy,
  ) {
    this.sessionId = sessionId;
    this.mapper = new AcpEventMapper((event) => this.emit(event), {
      onQuestion: (toolCallId, args) => this.openQuestion(toolCallId, args),
      failureReason: (toolCallId) => {
        const reason = this.denyReasons.get(toolCallId);
        this.denyReasons.delete(toolCallId);
        return reason ?? (this.turn?.stopped ? "Dihentikan owner." : undefined);
      },
    });
    this.hook = registerHookHandler((payload) => this.onHook(payload));
  }

  get autonomyMode(): AutonomyMode {
    return this.mode;
  }

  /** Mode dinilai hook di setiap tool call, jadi perubahan berlaku seketika tanpa menyentuh agy. */
  async setMode(mode: AutonomyMode): Promise<void> {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit({ type: "notice", text: `Mode tugas diubah ke ${MODE_LABEL[mode]}.` });
  }

  // ---------- event ----------

  private emit(event: UiEvent): void {
    bus.emit(this.taskId, this.role, event);
  }

  private setStatus(status: WorkerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: "status", status });
    this.hooks.onStatus(this.taskId, status);
  }

  openRequests(): UiEvent[] {
    return [...this.pending.values()].map((request) => request.event);
  }

  // ---------- masukan ----------

  send(text: string, options?: { display?: string; from?: "owner" | "system" }): void {
    if (this.closed) throw new Error("runner sudah ditutup");
    const from = options?.from ?? "owner";
    this.emit({ type: "user", text: options?.display ?? text, from });
    // agy menunggu jawaban pertanyaannya di pesan berikutnya: chat owner saat kartu terbuka adalah jawabannya.
    const question = this.question;
    if (from === "owner" && question && question.answer === undefined && this.pending.has(question.id)) {
      const event = this.pending.get(question.id)?.event;
      this.pending.delete(question.id);
      const first = question.questions[0]?.question ?? "pertanyaan";
      if (event?.type === "question") {
        this.emit({ type: "question_resolved", questionId: question.id, answers: { [first]: text } });
      }
      this.deliverAnswer(`Jawaban owner atas pertanyaanmu ("${first}"):\n${text}`);
      return;
    }
    this.inbox.push(text);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.turn || this.closed || this.inbox.length === 0) return;
    this.busy = true;
    this.clearIdleTimer();
    const epoch = this.slotEpoch;

    const dir = (this.proc && this.sessionDir) || workspaceForTask(this.taskId);
    const lock = await this.hooks.lockWorkspace?.(this.role, dir);
    if (epoch !== this.slotEpoch) {
      lock?.();
      return;
    }
    if (lock) this.holdLock(lock);
    const slot = await this.hooks.acquire(this.role);
    if (epoch !== this.slotEpoch) {
      slot();
      return;
    }
    this.holdSlot(slot);

    if (!this.proc && !this.closed && workspaceForTask(this.taskId) !== dir) {
      this.freeSlot();
      this.freeLock();
      this.busy = false;
      void this.pump();
      return;
    }

    const text = this.inbox.shift();
    if (this.closed || text === undefined) {
      this.freeSlot();
      this.freeLock();
      this.busy = false;
      return;
    }

    // Agen sedang menindaklanjuti sesuatu sendiri: tutup laporannya, pesan kita yang berikutnya.
    this.endBackground(false, true);
    const turn: Turn = { stopped: false, prompting: false, startedAt: Date.now(), prompts: 0, tokens: 0 };
    this.turn = turn;
    this.mapper.resetTurn();
    this.setStatus("starting");
    const ready = await this.ensureSession();
    if (this.turn !== turn) return;
    if (!ready) {
      this.completeTurn(turn, "error_during_execution", true);
      return;
    }
    this.setStatus("working");
    void this.runTurn(turn, text);
  }

  /**
   * Satu turn = satu atau beberapa `session/prompt`: `ask_question` mengakhiri prompt agy, dan jawaban
   * owner dikirim sebagai prompt berikutnya tanpa menutup turn (sama seperti AskUserQuestion di Claude).
   */
  private async runTurn(turn: Turn, first: string): Promise<void> {
    let next: string | undefined = first;
    while (next !== undefined) {
      const proc = this.proc;
      const sessionId = this.sessionId;
      if (this.turn !== turn || this.closed) return;
      if (!proc || !sessionId) {
        // Proses mati saat menunggu jawaban: mulai lagi, sesi dimuat dari sessionId.
        this.setStatus("starting");
        if (!(await this.ensureSession()) || this.turn !== turn) {
          if (this.turn === turn) this.completeTurn(turn, "error_during_execution", true);
          return;
        }
        this.setStatus("working");
        continue;
      }
      turn.prompting = true;
      turn.prompts += 1;
      let response: acp.PromptResponse | undefined;
      let failure: string | undefined;
      try {
        response = await proc.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: next }],
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      turn.prompting = false;
      if (this.turn !== turn) return;
      this.mapper.flush();
      const usage = (response as { usage?: { totalTokens?: unknown } } | undefined)?.usage;
      if (typeof usage?.totalTokens === "number") turn.tokens += usage.totalTokens;

      if (turn.stopped || response?.stopReason === "cancelled") {
        this.completeTurn(turn, "interrupted", false, true);
        return;
      }
      if (failure !== undefined) {
        const stderr = proc.stderrTail();
        this.emit({ type: "error", message: `Antigravity berhenti di tengah turn: ${failure}${stderr ? `\n${stderr.slice(-600)}` : ""}` });
        this.setStatus("error");
        this.completeTurn(turn, "error_during_execution", true);
        return;
      }
      if (this.question) {
        next = await this.awaitAnswer(turn);
        continue;
      }
      const reason = response?.stopReason ?? "end_turn";
      if (reason === "end_turn") this.completeTurn(turn, "success", false);
      else if (reason === "max_tokens" || reason === "max_turn_requests") this.completeTurn(turn, "error_max_turns", true);
      else this.completeTurn(turn, `error_${reason}`, true);
      return;
    }
  }

  private freeSlot(): void {
    this.release?.();
    this.release = undefined;
  }

  private holdSlot(release: () => void): void {
    this.freeSlot();
    this.release = release;
  }

  private freeLock(): void {
    this.lockRelease?.();
    this.lockRelease = undefined;
  }

  private holdLock(release: () => void): void {
    this.freeLock();
    this.lockRelease = release;
  }

  private invalidateSlotClaims(): void {
    this.slotEpoch += 1;
    this.reacquiring = undefined;
  }

  // ---------- sesi ----------

  private ensureSession(): Promise<boolean> {
    if (this.proc && this.sessionId) return Promise.resolve(true);
    this.starting ??= this.startSession().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private systemPrompt(): string {
    return `${ROLES[this.role].persona}${contextBlock(this.taskId)}${ENGINE_NOTES}`;
  }

  private mcpFactories(): Parameters<typeof registerMcpEndpoint>[0] {
    const factories: Parameters<typeof registerMcpEndpoint>[0] = {
      team: () => createTeamServer(this.taskId, this.role).instance,
    };
    if (ROLES[this.role].usesBrowser) {
      this.browser ??= new BrowserSession(() => this.taskId);
      const browser = this.browser;
      factories.browser = () => createBrowserServer(browser, () => this.taskId).instance;
    }
    return factories;
  }

  private buildApp(): acp.ClientApp {
    return acp
      .client({ name: "ai-team" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.onPermission(params))
      .onNotification(acp.methods.client.session.update, ({ params }) => this.onUpdate(params));
  }

  private async startSession(): Promise<boolean> {
    if (this.closed) return false;
    // Proses tanpa sesi (session/new gagal sebelumnya) tidak boleh ditinggal hidup di samping yang baru.
    if (this.proc) await this.stopProcess();
    const cwd = workspaceForTask(this.taskId);
    const mcp = registerMcpEndpoint(this.mcpFactories());
    const env = {
      ...agentEnv(),
      AI_TEAM_HOOK_URL: `${localBaseUrl()}${HOOK_PATH}`,
      AI_TEAM_HOOK_TOKEN: this.hook.token,
    };
    let proc: LiveProcess;
    try {
      proc = { ...this.launch({ cwd, env, app: this.buildApp() }), mcp };
    } catch (error) {
      await mcp.revoke();
      this.emit({ type: "error", message: `Antigravity CLI tidak bisa dijalankan: ${(error as Error).message}` });
      this.setStatus("error");
      return false;
    }
    this.proc = proc;
    this.sessionDir = cwd;
    void proc.exited.then(() => this.onProcessExit(proc));

    try {
      const agent = proc.connection.agent;
      await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ai-team", version: "0.1.0" },
      });
      const request: acp.NewSessionRequest = {
        cwd,
        additionalDirectories: [CONFIG.tasksDir],
        mcpServers: mcp.servers.map((server) => ({
          type: "http" as const,
          name: server.name,
          url: server.url,
          headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }],
        })),
        _meta: { antigravity: { systemPrompt: { append: this.systemPrompt() } } },
      };

      let configOptions: unknown;
      let resumed = false;
      if (this.sessionId) {
        this.loading = true;
        try {
          const loaded = await agent.request(acp.methods.agent.session.load, { ...request, sessionId: this.sessionId });
          configOptions = (loaded as { configOptions?: unknown }).configOptions;
          resumed = true;
        } catch (error) {
          this.emit({
            type: "notice",
            text: `Sesi Antigravity sebelumnya tidak bisa dimuat (${(error as Error).message}) — memulai sesi baru.`,
          });
        } finally {
          this.loading = false;
        }
      }
      if (!resumed) {
        const created = await agent.request(acp.methods.agent.session.new, request);
        this.sessionId = created.sessionId;
        this.hooks.onSession(this.taskId, created.sessionId);
        configOptions = created.configOptions;
      }
      if (this.proc !== proc) return false;
      await this.applyConfig(proc, configOptions);
      this.emit({
        type: "init",
        sessionId: this.sessionId as string,
        model: this.currentModel ?? this.model ?? "bawaan agy",
        permissionMode: MODE_LABEL[this.mode],
        apiKeySource: "Akun Google (Antigravity)",
        toolCount: 0,
        mcpServers: mcp.servers.map((server) => ({ name: server.name, status: "connected" })),
        engine: "antigravity",
      });
      return true;
    } catch (error) {
      if (this.proc === proc) {
        const stderr = proc.stderrTail();
        this.emit({
          type: "error",
          message: `Antigravity gagal memulai sesi: ${(error as Error).message}${stderr ? `\n${stderr.slice(-600)}` : ""}`,
        });
        this.setStatus("error");
        await this.stopProcess();
      }
      return false;
    }
  }

  /** Model dan thinking level per penugasan, dari `configOptions` sesi (bukan flag CLI). */
  private async applyConfig(proc: LiveProcess, raw: unknown): Promise<void> {
    const options = (Array.isArray(raw) ? raw : []) as ConfigSelect[];
    const sessionId = this.sessionId as string;
    const set = (configId: string, value: string) =>
      proc.connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });

    const model = options.find((option) => option.id === "model" || option.category === "model");
    this.currentModel = typeof model?.currentValue === "string" ? model.currentValue : undefined;
    if (model && this.model && this.model !== this.currentModel) {
      if (configValues(model).includes(this.model)) {
        await set(model.id, this.model).then(
          () => {
            this.currentModel = this.model;
          },
          (error: Error) => this.emit({ type: "notice", text: `Model ${this.model} tidak bisa dipasang: ${error.message}` }),
        );
      } else {
        this.emit({
          type: "notice",
          text: `Model ${this.model} tidak tersedia di akun Antigravity ini — memakai ${this.currentModel ?? "model bawaan"}.`,
        });
      }
    }

    const thought = options.find((option) => option.id === "thought_level" || option.category === "thought_level");
    const level = THOUGHT_LEVEL[ROLES[this.role].effort] ?? "high";
    if (thought && thought.currentValue !== level && configValues(thought).includes(level)) {
      await set(thought.id, level).catch(() => undefined);
    }
  }

  private onProcessExit(proc: LiveProcess): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    this.sessionDir = undefined;
    this.decisions.clear();
    void proc.mcp.revoke();
    // Hook yang tertahan tidak punya penerima lagi.
    for (const [id, request] of [...this.pending]) if (request.kind === "approval") this.cancelRequest(id, "Sesi Antigravity berakhir sebelum keputusan diambil.");
    if (this.backgroundTurn) this.endBackground(false);
    // Turn yang sedang prompt diselesaikan oleh request yang gagal; yang menunggu jawaban memulai proses baru.
  }

  // ---------- ACP: izin & update ----------

  private onPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const id = params.toolCall.toolCallId;
    const decision = this.decisions.get(id);
    this.decisions.delete(id);
    const pick = (kinds: string[]) => params.options.find((option) => kinds.includes(option.kind));
    if (decision === "allow") {
      const option = pick(["allow_once"]) ?? pick(["allow_always"]);
      if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
    }
    if (decision === undefined) {
      this.emit({
        type: "notice",
        text: `agy meminta izin untuk tool yang tidak lewat pagar AI Team (${params.toolCall.title ?? id}) — ditolak.`,
      });
    }
    const option = pick(["reject_once"]) ?? pick(["reject_always"]);
    return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
  }

  private onUpdate(params: acp.SessionNotification): void {
    if (this.loading || this.closed) return;
    if (this.sessionId && params.sessionId !== this.sessionId) return;
    const update = params.update as unknown as Record<string, unknown>;
    // Tool baca/tulis tidak pernah meminta izin lewat ACP: keputusannya dibuang begitu tool selesai.
    if ((update.status === "completed" || update.status === "failed") && typeof update.toolCallId === "string") {
      this.decisions.delete(update.toolCallId);
    }
    const active = this.mapper.update(update);
    if (active && !this.turn && !this.busy) this.noteBackground();
    if (this.backgroundTurn) this.armBackgroundQuiet();
  }

  // ---------- turn latar (dimulai agy sendiri) ----------

  private noteBackground(): void {
    if (this.backgroundTurn || this.turn || this.busy) return;
    this.backgroundTurn = true;
    this.backgroundStarted = Date.now();
    this.clearIdleTimer();
    this.mapper.resetTurn();
    this.setStatus("working");
  }

  private armBackgroundQuiet(): void {
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined;
      if (this.mapper.running.size > 0 || this.pending.size > 0) {
        this.armBackgroundQuiet();
        return;
      }
      this.endBackground(false);
    }, CONFIG.antigravity.backgroundQuietMs);
    this.backgroundTimer.unref();
  }

  /** `beforeOwnTurn`: pesan kita langsung menyusul, jadi status tugas tidak perlu berubah. */
  private endBackground(interrupted: boolean, beforeOwnTurn = false): void {
    if (!this.backgroundTurn) return;
    this.backgroundTurn = false;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    this.mapper.flush();
    this.emit({
      type: "result",
      subtype: interrupted ? "interrupted" : "success",
      isError: false,
      durationMs: Date.now() - this.backgroundStarted,
      numTurns: 1,
      background: true,
      ...(interrupted ? { interrupted: true } : {}),
    });
    this.hooks.onTurnEnd(this.taskId, {
      subtype: interrupted ? "interrupted" : "success",
      isError: false,
      interrupted,
      background: true,
      followUp: beforeOwnTurn || this.inbox.length > 0,
      lastText: this.mapper.lastText,
    });
    if (beforeOwnTurn || this.busy || this.turn) return;
    if (this.status !== "error") this.setStatus("idle");
    if (this.inbox.length > 0) void this.pump();
    else this.startIdleTimer();
  }

  // ---------- akhir turn ----------

  private completeTurn(turn: Turn, subtype: string, isError: boolean, interrupted = false): void {
    if (this.turn !== turn) return;
    this.mapper.flush();
    this.mapper.closeAllTools(interrupted ? "Dihentikan owner." : "Turn berakhir sebelum tool selesai.");
    this.emit({
      type: "result",
      subtype,
      isError,
      durationMs: Date.now() - turn.startedAt,
      numTurns: Math.max(1, turn.prompts),
      ...(turn.tokens > 0 ? { tokens: turn.tokens } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    });
    if (this.mapper.usage) this.hooks.onContext(this.taskId, this.mapper.usage);
    this.finishTurn(subtype, isError, interrupted);
  }

  private finishTurn(subtype: string, isError: boolean, interrupted: boolean): void {
    this.turn = undefined;
    this.question = undefined;
    this.clearStopGrace();
    this.invalidateSlotClaims();
    this.freeSlot();
    this.freeLock();
    this.busy = false;
    if (this.status !== "error") this.setStatus("idle");
    const followUp = this.inbox.length > 0;
    this.hooks.onTurnEnd(this.taskId, { subtype, isError, interrupted, followUp, lastText: this.mapper.lastText });
    if (followUp) void this.pump();
    else this.startIdleTimer();
  }

  // ---------- pertanyaan (ask_question) ----------

  private openQuestion(toolCallId: string, args: Record<string, unknown>): void {
    const questions = toAskQuestions(args.questions);
    if (questions.length === 0) return;
    const id = toolCallId;
    const event: UiEvent = { type: "question", questionId: id, questions };
    this.question = { id, toolCallId, questions };
    this.emit(event);
    this.pending.set(id, {
      kind: "question",
      event,
      resolve: (value) => {
        const answers = (value && typeof value === "object" ? value : {}) as Record<string, string>;
        this.emit({ type: "question_resolved", questionId: id, answers });
        this.deliverAnswer(answerText(questions, answers));
      },
    });
    bus.publishAttention({
      kind: "question",
      taskId: this.taskId,
      role: this.role,
      title: `${ROLES[this.role].title} bertanya`,
      detail: describeRequest(event),
      at: new Date().toISOString(),
    });
  }

  /** Jawaban owner: lanjutan turn yang menunggu, atau turn baru kalau pertanyaannya dari turn latar. */
  private deliverAnswer(text: string): void {
    const question = this.question;
    if (question) {
      question.answer = text;
      this.mapper.closeTool(question.toolCallId, text);
    }
    const waiter = this.answerWaiter;
    if (waiter) {
      this.answerWaiter = undefined;
      waiter(text);
      return;
    }
    if (this.turn) return; // prompt masih berjalan; runTurn mengambil `question.answer` setelahnya
    this.question = undefined;
    this.inbox.push(text);
    void this.pump();
  }

  /** Slot dilepas selama owner berpikir; kunci workspace tetap dipegang sampai turn selesai. */
  private async awaitAnswer(turn: Turn): Promise<string | undefined> {
    const question = this.question;
    let text = question?.answer;
    if (text === undefined) {
      this.setStatus("waiting");
      this.freeSlot();
      text = await new Promise<string | undefined>((resolve) => {
        this.answerWaiter = resolve;
      });
    }
    this.question = undefined;
    if (text === undefined || this.turn !== turn || this.closed) return undefined;
    if (!(await this.reacquireSlot())) return undefined;
    if (this.turn !== turn) return undefined;
    this.setStatus("working");
    return text;
  }

  // ---------- izin (hook PreToolUse) ----------

  private async onHook(payload: HookPayload): Promise<HookAnswer> {
    const call = payload.toolCall;
    const name = typeof call?.name === "string" ? call.name : "";
    const args = call?.args && typeof call.args === "object" ? call.args : {};
    const id = typeof call?.id === "string" ? call.id : "";
    if (this.closed) return { decision: "deny", reason: "Tugas sudah ditutup." };
    if (!name) return { decision: "deny", reason: "Tool tanpa nama tidak bisa dinilai." };

    const verdict = decideTool({
      role: this.role,
      mode: this.mode,
      name,
      args,
      workspaceDir: this.sessionDir ?? workspaceForTask(this.taskId),
      taskDir: taskDir(this.taskId),
      commandVerdict: (command) => commandVerdict(this.taskId, this.role, command),
    });

    if (verdict.decision === "allow") {
      if (id) this.decisions.set(id, "allow");
      return { decision: "allow" };
    }
    if (verdict.decision === "deny") return this.deny(id, `Ditolak pagar AI Team: ${verdict.reason}`);

    const tool = uiTool(name, args);
    const approvalId = id || `hook-${Date.now()}`;
    const decision = (await this.awaitDecision(approvalId, {
      type: "approval",
      approvalId,
      toolName: tool.name,
      input: tool.input,
      title: `${ROLES[this.role].title} ingin menjalankan ${tool.name}`,
      reason: verdict.reason,
      canRemember: false,
    })) as ApprovalDecision;

    if (this.cancelled.delete(approvalId)) return this.deny(id, decision.message ?? "Dibatalkan oleh owner.");
    this.emit({ type: "approval_resolved", approvalId, decision: decision.decision, message: decision.message });
    if (!(await this.resumeAfterDecision())) return this.deny(id, "Dibatalkan oleh owner.");
    if (decision.decision === "deny") return this.deny(id, `Ditolak owner: ${decision.message?.trim() || "tanpa alasan."}`);
    if (id) this.decisions.set(id, "allow");
    return { decision: "allow" };
  }

  private deny(toolCallId: string, reason: string): HookAnswer {
    if (toolCallId) {
      this.decisions.set(toolCallId, "deny");
      this.denyReasons.set(toolCallId, reason);
    }
    return { decision: "deny", reason };
  }

  private async awaitDecision(id: string, event: UiEvent): Promise<unknown> {
    this.setStatus("waiting");
    this.emit(event);
    bus.publishAttention({
      kind: "approval",
      taskId: this.taskId,
      role: this.role,
      title: `${ROLES[this.role].title} butuh persetujuan`,
      detail: describeRequest(event),
      at: new Date().toISOString(),
    });
    this.freeSlot();
    return new Promise<unknown>((resolve) => {
      this.pending.set(id, { kind: "approval", event, resolve });
    });
  }

  /** Ambil lagi slot setelah keputusan; false kalau turn-nya dihentikan selama mengantre. */
  private async resumeAfterDecision(): Promise<boolean> {
    if (this.closed) return false;
    if (this.pending.size > 0) return true;
    if (!this.busy) {
      if (this.status === "waiting") this.setStatus(this.backgroundTurn ? "working" : "idle");
      return true;
    }
    if (!(await this.reacquireSlot())) return false;
    if (this.status === "starting") this.setStatus("working");
    return true;
  }

  private async reacquireSlot(): Promise<boolean> {
    const epoch = this.slotEpoch;
    if (this.status === "waiting") this.setStatus("starting");
    if (!this.release) {
      if (!this.reacquiring) {
        const attempt: Promise<void> = this.hooks.acquire(this.role).then((release) => {
          if (this.reacquiring === attempt) this.reacquiring = undefined;
          if (this.closed || epoch !== this.slotEpoch || this.pending.size > 0) release();
          else this.holdSlot(release);
        });
        this.reacquiring = attempt;
      }
      await this.reacquiring;
    }
    return !this.closed && epoch === this.slotEpoch;
  }

  private cancelPending(message: string): void {
    for (const id of [...this.pending.keys()]) this.cancelRequest(id, message);
  }

  private cancelRequest(id: string, message: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    if (request.kind === "approval") {
      // Dibaca onHook: kartu yang ditutup paksa sudah diumumkan di sini, jangan diumumkan lagi.
      this.cancelled.add(id);
      request.resolve({ decision: "deny", message } satisfies ApprovalDecision);
      this.emit({ type: "approval_resolved", approvalId: id, decision: "deny", message });
    } else {
      this.emit({ type: "question_resolved", questionId: id, answers: {} });
      if (this.question?.id === id) this.mapper.closeTool(this.question.toolCallId, message, true);
    }
  }

  resolveRequest(id: string, value: unknown): boolean {
    const request = this.pending.get(id);
    if (!request) return false;
    this.pending.delete(id);
    request.resolve(value);
    return true;
  }

  hasRequest(id: string): boolean {
    return this.pending.has(id);
  }

  // ---------- idle & kendali ----------

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed || this.turn) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.turn || this.backgroundTurn || this.inbox.length > 0 || this.pending.size > 0) return;
      if (control.isHeld(this.taskId)) {
        this.startIdleTimer();
        return;
      }
      void this.stopProcess();
      this.hooks.onIdleShutdown(this.taskId);
    }, CONFIG.idleShutdownMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Matikan proses agy (sessionId disimpan untuk resume) dan cabut token MCP-nya. */
  private async stopProcess(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.sessionDir = undefined;
    this.decisions.clear();
    this.denyReasons.clear();
    if (!proc) return;
    await proc.mcp.revoke();
    await proc.kill();
    void this.browser?.close().catch(() => undefined);
  }

  /**
   * Stop. Slot dan antrean dilepas seketika; kunci workspace baru dilepas setelah agy menjawab
   * `session/cancel` (atau ditutup paksa), karena sampai saat itu tool yang sedang jalan masih bisa
   * menulis di folder ini.
   */
  async interrupt(): Promise<void> {
    const turn = this.turn;
    const prompting = turn?.prompting === true;
    const requests = [...this.pending.keys()];
    const dropped = this.inbox.splice(0).length;
    this.invalidateSlotClaims();
    this.freeSlot();
    if (!turn) this.freeLock();
    this.busy = false;
    if (turn) turn.stopped = true;
    const proc = this.proc;
    const sessionId = this.sessionId;
    if (proc && sessionId && (prompting || this.backgroundTurn)) {
      await proc.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined);
      if (prompting && turn) this.armStopGrace(turn);
    }
    this.setStatus("idle");
    if (dropped > 0) this.emit({ type: "notice", text: `${dropped} pesan yang belum dikerjakan dibatalkan oleh Stop.` });
    // Cancel dulu baru kartu ditutup: hook yang ditolak tidak sempat membuat agen mencoba jalan lain.
    for (const id of requests) this.cancelRequest(id, "Dibatalkan oleh owner (tombol Stop).");
    const waiter = this.answerWaiter;
    this.answerWaiter = undefined;
    waiter?.(undefined);
    if (this.backgroundTurn) this.endBackground(true);
    // Belum ada prompt di agy (masih memulai sesi, atau menunggu jawaban): tidak ada yang perlu ditunggu.
    if (turn && !prompting) this.completeTurn(turn, "interrupted", false, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  private armStopGrace(turn: Turn): void {
    this.clearStopGrace();
    this.stopGrace = setTimeout(() => {
      this.stopGrace = undefined;
      if (this.turn !== turn || this.closed) return;
      this.emit({ type: "notice", text: "Sesi tidak merespons Stop — proses Antigravity ditutup paksa." });
      void this.stopProcess();
      this.completeTurn(turn, "interrupted", false, true);
    }, CONFIG.stopGraceMs);
    this.stopGrace.unref();
  }

  private clearStopGrace(): void {
    if (this.stopGrace) clearTimeout(this.stopGrace);
    this.stopGrace = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.invalidateSlotClaims();
    this.clearIdleTimer();
    this.clearStopGrace();
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTurn = false;
    this.cancelPending("Tugas ditutup.");
    const waiter = this.answerWaiter;
    this.answerWaiter = undefined;
    waiter?.(undefined);
    this.turn = undefined;
    this.question = undefined;
    this.freeSlot();
    this.freeLock();
    this.busy = false;
    this.hook.revoke();
    await this.stopProcess();
    await closeBrowserFor(this.taskId);
    await this.browser?.close().catch(() => undefined);
  }
}
