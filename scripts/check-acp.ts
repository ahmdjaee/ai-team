/**
 * Uji runner mesin Antigravity (`AcpTaskRunner`) dengan agen ACP palsu di proses yang sama.
 * Deterministik, tanpa model, tanpa `agy`, dan tanpa menyentuh data asli: bun run check:acp
 *
 * Agen palsu meniru perilaku `agy acp` 1.5 yang tercatat di spike: tool_call membawa `name`/`args`,
 * hook PreToolUse dipanggil sebelum setiap tool, `session/request_permission` hanya untuk
 * run_command dan MCP, `ask_question` mengakhiri prompt, dan `session/load` memutar ulang riwayat.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-acp-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
process.env.AGY_DIR = join(sandbox, "data-agy");
process.env.STOP_GRACE_MS = "120";
process.env.AGY_BACKGROUND_QUIET_MS = "60";
mkdirSync(process.env.WORKSPACE_DIR, { recursive: true });
mkdirSync(process.env.AGY_DIR, { recursive: true });

const { createTask, patchAssignment, getTask } = await import("../server/tasks.ts");
const { Semaphore } = await import("../server/agent/semaphore.ts");
const { bus } = await import("../server/agent/bus.ts");
const { AcpTaskRunner } = await import("../server/engines/antigravity/runner.ts");
const { startHook, waitHook } = await import("../server/engines/antigravity/hooks.ts");
const { decideTool } = await import("../server/engines/antigravity/permissions.ts");
const { CONFIG } = await import("../server/config.ts");
import type { TurnOutcome } from "../server/agent/runner.ts";
import type { HookAnswer } from "../server/engines/antigravity/hooks.ts";
import type { Launcher } from "../server/engines/antigravity/process.ts";
import type { AutonomyMode, RoleId, StoredEvent } from "../server/types.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await tick(5);
  }
  return condition();
}

// ---------- agen ACP palsu ----------

type Calls = {
  news: acp.NewSessionRequest[];
  loads: acp.LoadSessionRequest[];
  prompts: string[];
  configs: Array<{ configId: string; value: unknown }>;
  permissions: Array<{ toolCallId: string; outcome: unknown }>;
  hooks: Array<{ name: string; answer: HookAnswer | undefined }>;
  cancels: number;
  kills: number;
};

const CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-3.8-flash",
    options: [
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

function fakeAgent(): { launcher: Launcher; calls: Calls; background: (text: string) => Promise<void> } {
  const calls: Calls = { news: [], loads: [], prompts: [], configs: [], permissions: [], hooks: [], cancels: 0, kills: 0 };
  let sequence = 0;
  let cancel: (() => void) | undefined;
  let liveClient: acp.AgentContext | undefined;
  let liveSession = "";

  const launcher: Launcher = ({ env, app }) => {
    const token = env.AI_TEAM_HOOK_TOKEN ?? "";
    const update = (client: acp.AgentContext, sessionId: string, value: Record<string, unknown>) =>
      client.notify(acp.methods.client.session.update, { sessionId, update: value as never });

    /** Seperti hook-client.ts: bertanya ke server sampai ada keputusan (jeda pendek supaya `/wait` ikut teruji). */
    async function hook(sessionId: string, id: string, name: string, args: Record<string, unknown>): Promise<HookAnswer | undefined> {
      let answer = await startHook(token, { hookEventName: "PreToolUse", conversationId: sessionId, toolCall: { id, name, args } }, 15);
      while (answer && "pending" in answer) answer = await waitHook(token, answer.pending, 15);
      calls.hooks.push({ name, answer: answer as HookAnswer | undefined });
      return answer as HookAnswer | undefined;
    }

    async function tool(
      client: acp.AgentContext,
      sessionId: string,
      name: string,
      args: Record<string, unknown>,
      options: { permission?: boolean; skipHook?: boolean } = {},
    ): Promise<string> {
      const id = `call_${(sequence += 1)}`;
      const kind = name === "run_command" ? "execute" : name === "read_file" ? "read" : name.endsWith("_file") ? "edit" : "other";
      await update(client, sessionId, { sessionUpdate: "tool_call", toolCallId: id, name, args, status: "in_progress", kind, title: name, rawInput: args });
      if (!options.skipHook) {
        const answer = await hook(sessionId, id, name, args);
        if (answer?.decision !== "allow") {
          await update(client, sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, name, status: "failed", rawOutput: { error: answer?.reason ?? "tanpa hook" } });
          return "deny";
        }
      }
      if (options.permission) {
        const response = await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: id, title: name },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        calls.permissions.push({ toolCallId: id, outcome: response.outcome });
        if (response.outcome.outcome !== "selected" || response.outcome.optionId !== "allow") {
          await update(client, sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, name, status: "failed" });
          return "perm-deny";
        }
      }
      await update(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        name,
        status: "completed",
        rawOutput: { output: "Created At: x\nCommand exited with code 0.\n\nCommand output:\nok\n" },
      });
      return "allow";
    }

    const agentApp = acp
      .agent({ name: "fake-agy" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(acp.methods.agent.session.new, ({ params }) => {
        calls.news.push(params);
        return { sessionId: `S-${calls.news.length}`, configOptions: CONFIG_OPTIONS as never };
      })
      .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
        calls.loads.push(params);
        // Riwayat diputar ulang sebelum load selesai — tidak boleh masuk thread lagi.
        await update(client, params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "pesan lama" } });
        await update(client, params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RIWAYAT-LAMA" } });
        return { configOptions: CONFIG_OPTIONS as never };
      })
      .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
        calls.configs.push({ configId: params.configId, value: (params as { value?: unknown }).value });
        return { configOptions: CONFIG_OPTIONS as never };
      })
      .onNotification(acp.methods.agent.session.cancel, () => {
        calls.cancels += 1;
        cancel?.();
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
        calls.prompts.push(text);
        liveClient = client;
        liveSession = params.sessionId;
        const say = (value: string) =>
          update(client, params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
        const [verb, ...rest] = text.split(":");
        const arg = rest.join(":");
        if (verb === "shell") {
          await say(`hasil:${await tool(client, params.sessionId, "run_command", { CommandLine: arg, toolSummary: "uji" }, { permission: true })}`);
        } else if (verb === "write") {
          await say(`hasil:${await tool(client, params.sessionId, "write_file", { Path: arg, Content: "x" })}`);
        } else if (verb === "read") {
          await say(`hasil:${await tool(client, params.sessionId, "read_file", { Path: arg })}`);
        } else if (verb === "tool") {
          await say(`hasil:${await tool(client, params.sessionId, arg, {})}`);
        } else if (verb === "nohook") {
          await say(`hasil:${await tool(client, params.sessionId, "run_command", { CommandLine: "ls" }, { permission: true, skipHook: true })}`);
        } else if (verb === "ask") {
          const id = `call_${(sequence += 1)}`;
          const args = { questions: [{ question: "Warna?", options: ["Merah", "Biru"] }] };
          await update(client, params.sessionId, { sessionUpdate: "tool_call", toolCallId: id, name: "ask_question", args, rawInput: args, status: "in_progress", kind: "other", title: "Run ask_question" });
          await hook(params.sessionId, id, "ask_question", args);
          await update(client, params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, name: "ask_question", status: "pending" });
          await say("Warna? [1] Merah [2] Biru");
        } else if (verb === "slow") {
          await say("mulai lama");
          const stopped = await new Promise<boolean>((resolve) => {
            cancel = () => resolve(true);
            setTimeout(() => resolve(false), Number(arg) || 2_000);
          });
          cancel = undefined;
          if (stopped) return { stopReason: "cancelled" };
          await say("selesai lama");
        } else if (verb === "hang") {
          // Tidak menjawab cancel: runner harus menutup paksa setelah masa tenggang.
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        } else {
          await say(`diterima:${text}`);
        }
        await update(client, params.sessionId, { sessionUpdate: "usage_update", used: 2_000, size: 1_000_000 });
        return { stopReason: "end_turn", usage: { totalTokens: 1234 } } as never;
      });

    const connection = app.connect(agentApp);
    let exit: (value: { code: number | null; signal: string | null }) => void = () => undefined;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      exit = resolve;
    });
    return {
      connection,
      exited,
      stderrTail: () => "",
      kill: async () => {
        calls.kills += 1;
        connection.close();
        exit({ code: 0, signal: "SIGTERM" });
      },
    };
  };

  /** Update tanpa prompt aktif: agy menindaklanjuti perintah latar sendiri. */
  const background = async (text: string) => {
    if (!liveClient) return;
    await liveClient.notify(acp.methods.client.session.update, {
      sessionId: liveSession,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as never,
    });
  };
  return { launcher, calls, background };
}

