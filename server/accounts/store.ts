import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.ts";
import { PROVIDER_IDS, type ModelOption, type ProviderId } from "../types.ts";

/** Yang disimpan per akun: hanya metadata. Kredensial dipegang CLI-nya di folder akun. */
export type AccountRecord = {
  addedAt: string;
  email?: string;
  plan?: string;
  models?: ModelOption[];
  defaultModel?: string;
  checkedAt?: string;
  status: "ok" | "expired" | "error";
  error?: string;
};

type Stored = {
  accounts: Partial<Record<ProviderId, AccountRecord>>;
  /** Penanda migrasi sekali jalan, mis. salinan transkrip sesi Claude dari ~/.claude. */
  migrations: Record<string, string>;
};

const PATH = join(CONFIG.dataDir, "accounts.json");

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

let cache: Stored | undefined;
const listeners = new Set<() => void>();

function read(): Stored {
  if (cache) return cache;
  let stored: Stored = { accounts: {}, migrations: {} };
  if (existsSync(PATH)) {
    try {
      const raw = JSON.parse(readFileSync(PATH, "utf8")) as Partial<Stored>;
      const accounts: Stored["accounts"] = {};
      for (const provider of PROVIDER_IDS) {
        const record = raw.accounts?.[provider];
        if (record && typeof record === "object" && typeof record.addedAt === "string") accounts[provider] = record;
      }
      stored = { accounts, migrations: { ...(raw.migrations ?? {}) } };
    } catch {
      // berkas rusak: anggap belum ada akun; CLI-nya tetap memegang kredensial, Periksa memulihkannya
    }
  }
  cache = stored;
  return stored;
}

function write(next: Stored): void {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  const tmp = `${PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, PATH);
  cache = next;
  notifyAccountsChanged();
}

export function getAccount(provider: ProviderId): AccountRecord | undefined {
  return read().accounts[provider];
}

export function saveAccount(provider: ProviderId, record: AccountRecord): void {
  const current = read();
  write({ ...current, accounts: { ...current.accounts, [provider]: record } });
}

export function patchAccount(provider: ProviderId, patch: Partial<AccountRecord>): AccountRecord | undefined {
  const current = getAccount(provider);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  saveAccount(provider, next);
  return next;
}

export function removeAccount(provider: ProviderId): void {
  const current = read();
  const accounts = { ...current.accounts };
  delete accounts[provider];
  write({ ...current, accounts });
}

export function migrationDone(key: string): boolean {
  return Boolean(read().migrations[key]);
}

export function markMigration(key: string): void {
  const current = read();
  write({ ...current, migrations: { ...current.migrations, [key]: new Date().toISOString() } });
}

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

/** Untuk uji: lupakan cache agar berkas dibaca ulang. */
export function resetAccountsCache(): void {
  cache = undefined;
}
