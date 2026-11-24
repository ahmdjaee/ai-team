import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "../config.ts";
import { ensureAgyConfig } from "../engines/antigravity/process.ts";
import { ARTIFACT_TOOLS, DENY_ALWAYS } from "../roles.ts";
import type { ProviderId } from "../types.ts";
import { accountView, claudeOAuthEnv, geminiEnv } from "./index.ts";

/**
 * Pemakaian langganan tiap agen, diambil dari agennya sendiri lalu ditampilkan ulang apa adanya
 * di Pengaturan → Akun AI. App tidak menghitung atau menambah jendela kuota sendiri.
 *
 * - Claude: data di balik `/usage` Claude Code (control request SDK, tanpa panggilan model).
 * - Gemini: `agy -p /usage`, yang dijawab CLI secara lokal. Jangan kirim `/usage` lewat sesi ACP:
 *   di sana teksnya diteruskan ke model dan memakan kuota.
 */

/** Satu jendela kuota seperti dilaporkan agen. */
export type UsageWindow = {
  id: string;
  /** Kelompok model dari agen (agy: "Gemini Models", "Claude and GPT models", …). */
  group?: string;
  label: string;
  /** Persen terpakai 0–100; null kalau agen tidak menyebut angkanya. */
  usedPercent: number | null;
  resetsAt?: string;
  /** Tingkat dari agen (Claude: `severity`, mis. "normal"). */
  severity?: string;
};

export type AgentUsage = {
  provider: ProviderId;
  /** Nama agen sumber data, untuk teks "dari …". */
  source: string;
  checkedAt: string;
  windows: UsageWindow[];
  /** Agen menjawab tapi tidak melaporkan kuota (mis. login kunci API). */
  note?: string;
  /** Pemakaian gagal dibaca (agen tidak menjawab, keluaran tak dikenal). */
  error?: string;
};

const CACHE_MS = 60_000;
const CLAUDE_TIMEOUT_MS = 30_000;
const AGY_TIMEOUT_MS = 30_000;
/** Jeda SIGTERM → SIGKILL untuk process group yang tidak mau berhenti. */
const KILL_GRACE_MS = 2_000;
/** Setelah proses keluar, tunggu pipe tertutup sebentar; yang masih memegangnya adalah proses anak yang tertinggal. */
const CLOSE_GRACE_MS = 500;
/**
 * Batas keras satu pembacaan, di atas timeout tiap agen: keyring pribadi Gemini bisa butuh ~10 detik
 * untuk menyala. Menjamin `inflight` selalu selesai, jadi endpoint tidak pernah ikut menggantung.
 */
const DEADLINE_SLACK_MS = 15_000;
const SOURCE: Record<ProviderId, string> = { claude: "Claude Code", gemini: "Antigravity (agy)" };

// ---------- Claude ----------

/**
 * Sesi Claude untuk membaca `/usage`: tidak pernah mengirim prompt dan tanpa tool. Seperti sesi app
 * lain, Artifact dan konektor claude.ai ditolak lewat `DENY_ALWAYS` dan disembunyikan lewat
 * `disallowedTools` (lihat CLAUDE.md proyek).
 */
export function usageQueryOptions(abort: AbortController): Options {
  return {
    cwd: tmpdir(),
    settingSources: [],
    settings: { permissions: { allow: [], ask: [], deny: [...DENY_ALWAYS] } },
    tools: [],
    allowedTools: [],
    disallowedTools: ["*", ...ARTIFACT_TOOLS],
    canUseTool: async () => ({ behavior: "deny", message: "Pembaca pemakaian tidak memakai tool." }),
    persistSession: false,
    abortController: abort,
    // Kuota langganan claude.ai, walau bot sedang memakai gateway: gateway tidak melaporkan kuota.
    env: claudeOAuthEnv(),
  };
}

