/**
 * Uji jalur HTTP mesin Antigravity: server MCP team/browser lewat Streamable HTTP, endpoint hook
 * PreToolUse, dan `hook-client.ts` yang dijalankan persis seperti agy menjalankannya (`sh -c`).
 * Deterministik, tanpa model dan tanpa `agy`; membuka Chromium headless untuk tool browser (~10 dtk).
 *   bun run check:mcp-http
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-mcp-http-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
process.env.AGY_DIR = join(sandbox, "agy");

const express = (await import("express")).default;
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { httpGuard } = await import("../server/http-guard.ts");
const { mcpRouter, registerMcpEndpoint, MCP_PATH } = await import("../server/mcp-http.ts");
const { agyHookRouter, registerHookHandler, HOOK_PATH } = await import("../server/engines/antigravity/hooks.ts");
const { ensureAgyConfig, agyConfigDir } = await import("../server/engines/antigravity/process.ts");
const { createTeamServer } = await import("../server/team/mcp.ts");
const { BrowserSession, createBrowserServer } = await import("../server/browser/mcp.ts");
const { createTask } = await import("../server/tasks.ts");
import type { HookPayload } from "../server/engines/antigravity/hooks.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

const app = express();
app.use("/api", httpGuard);
app.use(express.json({ limit: "5mb" }));
app.use("/api", mcpRouter, agyHookRouter);
app.get("/fixture", (_req, res) => {
  res.type("html").send("<!doctype html><title>Fixture MCP</title><h1>Halo agen</h1><button>Simpan</button>");
});
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const task = createTask({ title: "uji mcp http", description: "uji", role: "qa", projectId: "P-uji" });
const browser = new BrowserSession(() => task.id);
const endpoint = registerMcpEndpoint({
  team: () => createTeamServer(task.id, "qa").instance,
  browser: () => createBrowserServer(browser, () => task.id).instance,
});

async function connect(name: string, token: string) {
  const client = new Client({ name: "uji", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}/${name}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

// ---------- MCP ----------

check("M1 URL server memakai jalur internal", endpoint.servers.map((s) => new URL(s.url).pathname).join(",") === `${MCP_PATH}/team,${MCP_PATH}/browser`, endpoint.servers);

const anonymous = await fetch(`${base}${MCP_PATH}/team`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("M2 tanpa token ditolak 401", anonymous.status === 401, anonymous.status);
const wrong = await fetch(`${base}${MCP_PATH}/team`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer salah" },
  body: "{}",
});
check("M3 token salah ditolak 401", wrong.status === 401, wrong.status);
const fromBrowser = await fetch(`${base}${MCP_PATH}/team`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}`, origin: base },
  body: "{}",
});
check("M4 permintaan dari browser (Origin) ditolak 403", fromBrowser.status === 403, fromBrowser.status);
const unknownServer = await fetch(`${base}${MCP_PATH}/figma`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
  body: "{}",
});
check("M5 server yang tidak didaftarkan → 404", unknownServer.status === 404, unknownServer.status);

const team = await connect("team", endpoint.token);
const teamTools = (await team.listTools()).tools.map((tool) => tool.name);
check("M6 tools/list team berisi tool AI Team", ["remember", "suggest_handoff", "findings_list", "finding_retest"].every((name) => teamTools.includes(name)), teamTools);
const findings = await team.callTool({ name: "findings_list", arguments: {} });
check("M7 tool team bisa dipanggil", Array.isArray(findings.content) && findings.content.length > 0, findings);

// Dua sesi MCP bersamaan mendapat McpServer sendiri-sendiri.
const team2 = await connect("team", endpoint.token);
check("M8 sesi MCP kedua untuk server yang sama", (await team2.listTools()).tools.length === teamTools.length);

const web = await connect("browser", endpoint.token);
const browserTools = (await web.listTools()).tools.map((tool) => tool.name);
check("M9 tools/list browser berisi open/snapshot/view", ["open", "snapshot", "view", "screenshot", "click"].every((name) => browserTools.includes(name)), browserTools);
const opened = await web.callTool({ name: "open", arguments: { url: `${base}/fixture` } });
const openedText = JSON.stringify(opened.content);
check("M10 open halaman fixture lewat HTTP", openedText.includes("Fixture MCP") && !opened.isError, openedText.slice(0, 300));
const snapshot = await web.callTool({ name: "snapshot", arguments: {} });
check("M11 snapshot memuat tombol dengan ref", /Simpan/.test(JSON.stringify(snapshot.content)) && /ref=/.test(JSON.stringify(snapshot.content)));
const view = await web.callTool({ name: "view", arguments: {} });
const image = (view.content as Array<{ type: string; mimeType?: string; data?: string }>).find((item) => item.type === "image");
check("M12 view mengembalikan konten gambar", Boolean(image?.data && image.mimeType?.startsWith("image/")), (view.content as unknown[]).map((item) => (item as { type: string }).type));

await team.close();
await team2.close();
await web.close();
await endpoint.revoke();
const revoked = await fetch(`${base}${MCP_PATH}/team`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
  body: "{}",
});
check("M13 token dicabut → 401", revoked.status === 401, revoked.status);
await browser.close();

// ---------- hook ----------

const seen: HookPayload[] = [];
const allowHook = registerHookHandler(async (payload) => {
  seen.push(payload);
  return payload.toolCall?.name === "run_command" ? { decision: "deny", reason: "uji tolak" } : { decision: "allow" };
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const direct = await post(HOOK_PATH, { toolCall: { id: "c1", name: "read_file", args: { Path: "/x" } } }, { authorization: `Bearer ${allowHook.token}` });
check("H1 endpoint hook menjawab keputusan", JSON.stringify(await direct.json()) === JSON.stringify({ decision: "allow" }));
const stranger = await post(HOOK_PATH, { toolCall: { id: "c2", name: "read_file" } }, { authorization: "Bearer salah" });
const strangerBody = (await stranger.json()) as { decision?: string };
check("H2 token tak dikenal → 401 dan deny", stranger.status === 401 && strangerBody.decision === "deny", strangerBody);
const unknownWait = await post(`${HOOK_PATH}/wait`, { id: "tidak-ada" }, { authorization: `Bearer ${allowHook.token}` });
check("H3 /wait dengan id tak dikenal → deny", ((await unknownWait.json()) as { decision?: string }).decision === "deny");

ensureAgyConfig();
const hooks = JSON.parse(readFileSync(join(agyConfigDir(), "hooks.json"), "utf8")) as Record<string, { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }> }>;
const entry = hooks["ai-team-guard"]?.PreToolUse[0];
const command = entry?.hooks[0]?.command ?? "";
check("H4 hooks.json: matcher * dan timeout panjang", entry?.matcher === "*" && (entry.hooks[0]?.timeout ?? 0) >= 3_600, entry);
const config = JSON.parse(readFileSync(join(agyConfigDir(), "config.json"), "utf8")) as { plugins?: { swarm?: { enabled?: boolean } } };
check("H5 plugin swarm dimatikan", config.plugins?.swarm?.enabled === false, config);

/** Jalankan perintah dari hooks.json seperti agy: `sh -c`, cwd folder config, payload di stdin. */
function runHook(env: Record<string, string | undefined>, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd: agyConfigDir(), env: { PATH: process.env.PATH, ...env } });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("exit", () => {
      try {
        resolve(JSON.parse(out) as Record<string, unknown>);
      } catch {
        resolve({ raw: out });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const hookEnv = { AI_TEAM_HOOK_URL: `${base}${HOOK_PATH}`, AI_TEAM_HOOK_TOKEN: allowHook.token };
const allowed = await runHook(hookEnv, { hookEventName: "PreToolUse", toolCall: { id: "c3", name: "write_file", args: { Path: "/w/a" } } });
check("H6 hook-client meneruskan payload dan mencetak allow", allowed.decision === "allow" && seen.at(-1)?.toolCall?.id === "c3", allowed);
const denied = await runHook(hookEnv, { hookEventName: "PreToolUse", toolCall: { id: "c4", name: "run_command", args: { CommandLine: "ls" } } });
check("H7 hook-client mencetak deny beserta alasan", denied.decision === "deny" && denied.reason === "uji tolak", denied);
const noEnv = await runHook({}, { toolCall: { id: "c5", name: "read_file" } });
check("H8 tanpa env AI Team → deny", noEnv.decision === "deny", noEnv);
const garbage = await new Promise<Record<string, unknown>>((resolve) => {
  const child = spawn("sh", ["-c", command], { cwd: agyConfigDir(), env: { PATH: process.env.PATH, ...hookEnv } });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.on("exit", () => resolve(JSON.parse(out || "{}") as Record<string, unknown>));
  child.stdin.end("bukan json");
});
check("H9 payload rusak → deny", garbage.decision === "deny", garbage);
allowHook.revoke();
const afterRevoke = await runHook(hookEnv, { toolCall: { id: "c6", name: "read_file" } });
check("H10 token dicabut → deny", afterRevoke.decision === "deny", afterRevoke);
await new Promise((resolve) => server.close(resolve));
const serverDown = await runHook({ ...hookEnv }, { toolCall: { id: "c7", name: "read_file" } });
check("H11 server mati → deny (fail-closed)", serverDown.decision === "deny" && String(serverDown.reason).includes("tidak bisa dihubungi"), serverDown);

rmSync(sandbox, { recursive: true, force: true });
console.log(failed === 0 ? "\nSemua pengujian lulus." : `\n${failed} pengujian gagal.`);
process.exit(failed === 0 ? 0 : 1);
