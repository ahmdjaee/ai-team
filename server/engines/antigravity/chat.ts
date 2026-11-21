import * as acp from "@agentclientprotocol/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isGeminiAuthError as isAgyAuthError } from "ai-agent-auth/gemini";
import { geminiEnv, markAccountExpired } from "../../accounts/index.ts";
import { CONFIG } from "../../config.ts";
import { localBaseUrl, registerMcpEndpoint, type McpEndpoint } from "../../mcp-http.ts";
import type { Effort } from "../../types.ts";
import { commandVerdictIn } from "../../agent/guard.ts";
import { applySessionConfig, type SetConfig } from "./config-options.ts";
import { AcpEventMapper } from "./events.ts";
import { HOOK_PATH, registerHookHandler, type HookAnswer, type HookPayload } from "./hooks.ts";
import { decideTool } from "./permissions.ts";
import { spawnAgy, type AgyProcess, type Launcher } from "./process.ts";
import { classifyTool, splitMcpName } from "./tools.ts";

/**
 * Padanan nama tool untuk persona yang ditulis dengan nama tool Claude Code (kurator, panel Tanya).
 * Ditambahkan di akhir system prompt sesi `AgyChat`.
 */
export const CHAT_ENGINE_NOTES = `

# Catatan mesin (Antigravity)
Anda berjalan di Antigravity CLI, bukan Claude Code. Padanan nama tool yang disebut di atas:
- Read → \`read_file\`; Grep/Glob → perintah baca lewat \`run_command\` (grep, rg, find, ls, cat).
- \`mcp__<server>__<tool>\` → \`mcp_<server>_<tool>\`.
Sesi ini hanya membaca. Menulis atau menyunting berkas, perintah yang mengubah sesuatu, subagen, web, dan
ask_question ditolak pagar AI Team. Kalau sebuah tool ditolak, baca alasannya dan lanjutkan dengan yang boleh.
`;

export type ChatOptions = {
  /** cwd sesi (workspace project). */
  cwd: string;
  additionalDirectories?: string[];
  /** Folder kerja tambahan untuk pagar perintah shell (folder tugas, atau folder tugas global untuk kurator). */
  areaDir: string;
  systemPrompt: string;
  /** Server MCP milik AI Team yang dipasang ke sesi ini, lewat Streamable HTTP. */
  mcp?: Record<string, () => McpServer>;
  /** Kosong = model bawaan akun agy. */
  model?: string;
  /** Kosong = thinking level bawaan agy. */
  effort?: Effort;
  /** Potongan teks jawaban yang sedang mengalir. */
  onText?: (text: string) => void;
  /** Pemberitahuan non-fatal (mis. model tidak tersedia). */
  onNotice?: (text: string) => void;
  launch?: Launcher;
  /** Env akun Gemini app (keyring pribadi); uji memakai env kosong. */
  accountEnv?: () => Promise<Record<string, string | undefined>>;
};

export type ChatReply = { text: string; stopReason: string; model?: string };

type Live = AgyProcess & { mcp?: McpEndpoint };

/**
 * Satu sesi `agy acp` hanya-baca untuk kerja tanpa tugas sendiri: kurator memori dan panel Tanya.
 * Tidak ada kartu persetujuan, slot, atau thread tugas. Setiap tool dinilai hook AI Team: baca berkas
 * dan perintah baca boleh, server MCP yang dipasang ke sesi ini boleh, sisanya (tulis, web, subagen,
 * pertanyaan ke owner, MCP lain) ditolak dengan alasannya.
 */
export class AgyChat {
  private proc?: Live;
  private sessionId?: string;
  private starting?: Promise<void>;
  private closed = false;
  private started = false;
  private prompting = false;
  private configOptions: unknown;
  /** Model bawaan sesi saat dibuat — dipakai lagi kalau pilihan model dikosongkan. */
  private initialModel?: string;
  private currentModel?: string;
  private wantedModel?: string;
  private cancelTimer?: NodeJS.Timeout;
  private readonly decisions = new Map<string, "allow" | "deny">();
  private readonly mapper: AcpEventMapper;
  private readonly hook: { token: string; revoke: () => void };
  private readonly mcpNames: Set<string>;
  private readonly launch: Launcher;
  private readonly accountEnv: () => Promise<Record<string, string | undefined>>;

  constructor(private readonly options: ChatOptions) {
    this.launch = options.launch ?? spawnAgy;
    this.accountEnv = options.accountEnv ?? geminiEnv;
    this.wantedModel = options.model;
    this.mcpNames = new Set(Object.keys(options.mcp ?? {}));
    this.mapper = new AcpEventMapper((event) => {
      if (event.type === "delta" && event.kind === "text") options.onText?.(event.text);
    });
    this.hook = registerHookHandler((payload) => Promise.resolve(this.onHook(payload)));
  }

  /** Model yang berlaku di sesi yang hidup (undefined sebelum sesi dimulai). */
  get model(): string | undefined {
    return this.currentModel ?? this.wantedModel;
  }

