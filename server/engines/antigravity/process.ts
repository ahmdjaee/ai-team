import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { connectAcpProcess, type AcpProcess } from "ai-agent-auth/gemini";
import { CONFIG } from "../../config.ts";

/** Folder config agy di dalam `--gemini-dir`: hooks.json dan config.json milik AI Team. */
export function agyConfigDir(geminiDir: string = CONFIG.antigravity.dir): string {
  return join(geminiDir, "config");
}

const HOOK_CLIENT = join(dirname(fileURLToPath(import.meta.url)), "hook-client.ts");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Tulis ulang hooks.json setiap kali agy dijalankan — juga memulihkan isinya kalau pernah diubah.
 * Hook yang sama berlaku untuk semua sesi; runner dikenali dari token di env proses agy.
 * `geminiDir` = folder data agy (`--gemini-dir`, atau `$HOME/.gemini` untuk `agy -p`).
 */
export function ensureAgyConfig(geminiDir: string = CONFIG.antigravity.dir): void {
  const dir = agyConfigDir(geminiDir);
  mkdirSync(dir, { recursive: true });
  const hooks = {
    "ai-team-guard": {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${shellQuote(process.execPath)} ${shellQuote(HOOK_CLIENT)}`,
              timeout: CONFIG.antigravity.hookTimeoutSec,
            },
          ],
        },
      ],
    },
  };
  writeFileSync(join(dir, "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);

  // Kerja kelompok agen (swarm) dimatikan di sumbernya; hook tetap menolaknya kalau muncul.
  const configPath = join(dir, "config.json");
  const config = readJson(configPath);
  const plugins = (config.plugins && typeof config.plugins === "object" ? config.plugins : {}) as Record<string, unknown>;
  const next = { ...config, plugins: { ...plugins, swarm: { enabled: false } } };
  if (!existsSync(configPath) || JSON.stringify(next) !== JSON.stringify(config)) {
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }
}

/** Proses `agy acp` yang tersambung lewat ACP; `kill` menghentikan seluruh process group. */
export type AgyProcess = AcpProcess;

export type LaunchOptions = { cwd: string; env: NodeJS.ProcessEnv; app: acp.ClientApp };

/** Disuntikkan di uji (`check:acp`) dengan agen ACP palsu di proses yang sama. */
export type Launcher = (options: LaunchOptions) => AgyProcess;

/**
 * Jalankan `agy acp` milik app dengan pagar AI Team (hooks.json ditulis ulang dulu). Dipakai sesi
 * bot dan, lewat ai-agent-auth, probe serta logout akun Gemini.
 */
export function launchAgyProcess({ cwd, env }: { cwd: string; env: Record<string, string | undefined> }): ChildProcess {
  ensureAgyConfig();
  const args = [
    "acp",
    "--gemini-dir",
    CONFIG.antigravity.dir,
    "--disable-telemetry",
    // Wajib supaya server MCP HTTP di session/new dipakai (hasil spike).
    "--process-per-session",
  ];
  // Process group sendiri: perintah latar agen (`npm run dev &`) tetap hidup setelah agy keluar
  // kalau hanya agy yang dimatikan.
  return spawn(CONFIG.antigravity.bin, args, { cwd, env: env as NodeJS.ProcessEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

export const spawnAgy: Launcher = ({ cwd, env, app }) => {
  const child = launchAgyProcess({ cwd, env });
  // AGY_TRACE=<berkas>: catat JSON-RPC mentah untuk diagnosis (berisi isi percakapan — jangan dinyalakan permanen).
  const trace = process.env.AGY_TRACE;
  return connectAcpProcess(child, app, {
    trace: trace
      ? (direction, chunk) =>
          appendFileSync(trace, `${JSON.stringify({ ts: new Date().toISOString(), pid: child.pid, direction, line: Buffer.from(chunk).toString("utf8") })}\n`)
      : undefined,
  });
};