// ---------- harness ----------

async function harness(options: { role?: RoleId; mode?: AutonomyMode; model?: string; sessionId?: string; slots?: number } = {}) {
  const role = options.role ?? "engineer";
  const task = createTask({ title: "uji acp", description: "uji", role, projectId: "P-uji", engine: "antigravity", model: options.model });
  const slots = new Semaphore(options.slots ?? 1);
  const outcomes: TurnOutcome[] = [];
  const events: StoredEvent[] = [];
  const statuses: string[] = [];
  const unsubscribe = bus.subscribe(task.id, (event) => events.push(event));
  const fake = fakeAgent();
  const runner = new AcpTaskRunner(
    task.id,
    role,
    {
      acquire: () => slots.acquire(),
      onStatus: (_id, status) => statuses.push(status),
      onSession: (taskId, sessionId) => {
        patchAssignment(taskId, { sessionId });
      },
      onTurnEnd: (_id, outcome) => outcomes.push(outcome),
      onIdleShutdown: () => undefined,
      onContext: (taskId, usage) => {
        patchAssignment(taskId, { context: { ...usage, at: new Date().toISOString() } });
      },
    },
    options.sessionId,
    options.mode ?? "ask",
    options.model,
    fake.launcher,
  );
  const of = <T extends StoredEvent["type"]>(type: T) => events.filter((event) => event.type === type) as Array<Extract<StoredEvent, { type: T }>>;
  const done = (count: number) => until(() => outcomes.length >= count);
  return { task, runner, slots, outcomes, events, statuses, of, done, calls: fake.calls, background: fake.background, unsubscribe };
}

