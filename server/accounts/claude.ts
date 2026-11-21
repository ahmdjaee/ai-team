import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG, agentEnv } from "../config.ts";
import { engineOf, listTasks } from "../tasks.ts";
import type { ModelOption } from "../types.ts";
import type { LoginSpec } from "./login.ts";

/**
 * Akun Claude milik app = folder `CLAUDE_CONFIG_DIR` sendiri. Claude Code menyimpan kredensial,
 * `.claude.json`, dan transkrip sesi di sana; `~/.claude` milik `claude` di terminal tidak disentuh.
 */
export function claudeEnv(): Record<string, string | undefined> {
  return { ...agentEnv(), CLAUDE_CONFIG_DIR: CONFIG.claudeDir };
}

/** Host yang boleh muncul sebagai URL login Claude. */
export const CLAUDE_LOGIN_HOSTS = ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"];

/**
 * `claude auth login --claudeai` tanpa terminal: CLI mencetak URL, pemilik login di browser,
 * halaman akhir menampilkan kode, dan kode itu ditempel ke stdin (spike 20 Nov 2026).
 * Browser sengaja tidak dibuka dari server; tombol di dialog yang membukanya.
 */
export function claudeLoginSpec(): LoginSpec {
  return {
    command: "claude",
    args: ["auth", "login", "--claudeai"],
    env: { ...claudeEnv(), BROWSER: "/bin/true", DISPLAY: undefined, WAYLAND_DISPLAY: undefined } as NodeJS.ProcessEnv,
    cwd: CONFIG.claudeDir,
    urlHosts: CLAUDE_LOGIN_HOSTS,
  };
}

function run(args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("claude", args, { env: claudeEnv() as NodeJS.ProcessEnv, timeout: timeoutMs, cwd: CONFIG.claudeDir }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code?: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export type ClaudeStatus = { loggedIn: boolean; email?: string; plan?: string; expiresAt?: string };

const PLAN_LABEL: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };

/** `claude auth status --json`: cepat, tanpa memanggil model. */
export async function claudeStatus(): Promise<ClaudeStatus> {
  mkdirSync(CONFIG.claudeDir, { recursive: true, mode: 0o700 });
  const result = await run(["auth", "status", "--json"]);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`claude auth status gagal: ${(result.stderr || result.stdout).trim().split("\n").at(-1)?.slice(0, 200) || `kode ${result.code}`}`);
  }
  const plan = typeof data.subscriptionType === "string" ? (PLAN_LABEL[data.subscriptionType] ?? data.subscriptionType) : undefined;
  return {
    loggedIn: data.loggedIn === true,
    email: typeof data.email === "string" ? data.email : undefined,
    plan,
    expiresAt: typeof data.loginExpiresAt === "string" ? data.loginExpiresAt : undefined,
  };
}

/** Prompt yang tidak pernah mengirim pesan: subprocess cukup untuk metadata, tanpa panggilan model. */
async function* silent(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Daftar model yang bisa dipakai akun ini, dari Claude Code sendiri. */
export async function claudeModels(): Promise<ModelOption[]> {
  const stop = new AbortController();
  const instance = query({
    prompt: silent(stop.signal),
    options: { disallowedTools: ["*"], settingSources: [], persistSession: false, env: claudeEnv(), cwd: CONFIG.claudeDir },
  });
  try {
    const models = await instance.supportedModels();
    return models
      .filter((model) => typeof model.value === "string" && model.value)
      .map((model) => ({ id: model.value, name: model.displayName || model.value, description: model.description || undefined }));
  } finally {
    stop.abort();
    try {
      instance.close();
    } catch {
      // proses mungkin sudah berhenti
    }
  }
}

export async function claudeLogout(): Promise<void> {
  const result = await run(["auth", "logout"]);
  if (result.code !== 0) throw new Error(`claude auth logout gagal: ${(result.stderr || result.stdout).trim().split("\n").at(-1)?.slice(0, 200)}`);
}

/** Pesan galat Claude Code yang berarti login app sudah tidak berlaku. */
export function isClaudeAuthError(message: string): boolean {
  return /not logged in|please run \/login|invalid api key|authentication[_ ]failed|oauth token (has )?(expired|revoked)|\b401\b|unauthori[sz]ed/i.test(message);
}

/**
 * Sekali jalan setelah akun Claude app terhubung: salin transkrip sesi yang dipakai tugas dari
 * `~/.claude/projects` ke folder akun app, supaya tugas lama tetap bisa dilanjutkan. Hanya sesi
 * yang dirujuk penugasan tugas yang disalin; tidak ada berkas di `~/.claude` yang diubah.
 */
export function migrateClaudeSessions(source = join(homedir(), ".claude", "projects")): { copied: number; missing: number } {
  const wanted = new Set<string>();
  for (const task of listTasks()) {
    for (const assignment of task.assignments) {
      if (engineOf(assignment) === "claude" && assignment.sessionId) wanted.add(assignment.sessionId);
    }
  }
  let copied = 0;
  const found = new Set<string>();
  if (wanted.size && existsSync(source)) {
    for (const slug of readdirSync(source)) {
      const dir = join(source, slug);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const id = entry.endsWith(".jsonl") ? entry.slice(0, -".jsonl".length) : entry;
        if (!wanted.has(id)) continue;
        found.add(id);
        const target = join(CONFIG.claudeDir, "projects", slug, entry);
        if (existsSync(target)) continue;
        mkdirSync(join(CONFIG.claudeDir, "projects", slug), { recursive: true, mode: 0o700 });
        cpSync(join(dir, entry), target, { recursive: true, preserveTimestamps: true });
        if (entry.endsWith(".jsonl")) copied += 1;
      }
    }
  }
  return { copied, missing: wanted.size - found.size };
}

/** Transkrip sesi ada di akun app? Kalau tidak, `resume` akan gagal dan sesi harus dimulai baru. */
export function claudeSessionExists(sessionId: string): boolean {
  const root = join(CONFIG.claudeDir, "projects");
  if (!existsSync(root)) return false;
  for (const slug of readdirSync(root)) {
    if (existsSync(join(root, slug, `${sessionId}.jsonl`))) return true;
  }
  return false;
}
