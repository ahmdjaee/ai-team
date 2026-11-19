import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { CONFIG } from "../../config.ts";

/** Folder config agy di dalam `--gemini-dir`: hooks.json dan config.json milik AI Team. */
export function agyConfigDir(): string {
  return join(CONFIG.antigravity.dir, "config");
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
 */
export function ensureAgyConfig(): void {
  const dir = agyConfigDir();
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

export type AgyProcess = {
  connection: acp.ClientConnection;
  /** Selesai saat proses agy keluar (atau koneksinya putus). */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Akhir stderr, untuk pesan error. */
  stderrTail: () => string;
  /** Hentikan seluruh process group (termasuk perintah latar yang dimulai agen). */
  kill: () => Promise<void>;
};

export type LaunchOptions = { cwd: string; env: NodeJS.ProcessEnv; app: acp.ClientApp };

/** Disuntikkan di uji (`check:acp`) dengan agen ACP palsu di proses yang sama. */
export type Launcher = (options: LaunchOptions) => AgyProcess;

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // sudah mati
    }
  }
}

export const spawnAgy: Launcher = ({ cwd, env, app }) => {
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
  const child = spawn(CONFIG.antigravity.bin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => {
      stderr = `${stderr}\n${error.message}`;
      resolve({ code: null, signal: null });
    });
  });

  // AGY_TRACE=<berkas>: catat JSON-RPC mentah untuk diagnosis (berisi isi percakapan — jangan dinyalakan permanen).
  const trace = process.env.AGY_TRACE;
  const log = (direction: string, chunk: Uint8Array) => {
    if (trace) appendFileSync(trace, `${JSON.stringify({ ts: new Date().toISOString(), pid: child.pid, direction, line: Buffer.from(chunk).toString("utf8") })}\n`);
  };
  if (trace) child.stdout?.on("data", (chunk: Buffer) => log("agent->client", chunk));
  const input = Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>;
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      log("client->agent", chunk);
      if (!child.stdin?.destroyed) child.stdin?.write(chunk);
    },
    close() {
      child.stdin?.end();
    },
  });
  const connection = app.connect(acp.ndJsonStream(output, input));
  void exited.then(() => connection.close());

  let killing: Promise<void> | undefined;
  return {
    connection,
    exited,
    stderrTail: () => stderr.trim(),
    kill: () => {
      killing ??= (async () => {
        connection.close();
        killGroup(child, "SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
        // agy sudah keluar atau tidak merespons: sisa anak di group yang sama ikut dihentikan.
        killGroup(child, "SIGKILL");
      })();
      return killing;
    },
  };
};
