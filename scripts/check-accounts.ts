/**
 * Uji akun AI milik app: alur login (proses CLI palsu), penyimpanan akun, mesin mengikuti akun,
 * pagar scheduler, env Claude, dan salinan transkrip sesi dari ~/.claude.
 * Deterministik, tanpa model, tanpa `claude`/`agy` sungguhan: bun run check:accounts
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-accounts-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
// agy sengaja tidak ada: akun Gemini harus terbaca "tidak bisa dipakai di mesin ini".
process.env.AGY_BIN = "agy-tidak-ada-di-uji";
delete process.env.AGY_DIR;
process.env.ANTHROPIC_API_KEY = "kunci-yang-harus-dibuang";
mkdirSync(process.env.WORKSPACE_DIR, { recursive: true });

const { CONFIG } = await import("../server/config.ts");
const { LoginFlow, findLoginUrl, safeMessage, validLoginCode } = await import("../server/accounts/login.ts");
const { CLAUDE_LOGIN_HOSTS, claudeEnv, claudeLoginSpec, migrateClaudeSessions, isClaudeAuthError } = await import(
  "../server/accounts/claude.ts"
);
const store = await import("../server/accounts/store.ts");
const accounts = await import("../server/accounts/index.ts");
const { createTask, patchAssignment, getTask, updateTask } = await import("../server/tasks.ts");
const { scheduler } = await import("../server/agent/scheduler.ts");
const { bus } = await import("../server/agent/bus.ts");
import type { LoginSpec, LoginVerdict } from "../server/accounts/login.ts";
import type { StoredEvent } from "../server/types.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- proses CLI palsu ----------

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  written = "";
  killed: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written += chunk.toString("utf8");
    });
  }
  print(text: string): void {
    this.stdout.write(text);
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

function harness(timeoutMs?: number) {
  const children: FakeChild[] = [];
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  let changes = 0;
  const flow = new LoginFlow(
    () => {
      changes += 1;
    },
    {
      timeoutMs,
      spawn: (command, args, options) => {
        const child = new FakeChild();
        children.push(child);
        spawned.push({ command, args, env: options.env });
        return child as unknown as ChildProcess;
      },
    },
  );
  return { flow, children, spawned, changes: () => changes };
}

const SPEC: LoginSpec = { command: "claude", args: ["auth", "login"], env: {}, cwd: sandbox, urlHosts: CLAUDE_LOGIN_HOSTS };
const LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";

// Tidak ada yang boleh mencetak URL, kode, atau output CLI selama alur login.
const printed: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
function muteConsole(): void {
  for (const key of ["log", "warn", "error"] as const) {
    console[key] = (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    };
  }
}
function restoreConsole(): void {
  Object.assign(console, original);
}

// ---------- 1. LoginFlow ----------

{
  muteConsole();
  const h = harness();
  let verifiedWith = "";
  h.flow.start(SPEC, async (output) => {
    verifiedWith = output;
    return { ok: true };
  });
  const startPhase = h.flow.view()?.phase;
  h.children[0]?.print("Opening browser…\nhttps://evil.example.com/login?x=1\n");
  await tick();
  const afterForeign = h.flow.view();
  h.children[0]?.print(`If the browser didn't open, visit: ${LOGIN_URL}\nPaste code here if prompted > `);
  await tick();
  const awaiting = h.flow.view();
  let doubleStart = "";
  try {
    h.flow.start(SPEC, async () => ({ ok: true }));
  } catch (error) {
    doubleStart = (error as Error).message;
  }
  let badCode = "";
  try {
    h.flow.submitCode("baris1\nbaris2");
  } catch (error) {
    badCode = (error as Error).message;
  }
  h.flow.submitCode("  kode-rahasia#state  ");
  const verifying = h.flow.view()?.phase;
  h.children[0]?.print("Login successful.\n");
  h.children[0]?.exit(0);
  await tick();
  const done = h.flow.view();
  restoreConsole();

  check("A1 login dimulai di fase starting", startPhase === "starting", startPhase);
  check("A2 URL dari host asing diabaikan", afterForeign?.phase === "starting" && !afterForeign.url, afterForeign);
  check("A3 URL dari host Claude → awaiting_code", awaiting?.phase === "awaiting_code" && awaiting.url === LOGIN_URL, awaiting);
  check("A4 login kedua saat berjalan ditolak", /sedang berjalan/.test(doubleStart), doubleStart);
  check("A5 kode multi-baris ditolak dan tidak dikirim", /tidak valid/.test(badCode) && !h.children[0]?.written.includes("baris1"), badCode);
  check("A6 kode dipangkas dan ditulis ke stdin + newline", h.children[0]?.written === "kode-rahasia#state\n", h.children[0]?.written);
  check("A7 setelah kode → verifying", verifying === "verifying", verifying);
  check("A8 CLI keluar 0 → verify → done", done?.phase === "done" && verifiedWith.includes("Login successful"), done);
  check("A9 URL login dibuang setelah selesai", done?.url === undefined, done);
  check("A10 tidak ada log selama login", printed.length === 0, printed);
  check("A11 hanya satu proses yang dijalankan", h.children.length === 1, h.children.length);
}

{
  const h = harness();
  h.flow.start(SPEC, async () => ({ ok: true }));
  h.children[0]?.print(`${LOGIN_URL}\n`);
  await tick();
  h.flow.submitCode("kode-salah");
  h.children[0]?.print("OAuth error: invalid_grant abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n");
  h.children[0]?.exit(1);
  await tick();
  const view = h.flow.view();
  check("B1 CLI keluar ≠ 0 saat verifikasi → failed, kode ditolak", view?.phase === "failed" && /Kode ditolak/.test(view.error ?? ""), view);
  check("B2 pesan galat tanpa token panjang", !/abcdefghijklmnopqrstuvwxyz0123456789/.test(view?.error ?? ""), view?.error);
  // Setelah gagal, login baru boleh dimulai.
  let restarted = true;
  try {
    h.flow.start(SPEC, async () => ({ ok: true }));
  } catch {
    restarted = false;
  }
  check("B3 setelah gagal, login baru boleh dimulai", restarted && h.children.length === 2 && h.flow.view()?.phase === "starting");
  h.flow.cancel();
  check("B4 batal → cancelled dan proses dihentikan", h.flow.view()?.phase === "cancelled" && (h.children[1]?.killed.length ?? 0) === 1, h.children[1]?.killed);
  h.flow.clear();
  check("B5 clear melupakan status", h.flow.view() === undefined);
}

{
  const h = harness(40);
  h.flow.start(SPEC, async () => ({ ok: true }));
  h.children[0]?.print(`${LOGIN_URL}\n`);
  await tick(80);
  const view = h.flow.view();
  check("C1 waktu habis → failed dan proses dihentikan", view?.phase === "failed" && /Waktu login habis/.test(view.error ?? "") && (h.children[0]?.killed.length ?? 0) === 1, view);
  let late = "";
  try {
    h.flow.submitCode("terlambat");
  } catch (error) {
    late = (error as Error).message;
  }
  check("C2 kode setelah waktu habis ditolak", /tidak ada login/.test(late), late);
}

{
  const h = harness();
  const verdict: LoginVerdict = { ok: false, error: "Claude Code belum mencatat login." };
  h.flow.start(SPEC, async () => verdict);
  h.children[0]?.print(`${LOGIN_URL}\n`);
  await tick();
  h.flow.submitCode("kode");
  h.children[0]?.exit(0);
  await tick();
  const view = h.flow.view();
  check("D1 verifikasi menolak → failed dengan alasannya", view?.phase === "failed" && view.error === verdict.error, view);
}

{
  const h = harness();
  h.flow.start(SPEC, async () => ({ ok: true }));
  h.children[0]?.exit(1);
  await tick();
  const view = h.flow.view();
  check("D2 CLI berhenti sebelum URL → failed", view?.phase === "failed" && /berhenti sebelum selesai/.test(view.error ?? ""), view);
}

check("E1 findLoginUrl: host persis, bukan akhiran", findLoginUrl("https://claude.com.evil.io/x https://notclaude.com/y", CLAUDE_LOGIN_HOSTS) === undefined);
check("E2 findLoginUrl: hanya https", findLoginUrl("http://claude.com/x", CLAUDE_LOGIN_HOSTS) === undefined);
check("E3 findLoginUrl: Google untuk Gemini", findLoginUrl("buka https://accounts.google.com/o/oauth2/auth?x=1", ["accounts.google.com"])?.startsWith("https://accounts.google.com/") === true);
check("E4 safeMessage membuang URL", !(safeMessage(`gagal ${LOGIN_URL}\n`) ?? "").includes("https://"), safeMessage(`gagal ${LOGIN_URL}`));
check("E5 kode: kosong, terlalu panjang, NUL ditolak", !validLoginCode("") && !validLoginCode("x".repeat(5000)) && !validLoginCode("a\0b") && validLoginCode("abc#def"));
check(
  "E6 galat login Claude dikenali, galat lain tidak",
  isClaudeAuthError("Invalid API key · Please run /login") &&
    isClaudeAuthError("authentication_failed") &&
    !isClaudeAuthError("rate limit reached") &&
    !isClaudeAuthError("model not found: authentication module"),
);

// ---------- 2. env & spec Claude ----------

{
  const env = claudeEnv();
  check("F1 CLAUDE_CONFIG_DIR menunjuk folder akun app", env.CLAUDE_CONFIG_DIR === join(sandbox, "accounts", "claude"), env.CLAUDE_CONFIG_DIR);
  check("F2 API key dibuang dari env agen", env.ANTHROPIC_API_KEY === undefined && env.ANTHROPIC_AUTH_TOKEN === undefined && env.CLAUDE_CODE_OAUTH_TOKEN === undefined);
  const spec = claudeLoginSpec();
  check("F3 login memakai claude auth login --claudeai", spec.command === "claude" && spec.args.join(" ") === "auth login --claudeai", spec.args);
  check(
    "F4 login tidak membuka browser dari server",
    spec.env.BROWSER === "/bin/true" && spec.env.DISPLAY === undefined && spec.env.CLAUDE_CONFIG_DIR === CONFIG.claudeDir,
  );
}

// ---------- 3. mesin mengikuti akun ----------

const changes: number[] = [];
const offChanges = store.onAccountsChanged(() => changes.push(Date.now()));

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
  store.saveAccount("claude", { addedAt: new Date().toISOString(), email: "uji@example.com", plan: "Max", status: "ok", checkedAt: new Date().toISOString() });
  const view = accounts.accountView("claude");
  check("I1 akun tersimpan → state ok", view.state === "ok" && view.email === "uji@example.com" && view.plan === "Max", view);
  check("I2 Claude bisa dipakai, Gemini tetap tidak", accounts.engineUsable("claude").ok && accounts.usableEngines().join() === "claude", accounts.usableEngines());
  check("I3 perubahan akun memicu event", changes.length >= 1, changes.length);
  const onDisk = JSON.parse(readFileSync(join(sandbox, "accounts.json"), "utf8")) as { accounts: Record<string, unknown> };
  check("I4 accounts.json hanya metadata", Boolean(onDisk.accounts.claude) && !JSON.stringify(onDisk).includes("token"), onDisk);
  check("I5 accounts.json hanya untuk user ini (0600)", (statSync(join(sandbox, "accounts.json")).mode & 0o077) === 0);

  store.patchAccount("claude", { status: "error", error: "jaringan putus" });
  check("I6 status error (bukan login) tidak memblokir", accounts.engineUsable("claude").ok);

  accounts.markAccountExpired("claude", "authentication_failed");
  const expired = accounts.engineUsable("claude");
  check("I7 login kedaluwarsa memblokir dengan ajakan login ulang", !expired.ok && /login ulang/.test(expired.reason ?? ""), expired);

  const task = createTask({ title: "uji kedaluwarsa", description: "uji", role: "qa", projectId: "P-uji" });
  check("I8 blockedReason ikut kedaluwarsa", /login ulang/.test(scheduler.blockedReason(task) ?? ""));
  updateTask(task.id, { status: "cancelled" });

  store.removeAccount("claude");
  check("I9 akun dihapus → kembali none", accounts.accountView("claude").state === "none");
}

{
  const dir = store.ensureAccountDir("claude");
  check("I10 folder akun dibuat 0700", existsSync(dir) && (statSync(dir).mode & 0o077) === 0 && (statSync(CONFIG.accountsDir).mode & 0o077) === 0);
}

// ---------- 4. salinan transkrip sesi dari ~/.claude ----------

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

offChanges();
rmSync(sandbox, { recursive: true, force: true });
console.log(failed === 0 ? "\nSemua uji akun lulus." : `\n${failed} uji akun GAGAL.`);
process.exit(failed === 0 ? 0 : 1);
