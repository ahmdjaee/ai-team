import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_INTERVAL_MS } from "ai-agent-auth";
import { CONFIG } from "../config.ts";
import type { GatewayView, ModelOption } from "../types.ts";

/**
 * Gateway Claude milik app: base URL + token API yang kompatibel dengan Anthropic, setara alias
 * `claude-gw` di terminal (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`). Ini akun tambahan di samping
 * login claude.ai. Satu tanda `active` menentukan akun mana yang dipakai bot Claude.
 *
 * Gateway memakai `CLAUDE_CONFIG_DIR` yang sama dengan login claude.ai. Env-nya hanya menambah base URL
 * dan token, jadi transkrip sesi tetap di satu folder dan tugas lama bisa dilanjutkan setelah berganti
 * akun. Berkasnya ada di `data/accounts` (0600), folder yang sudah tertutup untuk bot (`protectedDirs()`).
 * Token tidak pernah dicatat di log dan tidak pernah dikirim ke web.
 */

type GatewayRecord = {
  baseUrl: string;
  token: string;
  /** true = bot Claude memakai gateway ini, bukan login claude.ai. */
  active: boolean;
  addedAt: string;
  checkedAt?: string;
  status: "ok" | "expired" | "error";
  error?: string;
  models?: ModelOption[];
};

export function gatewayFile(): string {
  return join(CONFIG.accountsDir, "claude-gateway.json");
}

/** Batas tunggu satu pemeriksaan `GET /v1/models`. */
export const GATEWAY_PROBE_TIMEOUT_MS = 10_000;
const ANTHROPIC_VERSION = "2023-06-01";

let cache: GatewayRecord | null | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // pendengar yang gagal tidak boleh menghentikan yang lain
    }
  }
}

function read(): GatewayRecord | undefined {
  if (cache !== undefined) return cache ?? undefined;
  let record: GatewayRecord | null = null;
  try {
    if (existsSync(gatewayFile())) {
      const raw = JSON.parse(readFileSync(gatewayFile(), "utf8")) as Partial<GatewayRecord>;
      if (typeof raw.baseUrl === "string" && typeof raw.token === "string" && typeof raw.addedAt === "string") {
        record = {
          baseUrl: raw.baseUrl,
          token: raw.token,
          active: raw.active === true,
          addedAt: raw.addedAt,
          checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : undefined,
          status: raw.status === "expired" || raw.status === "error" ? raw.status : "ok",
          error: typeof raw.error === "string" ? raw.error : undefined,
          models: Array.isArray(raw.models) ? raw.models : undefined,
        };
      }
    }
  } catch {
    // berkas rusak: anggap belum ada gateway
  }
  cache = record;
  return record ?? undefined;
}

function write(record: GatewayRecord | undefined): void {
  const file = gatewayFile();
  if (!record) {
    rmSync(file, { force: true });
  } else {
    mkdirSync(CONFIG.accountsDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
  cache = record ?? null;
  emit();
}

/** Lupakan cache supaya berkas dibaca ulang (uji, atau berkas diubah dari luar). */
export function resetGatewayCache(): void {
  cache = undefined;
}

export function onGatewayChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Base URL yang dipakai Claude Code: tanpa garis miring di akhir dan tanpa `/v1` (Claude Code menambahkannya sendiri). */
export function normalizeBaseUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "base URL gateway wajib diisi" };
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, error: "base URL gateway tidak sah, contoh: http://host:8143" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "base URL gateway harus http:// atau https://" };
  if (parsed.username || parsed.password) return { ok: false, error: "jangan taruh token di base URL; isi di kolom token" };
  if (parsed.search || parsed.hash) return { ok: false, error: "base URL gateway tidak boleh memuat ? atau #" };
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { ok: true, url: `${parsed.origin}${path}` };
}

function validToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token && token.length <= 4096 && !/\s/.test(token) ? token : undefined;
}

export type GatewayProbe = { ok: true; models: ModelOption[] } | { ok: false; auth: boolean; error: string };

