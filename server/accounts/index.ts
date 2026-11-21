import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AccountView as BaseAccountView } from "ai-agent-auth";
import { CONFIG } from "../config.ts";
import { PROVIDER_ENGINE, PROVIDER_IDS, type AccountView, type EngineId, type ProviderId } from "../types.ts";
import { auth } from "./auth.ts";
import { migrateClaudeOnce } from "./claude.ts";

/**
 * Fasad akun untuk AI Team di atas ai-agent-auth: pemetaan akun ke mesin agen, pagar scheduler,
 * dan migrasi khas app. Login, pemeriksaan, dan penyimpanan ada di library (`auth`).
 */
export { auth };

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini" };

export function providerOf(engine: EngineId): ProviderId {
  return engine === "claude" ? "claude" : "gemini";
}

/** View library + mesin agen yang memakai akun ini. */
export function withEngine(view: BaseAccountView<ProviderId>): AccountView {
  return { ...view, engine: PROVIDER_ENGINE[view.provider] };
}

export function accountView(provider: ProviderId): AccountView {
  return withEngine(auth.view(provider));
}

export function accountViews(): AccountView[] {
  return auth.views().map(withEngine);
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
  auth.markExpired(provider, reason);
}

/** Periksa login dan baca ulang daftar model. Tanpa `force`, hasil yang masih baru dipakai ulang. */
export function checkAccount(provider: ProviderId, force = false): Promise<void> {
  return auth.check(provider, { force });
}

export const startLogin = (provider: ProviderId): Promise<void> => auth.startLogin(provider);
export const submitLoginCode = (provider: ProviderId, code: string): void => auth.submitCode(provider, code);
/** Batalkan login yang berjalan dan lupakan status dialognya. */
export const dismissLogin = (provider: ProviderId): void => auth.dismissLogin(provider);
export const logoutAccount = (provider: ProviderId): Promise<void> => auth.logout(provider);
export const onAccountsChanged = (listener: () => void): (() => void) => auth.onChange(listener);

/** Env proses Claude milik app: `CLAUDE_CONFIG_DIR` akun app, tanpa API key. */
export const claudeEnv = (): Record<string, string | undefined> => auth.envSync("claude");
/** Env proses agy milik app: keyring pribadi, bukan keyring desktop pemilik. */
export const geminiEnv = (): Promise<Record<string, string | undefined>> => auth.env("gemini");

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
  if (auth.store.get("claude")) migrateClaudeOnce(auth.store);
  auth.init();
}

/** Saat server berhenti: hentikan CLI login yang berjalan dan keyring pribadi Gemini. */
export function disposeAccounts(): Promise<void> {
  return auth.dispose();
}
