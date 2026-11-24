import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AccountView as BaseAccountView } from "ai-agent-auth";
import { CONFIG } from "../config.ts";
import { PROVIDER_ENGINE, PROVIDER_IDS, type AccountView, type ClaudeSource, type EngineId, type ProviderId } from "../types.ts";
import { auth } from "./auth.ts";
import { migrateClaudeOnce } from "./claude.ts";
import {
  checkGateway,
  gatewayActive,
  gatewayEnv,
  gatewaySettings,
  gatewayView,
  hasGateway,
  markGatewayExpired,
  onGatewayChanged,
  saveGateway,
  setGatewayActive,
  type GatewaySaveResult,
} from "./gateway.ts";

/**
 * Fasad akun untuk AI Team di atas ai-agent-auth: pemetaan akun ke mesin agen, pagar scheduler,
 * dan migrasi khas app. Login, pemeriksaan, dan penyimpanan ada di library (`auth`).
 */
export { auth };

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini" };

export function providerOf(engine: EngineId): ProviderId {
  return engine === "claude" ? "claude" : "gemini";
}

/**
 * View library + mesin agen yang memakai akun ini. Akun Claude juga membawa gateway-nya dan akun mana
 * yang dipakai bot (`claudeSource`).
 */
export function withEngine(view: BaseAccountView<ProviderId>): AccountView {
  const base: AccountView = { ...view, engine: PROVIDER_ENGINE[view.provider] };
  if (view.provider !== "claude") return base;
  return { ...base, gateway: gatewayView(), claudeSource: gatewayActive() ? "gateway" : "oauth" };
}

export function accountView(provider: ProviderId): AccountView {
  return withEngine(auth.view(provider));
}

export function accountViews(): AccountView[] {
  return auth.views().map(withEngine);
}

/**
 * Akun yang benar-benar menjalankan mesin: untuk Claude dengan gateway aktif, status, model, dan
 * waktu periksa diambil dari gateway, bukan dari login claude.ai. Kartu akun memakai `accountView`.
 */
export function effectiveAccount(view: AccountView): AccountView {
  if (view.provider !== "claude" || view.claudeSource !== "gateway" || !view.gateway) return view;
  const { gateway } = view;
  return {
    ...view,
    state: gateway.state,
    email: gateway.host,
    plan: "Gateway",
    reason: gateway.reason,
    models: gateway.models,
    defaultModel: undefined,
    checkedAt: gateway.checkedAt,
    addedAt: gateway.addedAt,
    login: undefined,
  };
}

export function engineAccount(provider: ProviderId): AccountView {
  return effectiveAccount(accountView(provider));
}

/**
 * Mesin hanya bisa dipakai kalau akun penyedianya ada di app dan tidak kedaluwarsa. Status `error`
 * (mis. jaringan saat pemeriksaan) tidak memblokir: belum tentu loginnya yang bermasalah.
 */
export function engineUsable(engine: EngineId): { ok: boolean; reason?: string } {
  const provider = providerOf(engine);
  const view = engineAccount(provider);
  const label = PROVIDER_LABEL[provider];
  if (view.claudeSource === "gateway" && view.gateway) {
    if (view.state === "expired") return { ok: false, reason: `gateway Claude menolak tokennya — perbarui di Pengaturan → Akun AI` };
    return { ok: true };
  }
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

/**
 * Galat login saat tugas berjalan: tandai akun perlu login ulang supaya UI dan scheduler tahu. Kalau
 * bot Claude sedang memakai gateway, yang ditandai gateway-nya, bukan login claude.ai.
 */
export function markAccountExpired(provider: ProviderId, reason: string): void {
  if (provider === "claude" && gatewayActive()) markGatewayExpired(reason);
  else auth.markExpired(provider, reason);
}

/** Periksa login (dan gateway Claude) lalu baca ulang daftar model. Tanpa `force`, hasil yang masih baru dipakai ulang. */
export async function checkAccount(provider: ProviderId, force = false): Promise<void> {
  if (provider === "claude") await Promise.all([auth.check(provider, { force }), checkGateway(force)]);
  else await auth.check(provider, { force });
}

export const startLogin = (provider: ProviderId): Promise<void> => auth.startLogin(provider);
export const submitLoginCode = (provider: ProviderId, code: string): void => auth.submitCode(provider, code);
/** Batalkan login yang berjalan dan lupakan status dialognya. */
export const dismissLogin = (provider: ProviderId): void => auth.dismissLogin(provider);
export const logoutAccount = (provider: ProviderId): Promise<void> => auth.logout(provider);
/** Perubahan akun library maupun gateway Claude: dasar event realtime `accounts_changed`. */
export function onAccountsChanged(listener: () => void): () => void {
  const offAuth = auth.onChange(listener);
  const offGateway = onGatewayChanged(listener);
  return () => {
    offAuth();
    offGateway();
  };
}

/**
 * Env proses Claude milik app: `CLAUDE_CONFIG_DIR` akun app. API key dari shell selalu dibuang.
 * Kalau gateway aktif, base URL-nya ditambahkan (`gatewayEnv()`); tokennya lewat `claudeSettings()`.
 */
export const claudeEnv = (): Record<string, string | undefined> => ({ ...auth.envSync("claude"), ...gatewayEnv() });
/**
 * Settings yang wajib disebar ke `settings` setiap sesi Claude milik app, berpasangan dengan `claudeEnv()`:
 * kalau gateway aktif, `apiKeyHelper` yang memberi CLI token gateway. Tanpa ini sesi jatuh ke login claude.ai.
 */
export const claudeSettings = (): { apiKeyHelper?: string } => gatewaySettings() ?? {};
/** Env login claude.ai saja, tanpa gateway: untuk membaca `/usage` langganannya. */
export const claudeOAuthEnv = (): Record<string, string | undefined> => auth.envSync("claude");

/**
 * Tambah atau ubah gateway Claude. Gateway pertama ikut memicu salinan transkrip sesi dari
 * `~/.claude`, sama seperti login claude.ai pertama.
 */
export async function saveClaudeGateway(input: { baseUrl?: unknown; token?: unknown; activate?: unknown }): Promise<GatewaySaveResult> {
  const result = await saveGateway(input);
  if (result.ok && result.created) migrateClaudeOnce(auth.store);
  return result;
}

/** Pilih akun yang dipakai bot Claude. `false` kalau memilih gateway padahal belum ditambahkan. */
export function setClaudeSource(source: ClaudeSource): boolean {
  if (source === "oauth") {
    if (hasGateway()) setGatewayActive(false);
    return true;
  }
  return setGatewayActive(true);
}

export { checkGateway, hasGateway, removeGateway } from "./gateway.ts";
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
  void checkGateway();
}

/** Saat server berhenti: hentikan CLI login yang berjalan dan keyring pribadi Gemini. */
export function disposeAccounts(): Promise<void> {
  return auth.dispose();
}