/**
 * Periksa gateway lewat `GET {baseUrl}/v1/models`: membuktikan base URL dan token benar tanpa
 * memanggil model (tanpa kuota). Jawaban 401/403 berarti token ditolak.
 */
export async function probeGateway(baseUrl: string, token: string, timeoutMs = GATEWAY_PROBE_TIMEOUT_MS): Promise<GatewayProbe> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${token}`, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, auth: false, error: `gateway tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik` };
    }
    return { ok: false, auth: false, error: `gateway tidak bisa dihubungi: ${(error as Error).message.slice(0, 160)}` };
  }
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel();
    return { ok: false, auth: true, error: `token ditolak gateway (${response.status})` };
  }
  if (response.status === 404) {
    void response.body?.cancel();
    return { ok: false, auth: false, error: "gateway tidak punya /v1/models (404). Periksa base URL-nya; tulis tanpa /v1" };
  }
  if (!response.ok) {
    void response.body?.cancel();
    return { ok: false, auth: false, error: `gateway menjawab ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, auth: false, error: "jawaban /v1/models dari gateway bukan JSON" };
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return { ok: false, auth: false, error: "jawaban /v1/models dari gateway tidak dikenal" };
  const models: ModelOption[] = [];
  for (const item of data) {
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    const name = (item as { display_name?: unknown }).display_name;
    models.push({ id, name: typeof name === "string" && name ? name : id });
  }
  return { ok: true, models };
}

export function hasGateway(): boolean {
  return read() !== undefined;
}

/** Bot Claude memakai gateway (bukan login claude.ai)? */
export function gatewayActive(): boolean {
  return read()?.active === true;
}

function hint(token: string): string {
  return token.length >= 12 ? `…${token.slice(-4)}` : "…";
}

export function gatewayView(): GatewayView | undefined {
  const record = read();
  if (!record) return undefined;
  let host = record.baseUrl;
  try {
    host = new URL(record.baseUrl).host;
  } catch {
    // base URL lama yang tidak sah: tampilkan apa adanya
  }
  return {
    state: record.status,
    baseUrl: record.baseUrl,
    host,
    tokenHint: hint(record.token),
    models: record.models ?? [],
    addedAt: record.addedAt,
    checkedAt: record.checkedAt,
    reason: record.error,
  };
}

/**
 * Env tambahan untuk proses Claude kalau gateway aktif: hanya base URL. Tokennya diambil CLI lewat
 * `apiKeyHelper` (`gatewaySettings()`), jadi tidak pernah ada di env proses Claude, Bash, hook, atau
 * server MCP stdio milik bot, dan tidak terbaca lewat `printenv` maupun `/proc/<pid>/environ`.
 *
 * Jangan pakai `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` untuk menyembunyikan token. Mode CI itu membuat berkas
 * stub 0 byte di cwd setiap sesi dimulai (`.env.local`, `.env.*`, `package-lock.json`, `.git/config.worktree`,
 * …) dan di home (`~/.bash_profile`, …), lalu menyembunyikannya lewat `.git/info/exclude`. Laravel dengan
 * `APP_ENV=local` lalu membaca `.env.local` kosong (MissingAppKeyException di EWS :1170). Mode itu juga
 * membungkus setiap Bash dengan bwrap, yang gagal begitu rule deny mengembang melebihi 9000 argumen.
 */
export function gatewayEnv(): Record<string, string> | undefined {
  const record = read();
  if (!record?.active) return undefined;
  return { ANTHROPIC_BASE_URL: record.baseUrl };
}

/** Skrip yang mencetak token gateway dari berkasnya; dijalankan CLI Claude sebagai `apiKeyHelper`. */
export const GATEWAY_KEY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "gateway-key.ts");

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Settings tambahan untuk sesi Claude kalau gateway aktif: `apiKeyHelper` membaca token dari berkas
 * gateway (0600, di folder yang tertutup untuk bot). CLI mengirim hasilnya sebagai `Authorization: Bearer`
 * dan `x-api-key`, dan helper dari `--settings` mengalahkan login claude.ai di folder yang sama.
 * Perintahnya hanya memuat path, tidak pernah tokennya, karena `--settings` terlihat di `ps`.
 */
