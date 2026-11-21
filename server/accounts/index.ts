import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.ts";
import { antigravityInfo, resetAntigravityCache } from "../engines/antigravity/availability.ts";
import { PROVIDER_ENGINE, PROVIDER_IDS, type AccountView, type EngineId, type ProviderId } from "../types.ts";
import { claudeLoginSpec, claudeLogout, claudeModels, claudeStatus, migrateClaudeSessions } from "./claude.ts";
import { emailFromOutput, geminiLoginSpec, geminiLogout, geminiMissing } from "./gemini.ts";
import { LoginFlow, type LoginVerdict } from "./login.ts";
import {
  ensureAccountDir,
  getAccount,
  markMigration,
  migrationDone,
  notifyAccountsChanged,
  patchAccount,
  removeAccount,
  saveAccount,
  type AccountRecord,
} from "./store.ts";

export { claudeEnv } from "./claude.ts";
export { geminiEnv } from "./gemini.ts";
export { onAccountsChanged } from "./store.ts";

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini" };

/** Pemeriksaan ulang otomatis paling sering sekali per 10 menit; tombol Periksa memaksa. */
const CHECK_MS = 10 * 60_000;
const CLAUDE_MIGRATION = "claude-sessions-from-home";

const flows: Record<ProviderId, LoginFlow> = {
  claude: new LoginFlow(() => notifyAccountsChanged()),
  gemini: new LoginFlow(() => notifyAccountsChanged()),
};
const checking = new Map<ProviderId, Promise<void>>();

export function providerOf(engine: EngineId): ProviderId {
  return engine === "claude" ? "claude" : "gemini";
}

function unavailable(provider: ProviderId): string | undefined {
  return provider === "gemini" ? geminiMissing() : undefined;
}

export function accountView(provider: ProviderId): AccountView {
  const record = getAccount(provider);
  const missing = unavailable(provider);
  const state = missing ? "unavailable" : !record ? "none" : record.status;
  return {
    provider,
    engine: PROVIDER_ENGINE[provider],
    label: PROVIDER_LABEL[provider],
    state,
    email: record?.email,
    plan: record?.plan,
    reason: missing ?? record?.error,
    models: record?.models ?? [],
    defaultModel: record?.defaultModel,
    checkedAt: record?.checkedAt,
    addedAt: record?.addedAt,
    login: flows[provider].view(),
  };
}

export function accountViews(): AccountView[] {
  return PROVIDER_IDS.map(accountView);
}

/**
 * Mesin hanya bisa dipakai kalau akun penyedianya ada di app dan tidak kedaluwarsa. Status `error`
 * (mis. jaringan saat pemeriksaan) tidak memblokir: belum tentu loginnya yang bermasalah.
 */
export function engineUsable(engine: EngineId): { ok: boolean; reason?: string } {
  const provider = providerOf(engine);
  const view = accountView(provider);
  const label = PROVIDER_LABEL[provider];
  if (view.state === "unavailable") return { ok: false, reason: `akun ${label} tidak bisa dipakai di mesin ini: ${view.reason}` };
  if (view.state === "none") return { ok: false, reason: `akun ${label} belum ditambahkan — tambahkan di Pengaturan → Akun AI` };
  if (view.state === "expired") return { ok: false, reason: `akun ${label} perlu login ulang — buka Pengaturan → Akun AI` };
  return { ok: true };
}

/** Mesin yang punya akun siap pakai. */
export function usableEngines(): EngineId[] {
  return PROVIDER_IDS.map((provider) => PROVIDER_ENGINE[provider]).filter((engine) => engineUsable(engine).ok);
}

/** Mesin pilihan kalau akunnya siap, kalau tidak mesin lain yang siap; undefined = tidak ada akun siap. */
export function pickEngine(preferred: EngineId): EngineId | undefined {
  if (engineUsable(preferred).ok) return preferred;
  return usableEngines()[0];
}

/** Galat login saat tugas berjalan: tandai akun perlu login ulang supaya UI dan scheduler tahu. */
export function markAccountExpired(provider: ProviderId, reason: string): void {
  const record = getAccount(provider);
  if (!record || record.status === "expired") return;
  patchAccount(provider, { status: "expired", error: reason.slice(0, 300), checkedAt: new Date().toISOString() });
}

async function refreshClaude(record: AccountRecord): Promise<AccountRecord> {
  const checkedAt = new Date().toISOString();
  const status = await claudeStatus();
  if (!status.loggedIn) return { ...record, status: "expired", error: "Claude Code melaporkan akun app belum login", checkedAt };
  let models = record.models;
  let error: string | undefined;
  try {
    models = await claudeModels();
  } catch (failure) {
    error = `daftar model tidak terbaca: ${(failure as Error).message}`.slice(0, 300);
  }
  return { ...record, email: status.email ?? record.email, plan: status.plan ?? record.plan, models, status: "ok", error, checkedAt };
}

async function refreshGemini(record: AccountRecord, force: boolean): Promise<AccountRecord> {
  const info = await antigravityInfo(force);
  if (info.available) {
    return { ...record, models: info.models ?? record.models, defaultModel: info.defaultModel, status: "ok", error: undefined, checkedAt: info.checkedAt };
  }
  return { ...record, status: info.authFailed ? "expired" : "error", error: info.reason, checkedAt: info.checkedAt };
}

