import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { LoginPhase, LoginView } from "../types.ts";

/** Batas satu percobaan login; setelah itu proses CLI dihentikan. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_MAX = 64_000;
const CODE_MAX = 4_096;

export type LoginSpec = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Host yang boleh muncul sebagai URL login; URL lain dari output diabaikan. */
  urlHosts: string[];
};

/** Hasil verifikasi setelah CLI selesai (mis. `claude auth status`). */
export type LoginVerdict = { ok: true } | { ok: false; error: string };

export type LoginDeps = {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  timeoutMs?: number;
};

const TERMINAL: LoginPhase[] = ["done", "failed", "cancelled"];

/** Kode tempel: satu baris; URL halaman akhir juga boleh (Google menerima keduanya). */
export function validLoginCode(code: string): boolean {
  return code.length > 0 && code.length <= CODE_MAX && !/[\r\n\0]/.test(code);
}

/** URL pertama dari host yang diizinkan. */
export function findLoginUrl(output: string, hosts: string[]): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>`]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === "https:" && hosts.some((host) => url.hostname === host)) return url.toString();
    } catch {
      // bukan URL utuh
    }
  }
  return undefined;
}

/**
 * Pesan galat dari output CLI yang aman ditampilkan: tanpa URL (berisi state/challenge) dan tanpa
 * deretan karakter panjang yang bisa berupa kode atau token.
 */
export function safeMessage(output: string): string | undefined {
  const lines = output
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[A-Za-z0-9_\-./+=]{32,}/g, "…")
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim())
    .filter((line) => line && !/paste|tempel|press enter|open this link|visit:|browser/i.test(line));
  const last = lines.at(-1);
  return last ? last.slice(0, 200) : undefined;
}

/**
 * Satu alur login CLI (`claude auth login`, `agy acp --login`) yang dijalankan sebagai proses anak:
 * URL login diambil dari output, kode yang ditempel pemilik ditulis ke stdin, lalu hasilnya
 * diverifikasi. Output, URL, dan kode tidak pernah ditulis ke log.
 */
export class LoginFlow {
  private state?: LoginView;
  private child?: ChildProcess;
  private output = "";
  private timer?: NodeJS.Timeout;
  private run = 0;

  constructor(
    private readonly onChange: () => void,
    private readonly deps: LoginDeps = {},
  ) {}

  view(): LoginView | undefined {
    return this.state ? { ...this.state } : undefined;
  }

  get active(): boolean {
    return Boolean(this.state && !TERMINAL.includes(this.state.phase));
  }

  /** Mulai login baru. Login yang masih berjalan untuk penyedia ini ditolak. */
  start(spec: LoginSpec, verify: (output: string) => Promise<LoginVerdict>): void {
    if (this.active) throw new Error("login untuk akun ini sedang berjalan");
    this.kill(this.child);
    this.child = undefined;
    const run = (this.run += 1);
    const now = Date.now();
    const timeoutMs = this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
    this.output = "";
    this.state = { phase: "starting", startedAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString() };
    this.onChange();

    const spawn = this.deps.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      this.finish(run, "failed", `tidak bisa menjalankan ${spec.command}: ${(error as Error).message}`);
      return;
    }
    this.child = child;
    const onData = (chunk: Buffer) => {
      if (run !== this.run) return;
      this.output = `${this.output}${chunk.toString("utf8")}`.slice(-OUTPUT_MAX);
      if (this.state?.phase === "starting") {
        const url = findLoginUrl(this.output, spec.urlHosts);
        if (url) this.update(run, { phase: "awaiting_code", url });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => undefined);
    child.once("error", (error) => this.finish(run, "failed", `tidak bisa menjalankan ${spec.command}: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (run !== this.run || !this.active) return;
      if (code !== 0) {
        const detail = safeMessage(this.output);
        const reason = this.state?.phase === "verifying" ? "Kode ditolak atau sudah kedaluwarsa." : "Login berhenti sebelum selesai.";
        this.finish(run, "failed", detail ? `${reason} (${detail})` : signal ? `${reason} (${signal})` : reason);
        return;
      }
      this.update(run, { phase: "verifying" });
      void verify(this.output)
        .then((verdict) => (verdict.ok ? this.finish(run, "done") : this.finish(run, "failed", verdict.error)))
        .catch((error: Error) => this.finish(run, "failed", error.message));
    });
    this.timer = setTimeout(() => {
      if (run !== this.run || !this.active) return;
      const running = this.child;
      // Status dulu, baru proses dihentikan: event exit-nya tidak boleh menimpa alasan ini.
      this.finish(run, "failed", "Waktu login habis. Mulai lagi lalu selesaikan dalam 10 menit.");
      this.kill(running);
    }, timeoutMs);
    this.timer.unref?.();
  }

  /** Kode dari halaman login, diteruskan ke stdin CLI. */
  submitCode(code: string): void {
    const trimmed = code.trim();
    if (!this.state || this.state.phase !== "awaiting_code" || !this.child?.stdin) throw new Error("tidak ada login yang menunggu kode");
    if (!validLoginCode(trimmed)) throw new Error("kode tidak valid");
    this.child.stdin.write(`${trimmed}\n`);
    this.update(this.run, { phase: "verifying" });
  }

  cancel(): void {
    if (!this.active) return;
    const running = this.child;
    this.finish(this.run, "cancelled");
    this.kill(running);
  }

  /** Lupakan hasil login yang sudah selesai (dialog ditutup). */
  clear(): void {
    if (this.active) this.cancel();
    this.state = undefined;
    this.onChange();
  }

  private update(run: number, patch: Partial<LoginView>): void {
    if (run !== this.run || !this.state) return;
    this.state = { ...this.state, ...patch };
    this.onChange();
  }

  private finish(run: number, phase: LoginPhase, error?: string): void {
    if (run !== this.run || !this.state || TERMINAL.includes(this.state.phase)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // URL login tidak berguna lagi setelah selesai.
    this.state = { ...this.state, phase, url: undefined, ...(error ? { error } : {}) };
    this.child = undefined;
    this.output = "";
    this.onChange();
  }

  /** Hentikan proses CLI beserta grup prosesnya (CLI bisa memulai proses anak sendiri). */
  private kill(child: ChildProcess | undefined): void {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