export function gatewaySettings(): { apiKeyHelper: string } | undefined {
  if (!read()?.active) return undefined;
  return { apiKeyHelper: [process.execPath, GATEWAY_KEY_SCRIPT, gatewayFile()].map(shellQuote).join(" ") };
}

export type GatewaySaveResult = { ok: true; created: boolean } | { ok: false; status: number; error: string };

/**
 * Tambah atau ubah gateway. Data baru disimpan hanya kalau `/v1/models` menjawab. Saat mengubah,
 * token kosong berarti token lama tetap dipakai. `activate` true menjadikan gateway akun aktif.
 * Kalau tidak diisi, gateway baru tidak aktif dan gateway yang diubah tetap pada pilihannya.
 */
export async function saveGateway(
  input: { baseUrl?: unknown; token?: unknown; activate?: unknown },
  now: () => number = Date.now,
): Promise<GatewaySaveResult> {
  const previous = read();
  const url = normalizeBaseUrl(input.baseUrl);
  if (!url.ok) return { ok: false, status: 400, error: url.error };
  const typed = typeof input.token === "string" && input.token.trim() !== "";
  const token = typed ? validToken(input.token) : previous?.token;
  if (typed && !token) return { ok: false, status: 400, error: "token gateway tidak sah (tanpa spasi, paling panjang 4096 karakter)" };
  if (!token) return { ok: false, status: 400, error: "token gateway wajib diisi" };

  const probe = await probeGateway(url.url, token);
  if (!probe.ok) return { ok: false, status: probe.auth ? 400 : 502, error: probe.error };

  const iso = new Date(now()).toISOString();
  write({
    baseUrl: url.url,
    token,
    active: typeof input.activate === "boolean" ? input.activate : (previous?.active ?? false),
    addedAt: previous?.addedAt ?? iso,
    checkedAt: iso,
    status: "ok",
    models: probe.models,
  });
  return { ok: true, created: !previous };
}

const checking: { job?: Promise<void> } = {};

/** Periksa ulang gateway. Tanpa `force`, hasil `ok` yang umurnya di bawah 10 menit dipakai ulang. */
export function checkGateway(force = false, now: () => number = Date.now): Promise<void> {
  const record = read();
  if (!record) return Promise.resolve();
  const fresh = record.checkedAt !== undefined && now() - Date.parse(record.checkedAt) < CHECK_INTERVAL_MS;
  if (!force && fresh && record.status === "ok") return Promise.resolve();
  if (checking.job) return checking.job;
  const { baseUrl, token } = record;
  const job = (async () => {
    const probe = await probeGateway(baseUrl, token);
    const current = read();
    // Gateway diubah atau dihapus selama pemeriksaan: hasilnya milik data lama.
    if (!current || current.baseUrl !== baseUrl || current.token !== token) return;
    const checkedAt = new Date(now()).toISOString();
    write(
      probe.ok
        ? { ...current, status: "ok", error: undefined, models: probe.models, checkedAt }
        : { ...current, status: probe.auth ? "expired" : "error", error: probe.error, checkedAt },
    );
  })().finally(() => {
    checking.job = undefined;
  });
  checking.job = job;
  return job;
}

/** Jadikan gateway (true) atau login claude.ai (false) akun yang dipakai bot Claude. */
export function setGatewayActive(active: boolean): boolean {
  const record = read();
  if (!record) return false;
  if (record.active !== active) write({ ...record, active });
  return true;
}

/** Galat login saat bot berjalan lewat gateway: tandai gateway perlu diperbarui. */
export function markGatewayExpired(reason: string, now: () => number = Date.now): void {
  const record = read();
  if (!record || record.status === "expired") return;
  write({ ...record, status: "expired", error: reason.slice(0, 300), checkedAt: new Date(now()).toISOString() });
}

/** Hapus gateway. Kalau gateway ini yang aktif, bot Claude kembali memakai login claude.ai. */
export function removeGateway(): void {
  if (read()) write(undefined);
}