/** Periksa login dan baca ulang daftar model. Tanpa `force`, hasil yang masih baru dipakai ulang. */
export function checkAccount(provider: ProviderId, force = false): Promise<void> {
  const record = getAccount(provider);
  if (!record || unavailable(provider)) return Promise.resolve();
  if (!force && record.checkedAt && Date.now() - Date.parse(record.checkedAt) < CHECK_MS && record.status === "ok") return Promise.resolve();
  const existing = checking.get(provider);
  if (existing) return existing;
  const job = (async () => {
    try {
      const next = provider === "claude" ? await refreshClaude(record) : await refreshGemini(record, force);
      // Akun bisa sudah dihapus saat pemeriksaan berjalan.
      if (getAccount(provider)) saveAccount(provider, next);
    } catch (error) {
      if (getAccount(provider)) patchAccount(provider, { status: "error", error: (error as Error).message.slice(0, 300), checkedAt: new Date().toISOString() });
    }
  })().finally(() => checking.delete(provider));
  checking.set(provider, job);
  return job;
}

function migrateClaudeOnce(): void {
  if (migrationDone(CLAUDE_MIGRATION)) return;
  try {
    const result = migrateClaudeSessions();
    markMigration(CLAUDE_MIGRATION);
    if (result.copied || result.missing) {
      console.log(`[akun] transkrip sesi Claude disalin dari ~/.claude: ${result.copied}, tidak ditemukan: ${result.missing}`);
    }
  } catch (error) {
    console.warn(`[akun] salin transkrip sesi Claude gagal: ${(error as Error).message}`);
  }
}

async function verifyClaude(): Promise<LoginVerdict> {
  const status = await claudeStatus();
  if (!status.loggedIn) return { ok: false, error: "Claude Code belum mencatat login. Ulangi dan pastikan kodenya disalin utuh." };
  const previous = getAccount("claude");
  saveAccount("claude", {
    addedAt: previous?.addedAt ?? new Date().toISOString(),
    email: status.email,
    plan: status.plan,
    models: previous?.models,
    status: "ok",
    checkedAt: new Date().toISOString(),
  });
  migrateClaudeOnce();
  // Daftar model menyusul tanpa menahan dialog login.
  void checkAccount("claude", true);
  return { ok: true };
}

async function verifyGemini(output: string): Promise<LoginVerdict> {
  resetAntigravityCache();
  const info = await antigravityInfo(true);
  if (!info.available) return { ok: false, error: info.reason ?? "akun Gemini belum bisa dipakai" };
  const previous = getAccount("gemini");
  saveAccount("gemini", {
    addedAt: previous?.addedAt ?? new Date().toISOString(),
    email: emailFromOutput(output) ?? previous?.email,
    models: info.models,
    defaultModel: info.defaultModel,
    status: "ok",
    checkedAt: info.checkedAt,
  });
  return { ok: true };
}

export async function startLogin(provider: ProviderId): Promise<void> {
  const missing = unavailable(provider);
  if (missing) throw new Error(missing);
  ensureAccountDir(provider);
  const flow = flows[provider];
  if (flow.active) throw new Error("login untuk akun ini sedang berjalan");
  if (provider === "claude") flow.start(claudeLoginSpec(), () => verifyClaude());
  else flow.start(await geminiLoginSpec(), (output) => verifyGemini(output));
}

export function submitLoginCode(provider: ProviderId, code: string): void {
  flows[provider].submitCode(code);
}

/** Batalkan login yang berjalan dan lupakan status dialognya. */
export function dismissLogin(provider: ProviderId): void {
  flows[provider].clear();
}

export async function logoutAccount(provider: ProviderId): Promise<void> {
  flows[provider].clear();
  if (provider === "claude") {
    await claudeLogout().catch(() => undefined);
  } else {
    await geminiLogout();
    resetAntigravityCache();
  }
  removeAccount(provider);
}

/** Folder data agy versi sebelumnya (`data/antigravity`) pindah ke folder akun Gemini. */
function migrateLegacyAgyDir(): void {
  const legacy = join(CONFIG.dataDir, "antigravity");
  const target = CONFIG.antigravity.dir;
  if (legacy === target || !existsSync(legacy)) return;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(legacy)) {
    if (existsSync(join(target, entry))) continue;
    renameSync(join(legacy, entry), join(target, entry));
  }
}

/** Dipanggil sekali saat server mulai: siapkan folder, lalu periksa akun yang ada di latar. */
export function initAccounts(): void {
  mkdirSync(CONFIG.accountsDir, { recursive: true, mode: 0o700 });
  try {
    migrateLegacyAgyDir();
  } catch (error) {
    console.warn(`[akun] pindah folder agy lama gagal: ${(error as Error).message}`);
  }
  if (getAccount("claude")) migrateClaudeOnce();
  for (const provider of PROVIDER_IDS) {
    if (getAccount(provider)) void checkAccount(provider);
  }
}