/** Prompt yang tidak pernah mengirim pesan: subprocess cukup untuk control request, tanpa panggilan model. */
async function* silent(signal: AbortSignal): AsyncGenerator<never> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const lastLine = (value: string): string | undefined => value.trim().split("\n").at(-1)?.trim().slice(0, 200) || undefined;
/** Persen 0–100, dibulatkan. 100 hanya kalau memang habis: sisa 0,4% tidak boleh tertulis "habis". */
const percent = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 100) return 100;
  return Math.max(0, Math.min(99, Math.round(value)));
};

function claudeLimitLabel(kind: string, scope: unknown): string {
  const scoped = isObject(scope)
    ? (text(isObject(scope.model) ? scope.model.display_name : undefined) ?? text(isObject(scope.surface) ? scope.surface.display_name : undefined))
    : undefined;
  if (kind === "weekly_all") return "Mingguan · semua model";
  if (kind.startsWith("weekly")) return scoped ? `Mingguan · ${scoped}` : "Mingguan";
  if (kind === "five_hour" || kind.startsWith("session")) return scoped ? `Sesi 5 jam · ${scoped}` : "Sesi 5 jam";
  return scoped ? `${kind} · ${scoped}` : kind;
}

const CLAUDE_WINDOWS: Array<[key: string, label: string]> = [
  ["five_hour", "Sesi 5 jam"],
  ["seven_day", "Mingguan · semua model"],
  ["seven_day_opus", "Mingguan · Opus"],
  ["seven_day_sonnet", "Mingguan · Sonnet"],
];

/** `rate_limits.limits[]`: daftar yang dirender `/usage`. */
function claudeListedWindows(limits: Json): UsageWindow[] {
  if (!Array.isArray(limits.limits)) return [];
  const windows: UsageWindow[] = [];
  limits.limits.forEach((item, index) => {
    if (!isObject(item)) return;
    const kind = text(item.kind) ?? `limit_${index}`;
    windows.push({
      id: `${kind}:${index}`,
      label: claudeLimitLabel(kind, item.scope),
      usedPercent: percent(item.percent ?? item.utilization),
      resetsAt: text(item.resets_at),
      severity: text(item.severity),
    });
  });
  return windows;
}

/** Jendela bernama (`five_hour`, `seven_day`, …) yang bukan null, lalu `model_scoped[]`. */
function claudeNamedWindows(limits: Json): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [key, label] of CLAUDE_WINDOWS) {
    const window = limits[key];
    if (!isObject(window)) continue;
    windows.push({ id: key, label, usedPercent: percent(window.utilization), resetsAt: text(window.resets_at) });
  }
  if (Array.isArray(limits.model_scoped)) {
    limits.model_scoped.forEach((item, index) => {
      if (!isObject(item)) return;
      const name = text(item.display_name) ?? "model";
      windows.push({ id: `model_scoped:${index}`, label: `Mingguan · ${name}`, usedPercent: percent(item.utilization), resetsAt: text(item.resets_at) });
    });
  }
  return windows;
}

/**
 * Respons `/usage` Claude Code → jendela kuota, urut seperti dilaporkan. Yang dipakai `rate_limits.limits[]`;
 * kalau daftar itu tidak ada atau kosong, jendela bernama.
 */
export function mapClaudeUsage(response: unknown): Pick<AgentUsage, "windows" | "note"> {
  const unavailable = { windows: [], note: "Claude Code tidak melaporkan batas pemakaian untuk login ini." };
  if (!isObject(response) || response.rate_limits_available === false || !isObject(response.rate_limits)) return unavailable;
  const listed = claudeListedWindows(response.rate_limits);
  const windows = listed.length ? listed : claudeNamedWindows(response.rate_limits);
  return windows.length ? { windows } : unavailable;
}

async function claudeUsage(): Promise<Pick<AgentUsage, "windows" | "note">> {
  const abort = new AbortController();
  const stop = new AbortController();
  const instance = query({ prompt: silent(stop.signal), options: usageQueryOptions(abort) });
  const timer = setTimeout(() => abort.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const response = await instance.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return mapClaudeUsage(response);
  } finally {
    clearTimeout(timer);
    stop.abort();
    try {
      instance.close();
    } catch {
      // proses mungkin sudah berhenti
    }
  }
}

