import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAccountStore } from "ai-agent-auth";
import { CONFIG } from "../config.ts";
import { PROVIDER_IDS, type ProviderId } from "../types.ts";

export type { AccountRecord } from "ai-agent-auth";

const listeners = new Set<() => void>();

/** `accounts.json` (format sama), dari ai-agent-auth. */
const store = createAccountStore<ProviderId>({
  file: join(CONFIG.dataDir, "accounts.json"),
  providers: PROVIDER_IDS,
  onWrite: () => notifyAccountsChanged(),
});

export function accountDir(provider: ProviderId): string {
  return provider === "claude" ? CONFIG.claudeDir : CONFIG.antigravity.dir;
}

/** Folder akun hanya untuk user ini: berisi token login. */
export function ensureAccountDir(provider: ProviderId): string {
  const dir = accountDir(provider);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONFIG.accountsDir, 0o700);
    chmodSync(dir, 0o700);
  } catch {
    // folder di luar accountsDir (AGY_DIR kustom): biarkan
  }
  return dir;
}

export const getAccount = store.get;
export const saveAccount = store.save;
export const patchAccount = store.patch;
export const removeAccount = store.remove;
export const migrationDone = store.migrationDone;
export const markMigration = store.markMigration;
/** Untuk uji: lupakan cache agar berkas dibaca ulang. */
export const resetAccountsCache = store.reset;

/** UI menyegarkan kartu akun lewat event `accounts_changed` di topik `global`. */
export function onAccountsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyAccountsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // pendengar yang rusak tidak boleh menghentikan yang lain
    }
  }
}
