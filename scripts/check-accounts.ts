/**
 * Uji akun AI milik app di AI Team: env Claude, mesin mengikuti akun, pagar scheduler, salinan
 * transkrip sesi dari ~/.claude, folder rahasia terlindung, dan adaptor Express rute akun.
 * Alur login, store, dan provider diuji di library ai-agent-auth (`bun test` di sana).
 * Deterministik, tanpa model, tanpa `claude`/`agy` sungguhan: bun run check:accounts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-accounts-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
// agy sengaja tidak ada: akun Gemini harus terbaca "tidak bisa dipakai di mesin ini".
process.env.AGY_BIN = "agy-tidak-ada-di-uji";
delete process.env.AGY_DIR;
process.env.ANTHROPIC_API_KEY = "kunci-yang-harus-dibuang";
mkdirSync(process.env.WORKSPACE_DIR, { recursive: true });

const { CONFIG } = await import("../server/config.ts");
const { migrateClaudeSessions } = await import("../server/accounts/claude.ts");
const { resolveClaudeBin } = await import("ai-agent-auth/claude");
const accounts = await import("../server/accounts/index.ts");
const { auth, claudeEnv } = accounts;
const store = auth.store;
const { protectedDirs } = await import("../server/protected.ts");
const { createTask, patchAssignment, getTask, updateTask } = await import("../server/tasks.ts");
const { scheduler } = await import("../server/agent/scheduler.ts");
const { bus } = await import("../server/agent/bus.ts");
const { accountsRouter } = await import("../server/routes/accounts.ts");
const express = (await import("express")).default;
import type { StoredEvent } from "../server/types.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

// ---------- 1. env Claude ----------

{
  const env = claudeEnv();
  check("F1 CLAUDE_CONFIG_DIR menunjuk folder akun app", env.CLAUDE_CONFIG_DIR === join(sandbox, "accounts", "claude"), env.CLAUDE_CONFIG_DIR);
  check("F2 API key dibuang dari env agen", env.ANTHROPIC_API_KEY === undefined && env.ANTHROPIC_AUTH_TOKEN === undefined && env.CLAUDE_CODE_OAUTH_TOKEN === undefined);
  check("F3 folder akun library = folder CONFIG", auth.paths().providers.claude === CONFIG.claudeDir && auth.paths().providers.gemini === CONFIG.antigravity.dir, auth.paths());
  const bin = resolveClaudeBin({ env: { PATH: "" }, resolveFrom: new URL("../server/accounts/auth.ts", import.meta.url) });
  check("F4 Claude Code bawaan SDK dipakai tanpa `claude` di PATH", Boolean(bin?.includes("@anthropic-ai/claude-agent-sdk-")), bin);
}

// ---------- 2. mesin mengikuti akun ----------

const changes: number[] = [];
const offChanges = accounts.onAccountsChanged(() => changes.push(Date.now()));

{
  const claude = accounts.accountView("claude");
  const gemini = accounts.accountView("gemini");
  check("G1 tanpa akun: Claude 'none'", claude.state === "none" && claude.models.length === 0, claude);
  check("G2 agy tidak ada: Gemini 'unavailable' dengan alasan", gemini.state === "unavailable" && /tidak ditemukan/.test(gemini.reason ?? ""), gemini);
  const usable = accounts.engineUsable("claude");
  check("G3 Claude tanpa akun tidak bisa dipakai", !usable.ok && /belum ditambahkan/.test(usable.reason ?? ""), usable);
  check("G4 Gemini tanpa agy tidak bisa dipakai", !accounts.engineUsable("antigravity").ok);
  check("G5 tidak ada mesin siap", accounts.usableEngines().length === 0, accounts.usableEngines());
}

// Tugas yang sempat berjalan, tanpa akun: tidak dilanjutkan, diberi catatan.
{
  const task = createTask({ title: "uji akun", description: "uji", role: "qa", projectId: "P-uji" });
  updateTask(task.id, { status: "running" });
  const events: StoredEvent[] = [];
  const off = bus.subscribe(task.id, (event) => events.push(event));
  const blocked = scheduler.blockedReason(getTask(task.id)!);
  const resumed = scheduler.resumePending();
  off();
  const after = getTask(task.id);
  const notice = events.find((event) => event.type === "notice") as Extract<StoredEvent, { type: "notice" }> | undefined;
  check("H1 blockedReason menyebut akun Claude", /akun Claude belum ditambahkan/.test(blocked ?? ""), blocked);
  check("H2 resumePending tidak menjalankan tugas tanpa akun", resumed === 0 && scheduler.stats().runners === 0, { resumed, stats: scheduler.stats() });
  check("H3 tugasnya jadi needs_review", after?.status === "needs_review", after?.status);
  check("H4 pemilik diberi catatan", Boolean(notice && /Kirim pesan untuk melanjutkan/.test(notice.text)), events);
}

{
  store.save("claude", { addedAt: new Date().toISOString(), email: "uji@example.com", plan: "Max", status: "ok", checkedAt: new Date().toISOString() });
  const view = accounts.accountView("claude");
  check("I1 akun tersimpan → state ok", view.state === "ok" && view.email === "uji@example.com" && view.plan === "Max", view);
  check("I2 Claude bisa dipakai, Gemini tetap tidak", accounts.engineUsable("claude").ok && accounts.usableEngines().join() === "claude", accounts.usableEngines());
  check("I3 perubahan akun memicu event", changes.length >= 1, changes.length);
  const onDisk = JSON.parse(readFileSync(join(sandbox, "accounts.json"), "utf8")) as { accounts: Record<string, unknown> };
  check("I4 accounts.json hanya metadata", Boolean(onDisk.accounts.claude) && !JSON.stringify(onDisk).includes("token"), onDisk);
  check("I5 accounts.json hanya untuk user ini (0600)", (statSync(join(sandbox, "accounts.json")).mode & 0o077) === 0);

  store.patch("claude", { status: "error", error: "jaringan putus" });
  check("I6 status error (bukan login) tidak memblokir", accounts.engineUsable("claude").ok);

  accounts.markAccountExpired("claude", "authentication_failed");
  const expired = accounts.engineUsable("claude");
  check("I7 login kedaluwarsa memblokir dengan ajakan login ulang", !expired.ok && /login ulang/.test(expired.reason ?? ""), expired);

  const task = createTask({ title: "uji kedaluwarsa", description: "uji", role: "qa", projectId: "P-uji" });
  check("I8 blockedReason ikut kedaluwarsa", /login ulang/.test(scheduler.blockedReason(task) ?? ""));
  updateTask(task.id, { status: "cancelled" });

  store.remove("claude");
  check("I9 akun dihapus → kembali none", accounts.accountView("claude").state === "none");
}

{
  const dir = auth.ensureDir("claude");
  check("I10 folder akun dibuat 0700", existsSync(dir) && (statSync(dir).mode & 0o077) === 0 && (statSync(CONFIG.accountsDir).mode & 0o077) === 0);
}

// ---------- 3. salinan transkrip sesi dari ~/.claude ----------

{
  const source = join(sandbox, "home-claude", "projects");
  const slug = "-var-www-ai-team-workspace";
  mkdirSync(join(source, slug, "sesi-a", "subagents"), { recursive: true });
  writeFileSync(join(source, slug, "sesi-a.jsonl"), '{"type":"user"}\n');
  writeFileSync(join(source, slug, "sesi-a", "subagents", "agent-1.jsonl"), "{}\n");
  writeFileSync(join(source, slug, "sesi-asing.jsonl"), "{}\n");
  writeFileSync(join(source, slug, "sesi-gemini.jsonl"), "{}\n");
  const before = statSync(join(source, slug, "sesi-a.jsonl")).mtimeMs;

  const claudeTask = createTask({ title: "lama", description: "lama", role: "engineer", projectId: "P-uji" });
  patchAssignment(claudeTask.id, { sessionId: "sesi-a" });
  const lostTask = createTask({ title: "hilang", description: "hilang", role: "engineer", projectId: "P-uji" });
  patchAssignment(lostTask.id, { sessionId: "sesi-hilang" });
  const geminiTask = createTask({ title: "gemini", description: "g", role: "qa", projectId: "P-uji", engine: "antigravity" });
  patchAssignment(geminiTask.id, { sessionId: "sesi-gemini" });
  for (const task of [claudeTask, lostTask, geminiTask]) updateTask(task.id, { status: "cancelled" });

  const first = migrateClaudeSessions(source);
  const target = join(CONFIG.claudeDir, "projects", slug);
  check("J1 hanya sesi Claude yang dirujuk tugas disalin", first.copied === 1 && existsSync(join(target, "sesi-a.jsonl")), first);
  check("J2 folder subagen sesi ikut disalin", existsSync(join(target, "sesi-a", "subagents", "agent-1.jsonl")));
  check("J3 sesi asing dan sesi Gemini tidak disalin", !existsSync(join(target, "sesi-asing.jsonl")) && !existsSync(join(target, "sesi-gemini.jsonl")));
  check("J4 sesi yang tidak ditemukan dihitung", first.missing === 1, first);
  check("J5 sumber di ~/.claude tidak berubah", existsSync(join(source, slug, "sesi-a.jsonl")) && statSync(join(source, slug, "sesi-a.jsonl")).mtimeMs === before);
  const second = migrateClaudeSessions(source);
  check("J6 menjalankan ulang tidak menyalin lagi", second.copied === 0, second);
}

// ---------- 4. folder rahasia terlindung dari agen ----------

{
  const guarded = protectedDirs();
  const covered = (path: string) => guarded.some((dir) => path === dir || path.startsWith(`${dir}${sep}`));
  const paths = auth.paths();
  const secrets = [paths.accountsFile, paths.accountsDir, ...Object.values(paths.providers)];
  check("K1 semua folder akun library dilindungi protectedDirs()", secrets.every(covered), secrets.filter((path) => !covered(path)));
}

// ---------- 5. adaptor Express rute akun ----------

{
  const app = express();
  app.use(express.json());
  app.use("/api", accountsRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: "tidak ditemukan (app)" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const list = await call("GET", "/accounts");
  const views = list.body.accounts as Array<{ provider: string; engine: string; state: string }>;
  check(
    "K2 GET /accounts: view library + engine",
    list.status === 200 && views.map((view) => `${view.provider}:${view.engine}`).join() === "claude:claude,gemini:antigravity",
    list,
  );
  const unknown = await call("POST", "/accounts/openai/login");
  check("K3 provider tidak dikenal → 404", unknown.status === 404 && unknown.body.error === "penyedia akun tidak dikenal", unknown);
  const code = await call("POST", "/accounts/claude/login/code", { code: "x" });
  check("K4 kode tanpa login berjalan → 400", code.status === 400 && /tidak ada login/.test(String(code.body.error)), code);
  const gemini = await call("POST", "/accounts/gemini/login");
  check("K5 login Gemini tanpa agy → 409 dengan alasannya", gemini.status === 409 && /tidak ditemukan/.test(String(gemini.body.error)), gemini);
  const closed = await call("DELETE", "/accounts/claude/login");
  check("K6 tutup login → account + engine", closed.status === 200 && (closed.body.account as { engine?: string }).engine === "claude", closed);
  const other = await call("GET", "/lain");
  check("K7 rute lain diteruskan ke app", other.status === 404 && other.body.error === "tidak ditemukan (app)", other);
  await new Promise((resolve) => server.close(resolve));
}

offChanges();
rmSync(sandbox, { recursive: true, force: true });
console.log(failed === 0 ? "\nSemua uji akun lulus." : `\n${failed} uji akun GAGAL.`);
process.exit(failed === 0 ? 0 : 1);