// ---------- Gemini (agy) ----------

function agyWindowLabel(raw: string): string {
  if (/five\s*hour|5\s*hour/i.test(raw)) return "Sesi 5 jam";
  if (/weekly/i.test(raw)) return "Mingguan";
  if (/daily/i.test(raw)) return "Harian";
  if (/monthly/i.test(raw)) return "Bulanan";
  return raw.replace(/\s*remaining$/i, "");
}

/**
 * Keluaran `agy -p /usage`: satu baris per jendela, dipisah tab — grup, nama jendela, persen *sisa*,
 * waktu reset. Persen sisa dibalik jadi persen terpakai supaya sama dengan Claude.
 */
export function parseAgyUsage(stdout: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const line of stdout.split("\n")) {
    const cols = line.split("\t").map((col) => col.trim());
    if (cols.length < 3) continue;
    const [group, name, shown, reset] = cols;
    const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(shown ?? "");
    if (!group || !name || !match) continue;
    const value = Number(match[1]);
    // Kolomnya sisa ("Weekly Limit Remaining", "… Weekly Limit"); hanya yang jelas "used" dibaca apa adanya.
    const used = /used/i.test(name) && !/remaining/i.test(name) ? value : 100 - value;
    windows.push({
      id: `${group}:${name}`,
      group,
      label: agyWindowLabel(name),
      usedPercent: percent(used),
      resetsAt: reset && !Number.isNaN(Date.parse(reset)) ? reset : undefined,
    });
  }
  return windows;
}

/**
 * Folder HOME khusus untuk `agy -p`: mode print tidak mengenal `--gemini-dir` dan menulis log serta
 * state ke `$HOME/.gemini`. Login tetap dari keyring pribadi app (`geminiEnv`), jadi yang terbaca
 * akun Gemini app, sedangkan `~/.gemini` milik agy di terminal tidak tersentuh.
 */
export function agyUsageHome(): string {
  return join(CONFIG.antigravity.dir, "usage-home");
}

export type GroupResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Kirim sinyal ke seluruh process group (agy bisa memulai proses anak sendiri). */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // group sudah tidak ada
  }
}

/**
 * Jalankan perintah singkat (`agy -p /usage`) di process group sendiri. Saat timeout seluruh group
 * dimatikan (SIGTERM, lalu SIGKILL), dan hasil tidak menunggu pipe tertutup selamanya: proses anak yang
 * tertinggal dan masih memegang stdout dimatikan juga. Promise ini selalu selesai, tidak pernah melempar.
 * `runCommand` dari ai-agent-auth tidak cukup: `execFile` hanya mematikan prosesnya sendiri dan
 * menunggu pipe tertutup.
 */
export function runInGroup(
  bin: string,
  args: string[],
  options: { env?: Record<string, string | undefined>; cwd?: string; timeoutMs: number },
): Promise<GroupResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let pid: number | undefined;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      // Group ini hanya milik perintah ini: sisa proses anaknya ikut dibereskan.
      signalGroup(pid, "SIGTERM");
      resolve({ code, stdout, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv | undefined, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      stderr = (error as Error).message;
      done(null);
      return;
    }
    pid = child.pid;
    timer = setTimeout(() => {
      timedOut = true;
      signalGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup(pid, "SIGKILL");
        done(null);
      }, KILL_GRACE_MS);
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      stderr += error.message;
      done(null);
    });
    child.once("close", (code) => done(code));
    // Proses sudah keluar tapi pipe belum tertutup: proses anak yang tertinggal masih memegangnya.
    child.once("exit", (code) => {
      closeTimer = setTimeout(() => done(code), CLOSE_GRACE_MS);
    });
  });
}

