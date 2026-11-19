/**
 * Spike: memeriksa perilaku `agy acp` secara langsung dan mencatat JSON-RPC mentahnya.
 *
 *   bun scripts/spike-agy.ts init                 # initialize saja (tanpa model)
 *   bun scripts/spike-agy.ts new                  # initialize + session/new (tanpa model)
 *   bun scripts/spike-agy.ts prompt "<teks>"      # satu turn sungguhan (MEMANGGIL MODEL)
 *   bun scripts/spike-agy.ts load <id> "<teks>"   # session/load lalu satu turn (MEMANGGIL MODEL)
 *
 * Env:
 *   SPIKE_DIR      folder data agy terpisah (bawaan: data/antigravity)
 *   SPIKE_CWD      cwd sesi (bawaan: folder scratch di SPIKE_DIR)
 *   SPIKE_ALLOW    "1" = izinkan semua permintaan izin (allow_once), selain itu tolak (reject_once)
 *   SPIKE_MCP      "1" = pasang server MCP HTTP uji (tool `echo_image`) dan stdio uji
 *   SPIKE_LOG      berkas log JSON-RPC (bawaan: <SPIKE_DIR>/spike.jsonl)
 *   SPIKE_PPS      "1" = --process-per-session (wajib untuk MCP HTTP)
 *   SPIKE_FS       "1" = umumkan kapabilitas fs klien (baca/tulis berkas lewat klien)
 *   SPIKE_FS_DENY  "1" = tolak setiap fs/write_text_file
 *   SPIKE_MODEL, SPIKE_MODE, SPIKE_CANCEL_MS, SPIKE_PROMPT2
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const [command = "init", text = "Balas satu kata: OK"] = process.argv.slice(2);
const dir = resolve(process.env.SPIKE_DIR ?? "data/antigravity");
const cwd = resolve(process.env.SPIKE_CWD ?? join(dir, "spike-cwd"));
const logPath = process.env.SPIKE_LOG ?? join(dir, "spike.jsonl");
mkdirSync(dir, { recursive: true });
mkdirSync(cwd, { recursive: true });

const log = (direction: string, line: string) => {
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), direction, line })}\n`);
};

// ---------- server MCP uji (HTTP) ----------
// PNG 1x1 merah: cukup untuk melihat apakah konten gambar diteruskan ke model.
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
let mcpUrl: string | undefined;
if (process.env.SPIKE_MCP === "1") {
  const server = createServer(async (req, res) => {
    log("mcp-http", `${req.method} ${req.url} auth=${req.headers.authorization ? "yes" : "no"}`);
    const mcp = new McpServer({ name: "spike", version: "0.0.1" });
    mcp.registerTool(
      "echo_image",
      { description: "Mengembalikan teks dan satu gambar kecil berwarna solid.", inputSchema: { note: z.string().optional() } },
      async ({ note }) => ({
        content: [
          { type: "text", text: `echo: ${note ?? ""}` },
          { type: "image", data: RED_PNG, mimeType: "image/png" },
        ],
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (address && typeof address === "object") mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
}

// ---------- proses agy ----------
// `--app-data-dir` harus relatif (nama subfolder di dalam gemini-dir); cukup pindahkan gemini-dir.
const args = ["acp", "--gemini-dir", join(dir, "gemini"), "--disable-telemetry"];
if (process.env.SPIKE_PPS === "1") args.push("--process-per-session");
for (const extra of (process.env.SPIKE_ADD_DIR ?? "").split(",").filter(Boolean)) args.push("--add-dir", extra);
const child = spawn("agy", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ANTHROPIC_API_KEY: undefined } });
child.stderr.on("data", (d) => log("stderr", String(d)));
child.on("exit", (code, signal) => log("exit", `${code} ${signal}`));

// Tee stdout/stdin ke log baris per baris.
let outBuf = "";
child.stdout.on("data", (d: Buffer) => {
  outBuf += d.toString("utf8");
  let i: number;
  while ((i = outBuf.indexOf("\n")) >= 0) {
    log("agent->client", outBuf.slice(0, i));
    outBuf = outBuf.slice(i + 1);
  }
});
const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    log("client->agent", new TextDecoder().decode(chunk).trimEnd());
    child.stdin.write(chunk);
  },
  close() {
    child.stdin.end();
  },
});

const fsOn = process.env.SPIKE_FS === "1";
let replayed = 0;
let loading = false;
const app = acp
  .client({ name: "ai-team-spike" })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const allow = process.env.SPIKE_ALLOW === "1";
    const wanted = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const option = params.options.find((o) => wanted.includes(o.kind)) ?? params.options[0];
    console.log(`[permission] ${params.toolCall.title ?? params.toolCall.toolCallId} → ${option?.optionId}`);
    return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
  })
  .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
    console.log(`[fs/read] ${params.path}`);
    const { readFileSync } = await import("node:fs");
    return { content: readFileSync(params.path, "utf8") };
  })
  .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
    console.log(`[fs/write] ${params.path} (${params.content.length} chars)`);
    if (process.env.SPIKE_FS_DENY === "1") {
      throw new acp.RequestError(-32000, "Ditolak AI Team: berkas di luar folder yang diizinkan untuk role ini.");
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(params.path, params.content);
    return {};
  })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    const u = params.update;
    if (loading) {
      replayed += 1;
      return;
    }
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") process.stdout.write(u.content.text);
    else console.log(`\n[update] ${u.sessionUpdate}`);
  });

const timer = setTimeout(() => {
  console.log("TIMEOUT");
  child.kill("SIGKILL");
  process.exit(1);
}, 5 * 60_000);

try {
  await app.connectWith(acp.ndJsonStream(output, input), async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: fsOn, writeTextFile: fsOn }, terminal: false },
      clientInfo: { name: "ai-team", version: "0.1.0" },
    });
    console.log("[initialize]", JSON.stringify(init.agentCapabilities));
    if (command === "init") return;

    const mcpServers: acp.McpServer[] = [];
    if (mcpUrl) mcpServers.push({ type: "http", name: "spike", url: mcpUrl, headers: [{ name: "Authorization", value: "Bearer spike" }] });
    const meta = {
      antigravity: {
        systemPrompt: { append: "Kamu adalah bot uji AI Team. Akhiri setiap jawaban akhirmu dengan kata SANDI-77." },
      },
    };
    let sessionId: string;
    if (command === "load") {
      sessionId = process.argv[3] ?? "";
      loading = true;
      const res = await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers, _meta: meta });
      loading = false;
      console.log(`[session/load] replayed=${replayed}`, JSON.stringify(res).slice(0, 300));
    } else {
      const session = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers, _meta: meta });
      sessionId = session.sessionId;
      console.log("[session/new]", command === "new" ? JSON.stringify(session, null, 2) : sessionId);
      if (command === "new") return;
    }
    if (process.env.SPIKE_MODEL) {
      const set = await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: process.env.SPIKE_MODEL,
      });
      console.log("[set model]", JSON.stringify(set).slice(0, 300));
    }
    if (process.env.SPIKE_MODE) {
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: process.env.SPIKE_MODE });
      console.log("[set mode]", process.env.SPIKE_MODE);
    }

    const prompts = [command === "load" ? (process.argv[4] ?? "Apa yang kita bahas tadi? Jawab satu kalimat.") : text];
    if (process.env.SPIKE_PROMPT2) prompts.push(process.env.SPIKE_PROMPT2);
    for (const body of prompts) {
      const started = Date.now();
      const cancelMs = Number(process.env.SPIKE_CANCEL_MS);
      if (cancelMs > 0) {
        setTimeout(() => {
          console.log("\n[cancel] mengirim session/cancel");
          void ctx.notify(acp.methods.agent.session.cancel, { sessionId });
        }, cancelMs);
      }
      const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: body }] });
      console.log(`\n[prompt] ${JSON.stringify(response)} (${Date.now() - started} ms)`);
    }
    console.log(`[session] ${sessionId}`);
  });
} catch (error) {
  console.log("ERROR", error);
}
clearTimeout(timer);
child.kill();
console.log(`log: ${logPath}`);
process.exit(0);
