import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CONFIG } from "../config.ts";

/**
 * Keyring pribadi untuk akun Gemini app.
 *
 * `agy` menyimpan token Google di Secret Service (keyring desktop) yang dicarinya lewat D-Bus sesi.
 * Folder data, `HOME`, dan `--app-data-dir` tidak memisahkannya dari `agy` di terminal (spike
 * 20 Nov 2026). Karena itu app menjalankan bus D-Bus dan `gnome-keyring-daemon` miliknya sendiri,
 * lalu setiap proses `agy` app diarahkan ke bus itu lewat `DBUS_SESSION_BUS_ADDRESS`:
 * - berkas keyring ada di folder akun Gemini (`keyring/keyrings/*.keyring`), terenkripsi dengan
 *   kata sandi acak di `keyring.secret` (0600);
 * - login, logout, dan token di sini tidak menyentuh keyring desktop pemilik, dan sebaliknya.
 *
 * Socket bus ditaruh di `XDG_RUNTIME_DIR`: path socket Unix maksimal 108 byte, sedangkan folder data
 * bisa panjang.
 */

const READY_TIMEOUT_MS = 5_000;

type Running = { bus: string; dbus: ChildProcess; keyring: ChildProcess };

let running: Running | undefined;
let starting: Promise<Running> | undefined;

function keyringDir(): string {
  return join(CONFIG.antigravity.dir, "keyring");
}

function secretPath(): string {
  return join(CONFIG.antigravity.dir, "keyring.secret");
}

function runtimeDir(): string {
  const base = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : tmpdir();
  const id = createHash("sha256").update(CONFIG.antigravity.dir).digest("hex").slice(0, 10);
  return join(base, `ai-team-${id}`);
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // coba folder berikutnya
    }
  }
  return false;
}

/** Program yang dibutuhkan keyring pribadi; undefined = siap. */
export function keyringMissing(): string | undefined {
  const missing = ["dbus-daemon", "gnome-keyring-daemon"].filter((bin) => !onPath(bin));
  return missing.length ? `butuh ${missing.join(" dan ")} (paket dbus dan gnome-keyring)` : undefined;
}

/**
 * Kata sandi keyring. Kalau berkasnya hilang sementara keyring lama masih ada, keyring itu tidak
 * bisa dibuka lagi: dibuang, dan akun Gemini perlu login ulang.
 */
function secret(): string {
  const path = secretPath();
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  rmSync(keyringDir(), { recursive: true, force: true });
  const value = randomBytes(32).toString("hex");
  mkdirSync(CONFIG.antigravity.dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return value;
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Tunggu baris pertama stdout (tanda siap) atau gagal kalau proses keluar duluan. */
function waitReady(child: ChildProcess, label: string, match: (text: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      // gnome-keyring-daemon kadang diam walau sudah siap; yang penting prosesnya masih hidup.
      if (alive(child)) resolve();
      else reject(new Error(`${label} berhenti saat dimulai`));
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (match(output)) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`${label} berhenti saat dimulai: ${output.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function start(): Promise<Running> {
  const missing = keyringMissing();
  if (missing) throw new Error(missing);
  const run = runtimeDir();
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const socket = join(run, "bus");
  rmSync(socket, { force: true });
  const bus = `unix:path=${socket}`;
  const password = secret();

  const dbus = spawn("dbus-daemon", ["--session", "--nofork", `--address=${bus}`, "--print-address"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitReady(dbus, "dbus-daemon", (text) => text.includes(socket));
  } catch (error) {
    dbus.kill("SIGTERM");
    throw error;
  }

  mkdirSync(keyringDir(), { recursive: true, mode: 0o700 });
  const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--components=secrets", "--unlock"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DBUS_SESSION_BUS_ADDRESS: bus,
      XDG_RUNTIME_DIR: run,
      XDG_DATA_HOME: keyringDir(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  keyring.stdin?.end(password);
  try {
    await waitReady(keyring, "gnome-keyring-daemon", (text) => text.includes("GNOME_KEYRING_CONTROL"));
  } catch (error) {
    keyring.kill("SIGTERM");
    dbus.kill("SIGTERM");
    throw error;
  }
  const state = { bus, dbus, keyring };
  const forget = () => {
    if (running === state) running = undefined;
    if (alive(dbus)) dbus.kill("SIGTERM");
    if (alive(keyring)) keyring.kill("SIGTERM");
  };
  dbus.once("exit", forget);
  keyring.once("exit", forget);
  return state;
}

/**
 * Env yang mengarahkan proses `agy` ke keyring pribadi. Bus dan keyring dimulai sekali per proses
 * server, dan dimulai ulang kalau salah satunya berhenti.
 */
export async function geminiKeyringEnv(): Promise<Record<string, string>> {
  if (running && alive(running.dbus) && alive(running.keyring)) return { DBUS_SESSION_BUS_ADDRESS: running.bus };
  starting ??= start()
    .then((state) => {
      running = state;
      return state;
    })
    .finally(() => {
      starting = undefined;
    });
  const state = await starting;
  return { DBUS_SESSION_BUS_ADDRESS: state.bus };
}

/** Matikan bus dan keyring pribadi (server berhenti, atau keyring akan dihapus). */
export async function stopGeminiKeyring(): Promise<void> {
  const state = running;
  running = undefined;
  if (!state) return;
  const exits = [state.dbus, state.keyring].filter(alive).map(
    (child) => new Promise<void>((resolve) => child.once("exit", () => resolve())),
  );
  state.keyring.kill("SIGTERM");
  state.dbus.kill("SIGTERM");
  await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, 3_000))]);
}

/** Keluar dari akun Gemini app = keyring pribadi dibuang seluruhnya, lengkap dengan kata sandinya. */
export async function wipeGeminiKeyring(): Promise<void> {
  await stopGeminiKeyring();
  rmSync(keyringDir(), { recursive: true, force: true });
  rmSync(secretPath(), { force: true });
}