async function geminiUsage(): Promise<Pick<AgentUsage, "windows" | "error">> {
  const home = agyUsageHome();
  const geminiDir = join(home, ".gemini");
  mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
  // Pagar yang sama dengan sesi bot (hooks.json, swarm mati). Tanpa token AI Team, hook menolak semua tool.
  ensureAgyConfig(geminiDir);
  const env = { ...(await geminiEnv()), HOME: home, AI_TEAM_HOOK_URL: undefined, AI_TEAM_HOOK_TOKEN: undefined };
  const result = await runInGroup(CONFIG.antigravity.bin, ["-p", "/usage"], { env, cwd: home, timeoutMs: AGY_TIMEOUT_MS });
  const windows = parseAgyUsage(result.stdout);
  if (windows.length) return { windows };
  const detail = result.timedOut
    ? `tidak menjawab dalam ${AGY_TIMEOUT_MS / 1000} detik`
    : (lastLine(result.stderr || result.stdout) ?? (result.code === 0 ? "keluarannya kosong" : `berhenti (kode ${result.code ?? "?"})`));
  return { windows: [], error: `agy tidak melaporkan pemakaian: ${detail}` };
}

// ---------- cache ----------

/** Tolak dengan `message` kalau `promise` belum selesai dalam `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Cache dan pembacaan yang berjalan dicatat per akun, supaya kuota akun lama tidak tampil setelah ganti akun. */
const cache = new Map<ProviderId, { identity: string; usage: AgentUsage }>();
const inflight = new Map<ProviderId, { identity: string; promise: Promise<AgentUsage> }>();

/** Penanda akun yang sedang login: keluar menghapus akunnya (`addedAt` baru), ganti akun mengubah email. */
function accountIdentity(provider: ProviderId): string {
  const view = accountView(provider);
  return `${view.addedAt ?? ""}|${view.email ?? ""}`;
}

/** Akun yang loginnya masih ada; yang belum ditambahkan atau perlu login ulang tidak dibaca. */
export function usageReadable(provider: ProviderId): boolean {
  const state = accountView(provider).state;
  return state === "ok" || state === "error";
}

async function read(provider: ProviderId): Promise<AgentUsage> {
  const checkedAt = new Date().toISOString();
  const limit = (provider === "claude" ? CLAUDE_TIMEOUT_MS : AGY_TIMEOUT_MS) + DEADLINE_SLACK_MS;
  try {
    const result = await withDeadline(
      provider === "claude" ? claudeUsage() : geminiUsage(),
      limit,
      `${SOURCE[provider]} tidak menjawab dalam ${limit / 1000} detik`,
    );
    return { provider, source: SOURCE[provider], checkedAt, ...result };
  } catch (error) {
    const message = (error as Error).message || String(error);
    return { provider, source: SOURCE[provider], checkedAt, windows: [], error: `Gagal membaca pemakaian: ${message.slice(0, 200)}` };
  }
}

/** Pemakaian satu agen; hasil yang umurnya di bawah semenit dipakai ulang kecuali `force`. */
export async function agentUsage(provider: ProviderId, force = false): Promise<AgentUsage | undefined> {
  if (!usageReadable(provider)) {
    cache.delete(provider);
    return undefined;
  }
  const identity = accountIdentity(provider);
  const cached = cache.get(provider);
  if (!force && cached?.identity === identity && Date.now() - Date.parse(cached.usage.checkedAt) < CACHE_MS) return cached.usage;
  const running = inflight.get(provider);
  if (running?.identity === identity) return running.promise;
  const promise: Promise<AgentUsage> = read(provider)
    .then((usage) => {
      // Akun berganti selama pembacaan: hasilnya milik akun lama, jangan disimpan.
      if (accountIdentity(provider) === identity) cache.set(provider, { identity, usage });
      return usage;
    })
    .finally(() => {
      if (inflight.get(provider)?.promise === promise) inflight.delete(provider);
    });
  inflight.set(provider, { identity, promise });
  return promise;
}
