import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { CONFIG, agentEnv } from "../../config.ts";
import { geminiKeyringEnv } from "../../accounts/keyring.ts";
import { spawnAgy } from "./process.ts";

export type EngineModel = { id: string; name: string };

export type AntigravityInfo = {
  available: boolean;
  reason?: string;
  /** Gagal karena belum/tidak lagi login (bukan karena agy rusak atau jaringan). */
  authFailed?: boolean;
  version?: string;
  models?: EngineModel[];
  defaultModel?: string;
  checkedAt: string;
};

const CACHE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

let cache: { at: number; info: AntigravityInfo } | undefined;
let inflight: Promise<AntigravityInfo> | undefined;

/** Path biner agy, atau undefined kalau tidak ada di PATH. */
export function findAgy(): string | undefined {
  const bin = CONFIG.antigravity.bin;
  const candidates = isAbsolute(bin)
    ? [bin]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // coba berikutnya
    }
  }
  return undefined;
}

function version(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000, env: agentEnv() }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim().split("\n")[0]?.trim() || undefined);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} tidak menjawab dalam ${ms / 1000} detik`)), ms);
    }),
  ]);
}

/**
 * Buka satu sesi kosong (tanpa prompt, jadi tanpa kuota model) di keyring pribadi app untuk
 * memastikan login akun Gemini app masih berlaku dan membaca daftar model akun ini.
 */
async function probe(): Promise<AntigravityInfo> {
  const checkedAt = new Date().toISOString();
  const bin = findAgy();
  if (!bin) {
    return { available: false, reason: `perintah \`${CONFIG.antigravity.bin}\` tidak ditemukan — pasang Antigravity CLI dulu`, checkedAt };
  }
  const found = await version(bin);
  const cwd = join(CONFIG.antigravity.dir, "probe");
  mkdirSync(cwd, { recursive: true });
  const app = acp
    .client({ name: "ai-team-probe" })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" as const } }))
    .onNotification(acp.methods.client.session.update, () => undefined);
  let keyring: Record<string, string>;
  try {
    keyring = await geminiKeyringEnv();
  } catch (error) {
    return { available: false, version: found, reason: `keyring pribadi tidak bisa dimulai: ${(error as Error).message}`, checkedAt };
  }
  const proc = spawnAgy({ cwd, env: { ...agentEnv(), ...keyring }, app });
  try {
    const agent = proc.connection.agent;
    await withTimeout(
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ai-team", version: "0.1.0" },
      }),
      PROBE_TIMEOUT_MS,
      "agy acp",
    );
    const session = await withTimeout(agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }), PROBE_TIMEOUT_MS, "session/new");
    const options = (session.configOptions ?? []) as Array<{ id: string; category?: string; currentValue?: unknown; options?: unknown[] }>;
    const model = options.find((option) => option.id === "model" || option.category === "model");
    const models: EngineModel[] = [];
    for (const item of model?.options ?? []) {
      const record = item as Record<string, unknown>;
      if (typeof record.value === "string") models.push({ id: record.value, name: typeof record.name === "string" ? record.name : record.value });
    }
    await agent.request(acp.methods.agent.session.close, { sessionId: session.sessionId }).catch(() => undefined);
    return {
      available: true,
      version: found,
      models,
      defaultModel: typeof model?.currentValue === "string" ? model.currentValue : undefined,
      checkedAt,
    };
  } catch (error) {
    const message = (error as Error).message;
    const auth = isAgyAuthError(`${message} ${proc.stderrTail()}`);
    return {
      available: false,
      authFailed: auth,
      version: found,
      reason: auth ? "akun Gemini app belum login atau loginnya sudah tidak berlaku" : `agy acp gagal: ${message}`,
      checkedAt,
    };
  } finally {
    await proc.kill();
  }
}

export function antigravityInfo(force = false): Promise<AntigravityInfo> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.info);
  inflight ??= probe()
    .then((info) => {
      cache = { at: Date.now(), info };
      return info;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** Galat agy yang berarti login akun Gemini app tidak (lagi) berlaku. */
export function isAgyAuthError(text: string): boolean {
  return /auth|login|sign.?in|credential|unauthori/i.test(text);
}

/** Lupakan hasil probe (setelah login/logout akun Gemini app). */
export function resetAntigravityCache(): void {
  cache = undefined;
}