  /** Sesi yang sudah pernah hidup lalu berakhir (proses mati atau ditutup): riwayat percakapannya hilang. */
  get ended(): boolean {
    return this.closed || (this.started && !this.proc);
  }

  get busy(): boolean {
    return this.prompting;
  }

  // ---------- pagar ----------

  private onHook(payload: HookPayload): HookAnswer {
    const call = payload.toolCall;
    const name = typeof call?.name === "string" ? call.name : "";
    const args = call?.args && typeof call.args === "object" ? call.args : {};
    const id = typeof call?.id === "string" ? call.id : "";
    const answer = this.judge(name, args);
    if (id) this.decisions.set(id, answer.decision);
    return answer;
  }

  private judge(name: string, args: Record<string, unknown>): HookAnswer {
    if (this.closed) return { decision: "deny", reason: "Sesi sudah ditutup." };
    if (!name) return { decision: "deny", reason: "Tool tanpa nama tidak bisa dinilai." };
    const mcp = splitMcpName(name);
    if (mcp && this.mcpNames.has(mcp.server)) return { decision: "allow" };
    const deny = (reason: string): HookAnswer => ({ decision: "deny", reason: `Ditolak pagar AI Team: ${reason}` });
    const tool = classifyTool(name, args);
    switch (tool.kind) {
      case "ours":
      case "foreign_mcp":
        return deny(`server MCP "${mcp?.server ?? name}" tidak dipasang di sesi ini`);
      case "question":
        return deny("sesi ini tidak bisa bertanya ke owner — jawab dengan informasi yang ada");
      case "background":
        return deny("sesi ini tidak menjalankan perintah latar");
      case "web":
        return deny("akses web tidak tersedia di sesi ini");
    }
    const { cwd, areaDir } = this.options;
    const verdict = decideTool({
      // Role tanpa izin tulis apa pun; mode Hanya baca menolak semua tulis dan perintah yang mengubah.
      role: "qa",
      mode: "readonly",
      name,
      args,
      workspaceDir: cwd,
      taskDir: areaDir,
      commandVerdict: (command) => commandVerdictIn(cwd, areaDir, command),
    });
    if (verdict.decision === "allow") return { decision: "allow" };
    if (verdict.decision === "deny") return deny(verdict.reason);
    return deny(`${verdict.reason ? `${verdict.reason} — ` : ""}butuh persetujuan owner, yang tidak ada di sesi hanya-baca ini`);
  }