const workspace = CONFIG.workspaceDir;

// ---------- A. sesi, persona, model ----------
{
  const h = await harness({ model: "claude-sonnet-4-6" });
  h.runner.send("halo");
  await h.done(1);
  const created = h.calls.news[0];
  const append = String((created?._meta as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append ?? "");
  check("A1 session/new di workspace tugas", created?.cwd === workspace, created?.cwd);
  check("A2 persona + catatan mesin di systemPrompt.append", append.includes("Catatan mesin (Antigravity)") && append.length > 500);
  const team = created?.mcpServers.find((server) => server.name === "team") as { type?: string; url?: string; headers?: Array<{ name: string; value: string }> } | undefined;
  check("A3 server MCP team lewat HTTP dengan token", team?.type === "http" && /\/api\/internal\/mcp\/team$/.test(team.url ?? "") && /^Bearer [0-9a-f]{64}$/.test(team.headers?.[0]?.value ?? ""), team);
  check("A4 folder tugas sebagai additionalDirectories", created?.additionalDirectories?.includes(CONFIG.tasksDir) === true);
  check("A5 model penugasan dipasang lewat set_config_option", h.calls.configs.some((c) => c.configId === "model" && c.value === "claude-sonnet-4-6"), h.calls.configs);
  const init = h.of("init")[0];
  check("A6 event init bertanda mesin antigravity", init?.engine === "antigravity" && init.model === "claude-sonnet-4-6", init);
  check("A7 sessionId tersimpan di penugasan", getTask(h.task.id)?.assignments.at(-1)?.sessionId === "S-1");
  check("A8 jawaban agen jadi event assistant", h.of("assistant").some((event) => event.text === "diterima:halo"));
  const result = h.of("result")[0];
  check("A9 result membawa token, tanpa biaya", result?.tokens === 1234 && result.costUsd === undefined && !result.isError, result);
  check("A10 konteks disimpan di akhir turn", getTask(h.task.id)?.assignments.at(-1)?.context?.usedTokens === 2_000);
  check("A11 outcome turn sukses", h.outcomes[0]?.subtype === "success" && h.outcomes[0].lastText === "diterima:halo", h.outcomes[0]);
  await h.runner.close();
  check("A12 close mematikan proses agy", h.calls.kills >= 1);
  h.unsubscribe();
}
{
  const h = await harness({ model: "model-tidak-ada" });
  h.runner.send("halo");
  await h.done(1);
  check("A13 model yang tidak tersedia: pemberitahuan, bukan gagal", h.of("notice").some((n) => n.text.includes("model-tidak-ada tidak tersedia")) && !h.outcomes[0]?.isError);
  await h.runner.close();
  h.unsubscribe();
}

// ---------- B. pagar: hook + request_permission ----------
{
  const h = await harness();
  h.runner.send("shell:ls -la");
  await h.done(1);
  const tool = h.of("tool")[0];
  check("B1 run_command tampil sebagai Bash dengan command", tool?.name === "Bash" && (tool.input as { command?: string }).command === "ls -la", tool);
  check("B2 allow-list role → hook allow → izin ACP dijawab allow", h.calls.hooks[0]?.answer?.decision === "allow" && JSON.stringify(h.calls.permissions[0]?.outcome) === JSON.stringify({ outcome: "selected", optionId: "allow" }), h.calls);
  check("B3 hasil tool tanpa cap waktu agy", h.of("tool_result")[0]?.preview === "ok", h.of("tool_result")[0]);
  check("B4 tanpa kartu persetujuan", h.of("approval").length === 0);

  h.runner.send("shell:rm -rf /");
  await h.done(2);
  check("B5 pagar keras menolak tanpa kartu", h.calls.hooks[1]?.answer?.decision === "deny" && h.of("approval").length === 0, h.calls.hooks[1]);
  check("B6 tool yang ditolak tidak sampai ke izin ACP", h.calls.permissions.length === 1);
  check("B7 alasan penolakan sampai ke agen", (h.calls.hooks[1]?.answer?.reason ?? "").includes("root"), h.calls.hooks[1]);

  // Perintah di luar allow-list Engineer → kartu; slot dilepas selama menunggu.
  h.runner.send("shell:curl -s https://example.com");
  check("B8 kartu persetujuan muncul", await until(() => h.runner.openRequests().length === 1), h.events.map((e) => e.type));
  check("B9 status waiting saat kartu terbuka", h.runner.status === "waiting");
  check("B10 slot dilepas selama menunggu owner", h.slots.inUse === 0, h.slots.inUse);
  const card = h.runner.openRequests()[0] as { approvalId: string; toolName: string };
  check("B11 kartu memakai nama tool Bash", card.toolName === "Bash", card);
  h.runner.resolveRequest(card.approvalId, { decision: "allow" });
  await h.done(3);
  check("B12 izin owner → tool jalan", h.calls.hooks[2]?.answer?.decision === "allow" && h.calls.permissions.length === 2, h.calls.hooks[2]);

  h.runner.send("shell:curl -s https://example.org");
  await until(() => h.runner.openRequests().length === 1);
  const second = h.runner.openRequests()[0] as { approvalId: string };
  h.runner.resolveRequest(second.approvalId, { decision: "deny", message: "pakai fixture lokal" });
  await h.done(4);
  check("B13 alasan tolak owner diteruskan ke agen", h.calls.hooks[3]?.answer?.reason === "Ditolak owner: pakai fixture lokal", h.calls.hooks[3]);
  check("B14 kartu ditutup dengan approval_resolved", h.of("approval_resolved").length === 2);

  h.runner.send("shell:docker compose up -d");
  check("B15 policy 'ask' tetap kartu", await until(() => h.runner.openRequests().length === 1));
  await h.runner.interrupt();
  await h.done(5);
  check("B16 Stop menutup kartu dan hook ditolak", h.calls.hooks[4]?.answer?.decision === "deny" && h.runner.openRequests().length === 0, h.calls.hooks[4]);

  h.runner.send("nohook");
  await h.done(6);
  check("B17 izin ACP tanpa keputusan hook ditolak", JSON.stringify(h.calls.permissions.at(-1)?.outcome) === JSON.stringify({ outcome: "selected", optionId: "deny" }) && h.of("notice").some((n) => n.text.includes("tidak lewat pagar")));
  await h.runner.close();
  h.unsubscribe();
}

// ---------- C. berkas & role ----------
{
  const h = await harness();
  h.runner.send(`write:${join(workspace, "a.txt")}`);
  await h.done(1);
  check("C1 Engineer menulis di workspace tanpa kartu", h.calls.hooks[0]?.answer?.decision === "allow", h.calls.hooks[0]);
  const write = h.of("tool")[0];
  check("C2 write_file tampil sebagai Write dengan file_path", write?.name === "Write" && (write.input as { file_path?: string }).file_path === join(workspace, "a.txt"));
  h.runner.send("write:/etc/hosts");
  await h.done(2);
  check("C3 /etc ditolak aturan DENY_ALWAYS", h.calls.hooks[1]?.answer?.decision === "deny", h.calls.hooks[1]);
  h.runner.send(`read:${join(CONFIG.antigravity.dir, "config", "hooks.json")}`);
  await h.done(3);
  check("C4 hooks.json tidak bisa dibaca", h.calls.hooks[2]?.answer?.decision === "deny", h.calls.hooks[2]);
  h.runner.send(`write:${join(CONFIG.dataDir, "settings.json")}`);
  await h.done(4);
  check("C5 data aplikasi tidak boleh disunting", h.calls.hooks[3]?.answer?.decision === "deny", h.calls.hooks[3]);
  h.runner.send("tool:invoke_subagent");
  await h.done(5);
  check("C6 subagen agy ditolak", h.calls.hooks[4]?.answer?.decision === "deny" && (h.calls.hooks[4]?.answer?.reason ?? "").includes("subagen"));
  h.runner.send("tool:mcp_team_findings_list");
  await h.done(6);
  check("C7 tool MCP team diizinkan", h.calls.hooks[5]?.answer?.decision === "allow" && h.of("tool").at(-1)?.name === "mcp__team__findings_list", h.of("tool").at(-1));
  h.runner.send("tool:mcp_figma_get_file");
  await h.done(7);
  check("C8 server MCP asing ditolak", h.calls.hooks[6]?.answer?.decision === "deny");
  h.runner.send("tool:jurus_baru");
  check("C9 tool tak dikenal → kartu", await until(() => h.runner.openRequests().length === 1));
  await h.runner.interrupt();
  await h.done(8);
  await h.runner.close();
  h.unsubscribe();
}
{
  const h = await harness({ role: "qa" });
  h.runner.send(`write:${join(workspace, "src.ts")}`);
  await h.done(1);
  check("C10 QA tidak boleh menyunting workspace", h.calls.hooks[0]?.answer?.decision === "deny", h.calls.hooks[0]);
  h.runner.send(`write:${join(CONFIG.tasksDir, h.task.id, "report.md")}`);
  await h.done(2);
  check("C11 QA boleh menulis report di folder tugas", h.calls.hooks[1]?.answer?.decision === "allow", h.calls.hooks[1]);
  await h.runner.close();
  h.unsubscribe();
}
{
  const h = await harness({ mode: "readonly" });
  h.runner.send("shell:git log --oneline");
  await h.done(1);
  h.runner.send("shell:npm test");
  await h.done(2);
  h.runner.send(`write:${join(workspace, "b.txt")}`);
  await h.done(3);
  const [log, test, write] = h.calls.hooks.map((entry) => entry.answer?.decision);
  check("C12 Hanya baca: perintah baca jalan, test & tulis ditolak", log === "allow" && test === "deny" && write === "deny", h.calls.hooks);
  await h.runner.setMode("auto");
  h.runner.send("shell:curl -s https://example.com");
  await h.done(4);
  check("C13 ganti mode berlaku seketika (Auto)", h.calls.hooks[3]?.answer?.decision === "allow", h.calls.hooks[3]);
  await h.runner.close();
  h.unsubscribe();
}
{
  // Symlink ke folder terlindung tidak boleh jadi jalan pintas.
  const link = join(workspace, "pintas");
  symlinkSync(CONFIG.antigravity.dir, link);
  mkdirSync(join(CONFIG.antigravity.dir, "config"), { recursive: true });
  writeFileSync(join(CONFIG.antigravity.dir, "config", "x.json"), "{}");
  const verdict = decideTool({
    role: "engineer",
    mode: "auto",
    name: "read_file",
    args: { Path: join(link, "config", "x.json") },
    workspaceDir: workspace,
    taskDir: join(CONFIG.tasksDir, "T-x"),
    commandVerdict: () => ({ decision: "pass", message: "" }),
  });
  check("C14 symlink ke data agy tetap ditolak", verdict.decision === "deny", verdict);
}

// ---------- D. pertanyaan, Stop, antrean ----------
{
  const h = await harness();
  h.runner.send("ask");
  check("D1 ask_question → kartu pertanyaan", await until(() => h.of("question").length === 1));
  await until(() => h.runner.status === "waiting");
  check("D2 turn belum selesai, status waiting, slot dilepas", h.outcomes.length === 0 && h.runner.status === "waiting" && h.slots.inUse === 0, { outcomes: h.outcomes, status: h.runner.status });
  const question = h.of("question")[0];
  h.runner.resolveRequest(question?.questionId ?? "", { "Warna?": "Merah" });
  await h.done(1);
  check("D3 jawaban dikirim sebagai prompt berikutnya di turn yang sama", h.calls.prompts[1]?.includes("Warna? → Merah") === true && h.outcomes.length === 1, h.calls.prompts);
  check("D4 tool ask_question ditutup dengan jawabannya", h.of("tool_result").some((event) => event.preview.includes("Merah")));
  check("D5 satu result untuk turn itu", h.of("result").length === 1, h.of("result").length);

  h.runner.send("ask");
  await until(() => h.runner.status === "waiting");
  h.runner.send("biru saja");
  await h.done(2);
  check("D6 chat owner saat kartu terbuka = jawaban", h.calls.prompts[3]?.includes("biru saja") === true && h.of("question_resolved").length === 2, h.calls.prompts);

  h.runner.send("slow:3000");
  await until(() => h.calls.prompts.length === 5);
  h.runner.send("susulan");
  await tick(20);
  check("D7 pesan di tengah turn mengantre", h.calls.prompts.length === 5);
  await h.runner.interrupt();
  await h.done(3);
  check("D8 Stop → session/cancel → result interrupted", h.calls.cancels === 1 && h.outcomes[2]?.interrupted === true && h.of("result").at(-1)?.interrupted === true, h.outcomes[2]);
  check("D9 Stop membatalkan pesan antre", h.of("notice").some((n) => n.text.includes("1 pesan")) && h.calls.prompts.length === 5);

  h.runner.send("slow:150");
  await until(() => h.calls.prompts.length === 6);
  h.runner.send("dua");
  await h.done(5);
  check("D10 pesan antre jalan setelah turn selesai", h.calls.prompts.slice(5).join(",") === "slow:150,dua" && h.outcomes[3]?.followUp === true, h.outcomes.slice(3));

  h.runner.send("hang");
  await until(() => h.calls.prompts.length === 8);
  await h.runner.interrupt();
  await h.done(6);
  check("D11 agen yang tidak menjawab Stop ditutup paksa", h.outcomes[5]?.interrupted === true && h.of("notice").some((n) => n.text.includes("ditutup paksa")), h.outcomes[5]);
  h.runner.send("setelah paksa");
  await h.done(7);
  check("D12 sesi dimuat lagi setelah ditutup paksa", h.calls.loads.length === 1 && h.calls.loads[0]?.sessionId === "S-1" && h.calls.prompts.at(-1) === "setelah paksa", h.calls.loads);
  check("D13 putar ulang riwayat tidak masuk thread", !h.of("assistant").some((event) => event.text.includes("RIWAYAT-LAMA")));
  await h.runner.close();
  h.unsubscribe();
}
{
  const h = await harness({ sessionId: "S-lama" });
  h.runner.send("lanjut");
  await h.done(1);
  check("D14 resume dari sessionId memakai session/load", h.calls.loads[0]?.sessionId === "S-lama" && h.calls.news.length === 0, { loads: h.calls.loads.length, news: h.calls.news.length });

  await h.background("menindaklanjuti build latar");
  check("D15 update tanpa prompt → status working", await until(() => h.runner.status === "working"));
  await h.done(2);
  check("D16 turn latar ditutup setelah sepi, ditandai background", h.outcomes[1]?.background === true && h.of("result").at(-1)?.background === true && h.runner.status === "idle", h.outcomes[1]);

  const token = (h.runner as unknown as { hook: { token: string } }).hook.token;
  await h.runner.close();
  const after = await startHook(token, { toolCall: { id: "x", name: "run_command", args: { CommandLine: "ls" } } }, 10);
  check("D17 token hook dicabut saat runner ditutup", after === undefined, after);
  h.unsubscribe();
}

rmSync(sandbox, { recursive: true, force: true });
console.log(failed === 0 ? "\nSemua pengujian lulus." : `\n${failed} pengujian gagal.`);
process.exit(failed === 0 ? 0 : 1);
