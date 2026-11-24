/**
 * Uji akun AI milik app di AI Team: env Claude, mesin mengikuti akun, pagar scheduler, salinan
 * transkrip sesi dari ~/.claude, folder rahasia terlindung, adaptor Express rute akun, dan gateway Claude
 * (base URL + token, dengan gateway palsu lokal).
 * Alur login, store, dan provider diuji di library ai-agent-auth (`bun test` di sana).
 * Deterministik, tanpa model, tanpa `claude`/`agy` sungguhan: bun run check:accounts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const { auth, claudeEnv, claudeSettings } = accounts;
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

/** Jalankan `apiKeyHelper` sesi Claude seperti CLI menjalankannya (lewat /bin/sh); undefined = tidak ada helper. */
function helperRun(): { status: number | null; stdout: string; stderr: string } | undefined {
  const command = claudeSettings().apiKeyHelper;
  if (!command) return undefined;
  const run = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
const helperToken = (): string | undefined => {
  const run = helperRun();
  return run?.status === 0 ? run.stdout : undefined;
};

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

// ---------- 6. gateway Claude (base URL + token, seperti claude-gw) ----------

{
  const gw = await import("../server/accounts/gateway.ts");
  const GOOD = "token-gateway-uji-1234567890";
  let accepted = GOOD;
  const fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/models") return Response.json({ error: "tidak ada" }, { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${accepted}`) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ data: [{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" }, { id: "claude-haiku-5-5" }] });
    },
  });
  const baseUrl = `http://127.0.0.1:${fake.port}`;
  const claudeView = () => accounts.accountView("claude");

  check("L1 tanpa gateway: claudeSource oauth, gateway kosong", claudeView().gateway === undefined && claudeView().claudeSource === "oauth", claudeView());

  const wrong = await accounts.saveClaudeGateway({ baseUrl, token: "token-salah-000000000000" });
  check("L2 token salah ditolak, tidak ada yang tersimpan", !wrong.ok && wrong.status === 400 && /ditolak/.test(wrong.error) && !existsSync(gw.gatewayFile()), wrong);
  const scheme = await accounts.saveClaudeGateway({ baseUrl: "ftp://127.0.0.1", token: GOOD });
  check("L3 base URL bukan http(s) ditolak", !scheme.ok && scheme.status === 400, scheme);
  const normalized = gw.normalizeBaseUrl(`${baseUrl}/v1/`);
  check("L4 base URL dinormalisasi tanpa /v1 dan garis miring", normalized.ok && normalized.url === baseUrl, normalized);
  const unreachable = await gw.probeGateway("http://127.0.0.1:1", GOOD, 2_000);
  check("L5 gateway tak terjangkau: galat jaringan, bukan token", !unreachable.ok && !unreachable.auth, unreachable);

  const before = changes.length;
  const saved = await accounts.saveClaudeGateway({ baseUrl: `${baseUrl}/`, token: GOOD, activate: false });
  check("L6 token benar tersimpan", saved.ok && saved.created, saved);
  check("L7 berkas gateway 0600 dan terlindung dari agen", (statSync(gw.gatewayFile()).mode & 0o077) === 0 && protectedDirs().some((dir) => gw.gatewayFile().startsWith(`${dir}${sep}`)));
  check("L8 gateway pertama memicu salinan transkrip sesi", store.migrationDone("claude-sessions-from-home"));
  check("L9 menyimpan memicu event accounts_changed", changes.length > before, changes.length - before);
  const view = claudeView();
  check(
    "L10 view: host, petunjuk token, dan model tanpa token",
    view.gateway?.state === "ok" && view.gateway.host === `127.0.0.1:${fake.port}` && view.gateway.tokenHint === "…7890" &&
      view.gateway.models.map((model) => model.id).join() === "claude-opus-5,claude-haiku-5-5" && !JSON.stringify(view).includes(GOOD),
    view,
  );
  check(
    "L11 belum aktif: env Claude tanpa gateway, tanpa apiKeyHelper",
    claudeEnv().ANTHROPIC_AUTH_TOKEN === undefined && claudeEnv().ANTHROPIC_BASE_URL === undefined && claudeSettings().apiKeyHelper === undefined,
  );
  check("L12 belum aktif: Claude tetap butuh login claude.ai", !accounts.engineUsable("claude").ok);

  check("L13 jadikan gateway akun aktif", accounts.setClaudeSource("gateway") && claudeView().claudeSource === "gateway");
  const env = claudeEnv();
  check(
    "L14 aktif: env berisi base URL saja, folder sesi sama",
    env.ANTHROPIC_BASE_URL === baseUrl && env.CLAUDE_CONFIG_DIR === CONFIG.claudeDir,
    { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR },
  );
  // Token di env bocor ke Bash bot (printenv, /proc/<pid>/environ). Mode SCRUB, yang dulu menyembunyikannya,
  // membuat stub .env.local 0 byte di workspace (MissingAppKeyException di EWS) dan menjebol argumen bwrap.
  check(
    "L14a aktif: token gateway dan SCRUB tidak pernah ada di env",
    env.ANTHROPIC_AUTH_TOKEN === undefined && env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === undefined && !Object.values(env).includes(GOOD),
    Object.keys(env).filter((key) => /ANTHROPIC|SCRUB/.test(key)),
  );
  const helper = claudeSettings().apiKeyHelper ?? "";
  check("L14b aktif: apiKeyHelper mencetak token gateway", helperToken() === GOOD, helperRun()?.stderr);
  check("L14c perintah apiKeyHelper hanya memuat path, bukan token", helper !== "" && !helper.includes(GOOD) && helper.includes(gw.gatewayFile()), helper);
  check("L15 aktif: API key dari shell tetap dibuang", env.ANTHROPIC_API_KEY === undefined && env.CLAUDE_CODE_OAUTH_TOKEN === undefined);
  check("L16 env /usage claude.ai tidak pernah berisi token gateway", accounts.claudeOAuthEnv().ANTHROPIC_AUTH_TOKEN === undefined && accounts.claudeOAuthEnv().ANTHROPIC_BASE_URL === undefined);
  check(
    "L17 tanpa login claude.ai, Claude bisa dipakai lewat gateway",
    accounts.engineUsable("claude").ok && accounts.usableEngines().join() === "claude" && accounts.engineAccount("claude").models.length === 2,
    accounts.usableEngines(),
  );

  const edited = await accounts.saveClaudeGateway({ baseUrl, token: "" });
  check("L18 ubah tanpa token: token lama dipakai, tetap aktif", edited.ok && !edited.created && helperToken() === GOOD && claudeView().claudeSource === "gateway", edited);

  store.save("claude", { addedAt: new Date().toISOString(), email: "uji@example.com", status: "ok", checkedAt: new Date().toISOString() });
  accounts.markAccountExpired("claude", "authentication_failed");
  check("L19 galat login saat gateway aktif menandai gateway, bukan claude.ai", claudeView().gateway?.state === "expired" && store.get("claude")?.status === "ok", claudeView());
  const blocked = accounts.engineUsable("claude");
  check("L20 gateway kedaluwarsa memblokir dengan ajakan memperbarui token", !blocked.ok && /gateway/.test(blocked.reason ?? ""), blocked);
  await accounts.checkAccount("claude", true);
  check("L21 Periksa memulihkan gateway yang tokennya diterima", claudeView().gateway?.state === "ok", claudeView().gateway);
  accepted = "token-baru-di-gateway-00000";
  await gw.checkGateway(true);
  check("L22 token diganti di gateway: pemeriksaan menandai expired", claudeView().gateway?.state === "expired" && /401/.test(claudeView().gateway?.reason ?? ""), claudeView().gateway);
  accepted = GOOD;
  await gw.checkGateway(true);

  // adaptor Express: rute gateway sebelum rute library
  const app = express();
  app.use(express.json());
  app.use("/api", accountsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as { account?: { gateway?: unknown; claudeSource?: string }; error?: string; accounts?: unknown } };
  };
  const list = await call("GET", "/accounts");
  check("M1 GET /accounts membawa gateway tanpa token", list.status === 200 && list.text.includes("tokenHint") && !list.text.includes(GOOD), list.status);
  const bad = await call("PUT", "/accounts/claude/gateway", { baseUrl, token: "token-salah-000000000000" });
  check("M2 PUT token salah → 400, gateway lama tetap", bad.status === 400 && helperToken() === GOOD, bad.body);
  const put = await call("PUT", "/accounts/claude/gateway", { baseUrl, token: GOOD });
  check("M3 PUT token benar → account tanpa token", put.status === 200 && Boolean(put.body.account?.gateway) && !put.text.includes(GOOD), put.status);
  const bogus = await call("POST", "/accounts/claude/source", { source: "lain" });
  check("M4 source tidak dikenal → 400", bogus.status === 400, bogus.body);
  const oauth = await call("POST", "/accounts/claude/source", { source: "oauth" });
  check(
    "M5 source oauth → claude.ai dipakai, tanpa base URL dan apiKeyHelper gateway",
    oauth.status === 200 && oauth.body.account?.claudeSource === "oauth" && claudeEnv().ANTHROPIC_BASE_URL === undefined && claudeSettings().apiKeyHelper === undefined,
    oauth.body,
  );
  const checked = await call("POST", "/accounts/claude/gateway/check");
  check("M6 periksa gateway → 200", checked.status === 200, checked.body);
  await call("POST", "/accounts/claude/source", { source: "gateway" });
  const removed = await call("DELETE", "/accounts/claude/gateway");
  check(
    "M7 hapus gateway aktif → kembali ke claude.ai, berkas hilang",
    removed.status === 200 && removed.body.account?.gateway === undefined && removed.body.account?.claudeSource === "oauth" && !existsSync(gw.gatewayFile()) &&
      claudeEnv().ANTHROPIC_BASE_URL === undefined && claudeSettings().apiKeyHelper === undefined,
    removed.body,
  );
  const orphan = await call("POST", "/accounts/claude/source", { source: "gateway" });
  check("M8 pilih gateway yang belum ada → 409", orphan.status === 409, orphan.body);
  const missing = await call("POST", "/accounts/claude/gateway/check");
  check("M9 periksa gateway yang belum ada → 404", missing.status === 404, missing.body);
  await new Promise((resolve) => server.close(resolve));
  store.remove("claude");
  fake.stop(true);
}