  private onPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const id = params.toolCall.toolCallId;
    const decision = this.decisions.get(id);
    this.decisions.delete(id);
    const pick = (kinds: string[]) => params.options.find((option) => kinds.includes(option.kind));
    if (decision === "allow") {
      const option = pick(["allow_once"]) ?? pick(["allow_always"]);
      if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
    }
    const option = pick(["reject_once"]) ?? pick(["reject_always"]);
    return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
  }

  private onUpdate(params: acp.SessionNotification): void {
    if (this.closed || (this.sessionId && params.sessionId !== this.sessionId)) return;
    const update = params.update as unknown as Record<string, unknown>;
    if ((update.status === "completed" || update.status === "failed") && typeof update.toolCallId === "string") {
      this.decisions.delete(update.toolCallId);
    }
    this.mapper.update(update);
  }

  // ---------- sesi ----------

  private ensureSession(): Promise<void> {
    if (this.proc && this.sessionId) return Promise.resolve();
    this.starting ??= this.startSession().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startSession(): Promise<void> {
    if (this.closed) throw new Error("sesi sudah ditutup");
    const mcp = this.mcpNames.size > 0 ? registerMcpEndpoint(this.options.mcp ?? {}) : undefined;
    let proc: Live;
    try {
      const env = {
        ...(await this.accountEnv()),
        AI_TEAM_HOOK_URL: `${localBaseUrl()}${HOOK_PATH}`,
        AI_TEAM_HOOK_TOKEN: this.hook.token,
      };
      const app = acp
        .client({ name: "ai-team" })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.onPermission(params))
        .onNotification(acp.methods.client.session.update, ({ params }) => this.onUpdate(params));
      proc = { ...this.launch({ cwd: this.options.cwd, env, app }), mcp };
    } catch (error) {
      await mcp?.revoke();
      throw new Error(`Antigravity CLI tidak bisa dijalankan: ${(error as Error).message}`);
    }
    this.proc = proc;
    void proc.exited.then(() => this.onExit(proc));
    if (this.closed) {
      await this.stopProcess();
      throw new Error("sesi sudah ditutup");
    }

    try {
      const agent = proc.connection.agent;
      await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ai-team", version: "0.1.0" },
      });
      const request: acp.NewSessionRequest = {
        cwd: this.options.cwd,
        additionalDirectories: this.options.additionalDirectories ?? [],
        mcpServers: (mcp?.servers ?? []).map((server) => ({
          type: "http" as const,
          name: server.name,
          url: server.url,
          headers: [{ name: "Authorization", value: `Bearer ${mcp?.token}` }],
        })),
        _meta: { antigravity: { systemPrompt: { append: `${this.options.systemPrompt}${CHAT_ENGINE_NOTES}` } } },
      };
      const created = await agent.request(acp.methods.agent.session.new, request);
      if (this.proc !== proc) throw new Error("sesi Antigravity berakhir saat dimulai");
      this.sessionId = created.sessionId;
      this.started = true;
      this.configOptions = created.configOptions;
      const result = await applySessionConfig(
        created.configOptions,
        { model: this.wantedModel, effort: this.options.effort },
        this.setter(proc, created.sessionId),
      );
      this.initialModel = result.model;
      this.currentModel = result.model;
      for (const text of result.notices) this.options.onNotice?.(text);
    } catch (error) {
      // Proses yang keluar karena login ditolak sudah dilepas onExit; stderr-nya tetap dibaca dari sini.
      const stderr = proc.stderrTail();
      const message = (error as Error).message;
      if (isAgyAuthError(`${message} ${stderr}`)) {
        markAccountExpired("gemini", "Antigravity menolak login akun Gemini app saat memulai sesi");
      }
      await this.stopProcess();
      throw new Error(`Antigravity gagal memulai sesi: ${message}${stderr ? `\n${stderr.slice(-600)}` : ""}`);
    }
  }

  private setter(proc: Live, sessionId: string): SetConfig {
    return (configId, value) => proc.connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
  }

  private onExit(proc: Live): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    this.sessionId = undefined;
    this.decisions.clear();
    void proc.mcp?.revoke();
  }

  private async stopProcess(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.sessionId = undefined;
    this.decisions.clear();
    if (!proc) return;
    await proc.mcp?.revoke();
    await proc.kill();
  }

  // ---------- pemakaian ----------

  /** Satu pesan → satu jawaban. Sesi dimulai saat pertama dipakai; percakapan berlanjut di prompt berikutnya. */
  async prompt(text: string, signal?: AbortSignal): Promise<ChatReply> {
    if (this.closed) throw new Error("sesi sudah ditutup");
    if (this.prompting) throw new Error("masih menjawab pesan sebelumnya");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("dibatalkan");
    this.prompting = true;
    const onAbort = () => void this.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.ensureSession();
      const proc = this.proc;
      const sessionId = this.sessionId;
      if (!proc || !sessionId) throw new Error("sesi Antigravity berakhir sebelum pesan dikirim");
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("dibatalkan");
      this.mapper.resetTurn();
      let response: acp.PromptResponse;
      try {
        // Proses yang mati di tengah jalan tidak selalu menggagalkan request: ikut tunggu proses keluar.
        response = await Promise.race([
          proc.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }),
          proc.exited.then(() => {
            throw new Error("proses agy berhenti");
          }),
        ]);
      } catch (error) {
        const stderr = proc.stderrTail();
        const message = (error as Error).message;
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("dibatalkan");
        if (isAgyAuthError(`${message} ${stderr}`)) {
          markAccountExpired("gemini", "Antigravity menolak login akun Gemini app di tengah sesi");
        }
        await this.stopProcess();
        throw new Error(`Antigravity berhenti: ${message}${stderr ? `\n${stderr.slice(-600)}` : ""}`);
      }
      this.mapper.flush();
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("dibatalkan");
      return { text: this.mapper.lastText, stopReason: response.stopReason ?? "end_turn", model: this.model };
    } finally {
      this.prompting = false;
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Ganti model untuk pesan berikutnya; kosong = model bawaan sesi. */
  async setModel(model: string | undefined): Promise<void> {
    this.wantedModel = model;
    const proc = this.proc;
    const sessionId = this.sessionId;
    if (!proc || !sessionId) return;
    const target = model ?? this.initialModel;
    if (!target || target === this.currentModel) return;
    const result = await applySessionConfig(this.configOptions, { model: target }, this.setter(proc, sessionId), this.currentModel);
    this.currentModel = result.model;
    for (const text of result.notices) this.options.onNotice?.(text);
  }

  /** Hentikan pesan yang sedang dijawab; agy yang tidak menjawab `session/cancel` ditutup paksa. */
  async cancel(): Promise<void> {
    const proc = this.proc;
    const sessionId = this.sessionId;
    if (!proc || !sessionId) {
      // Masih memulai: tidak ada yang bisa dibatalkan selain prosesnya.
      if (this.prompting) await this.stopProcess();
      return;
    }
    if (!this.prompting) return;
    await proc.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined);
    this.cancelTimer ??= setTimeout(() => {
      this.cancelTimer = undefined;
      if (this.proc === proc && this.prompting) void this.stopProcess();
    }, CONFIG.stopGraceMs);
    this.cancelTimer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
    this.hook.revoke();
    await this.stopProcess();
  }
}