// ---------- apiKeyHelper gagal tanpa membocorkan isi berkas ----------

{
  const { GATEWAY_KEY_SCRIPT } = await import("../server/accounts/gateway.ts");
  const runKey = (file: string) => spawnSync(process.execPath, [GATEWAY_KEY_SCRIPT, file], { encoding: "utf8" });
  const missing = runKey(join(sandbox, "tidak-ada.json"));
  check("N1 helper: berkas hilang → kode 1, tanpa token", missing.status === 1 && missing.stdout === "", missing.stderr);
  const broken = join(sandbox, "rusak.json");
  writeFileSync(broken, "{rahasia-yang-tidak-boleh-dikutip", { mode: 0o600 });
  const bad = runKey(broken);
  check("N2 helper: JSON rusak → kode 1, isi berkas tidak dikutip", bad.status === 1 && bad.stdout === "" && !bad.stderr.includes("rahasia"), bad.stderr);
  const empty = join(sandbox, "kosong.json");
  writeFileSync(empty, JSON.stringify({ baseUrl: "http://x", token: "" }), { mode: 0o600 });
  check("N3 helper: token kosong → kode 1", runKey(empty).status === 1);
}

// ---------- setiap sesi Claude memasang env dan apiKeyHelper berpasangan ----------

{
  // Base URL gateway tanpa apiKeyHelper = CLI mengirim token login claude.ai ke gateway.
  const root = new URL("../server/", import.meta.url).pathname;
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
  const unpaired = files.filter((file) => {
    const text = readFileSync(join(root, file), "utf8");
    return /\bclaudeEnv\(\)/.test(text) && !/\bclaudeSettings\(\)/.test(text) && !file.startsWith(`accounts${sep}`);
  });
  check("O1 setiap pemakai claudeEnv() juga memasang claudeSettings()", unpaired.length === 0, unpaired);
}

offChanges();
rmSync(sandbox, { recursive: true, force: true });
console.log(failed === 0 ? "\nSemua uji akun lulus." : `\n${failed} uji akun GAGAL.`);
process.exit(failed === 0 ? 0 : 1);
