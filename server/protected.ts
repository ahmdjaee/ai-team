import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.ts";

/**
 * Folder yang tidak boleh dibaca atau ditulis agen (mesin apa pun):
 * - akun AI milik app (`data/accounts`): token login Claude, keyring Google untuk Gemini;
 * - pagar mesin Antigravity: yang membaca bisa menyusun perintah yang lolos pola, yang menulis bisa
 *   mematikan pagar.
 */

/** Kode hook PreToolUse `agy` — dijalankan agy di setiap tool call. */
export const ANTIGRAVITY_CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), "engines", "antigravity");

/** ~/.gemini pribadi pemilik (riwayat dan setelan agy di luar AI Team). */
export const PERSONAL_GEMINI_DIR = join(homedir(), ".gemini");

/** Dua segmen terakhir sebuah path, untuk menangkap penyebutan relatif seperti `../data/antigravity`. */
function tail(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`;
}

/** Metadata akun (email, paket, daftar model) — bukan rahasia, tapi bukan urusan agen. */
export const ACCOUNTS_FILE = join(CONFIG.dataDir, "accounts.json");

/** Folder (dan berkas) terlindung, path absolut. */
export function protectedDirs(): string[] {
  return [...new Set([CONFIG.accountsDir, CONFIG.antigravity.dir, ACCOUNTS_FILE, PERSONAL_GEMINI_DIR, ANTIGRAVITY_CODE_DIR])];
}

/** Untuk `classifyCommand`: path absolut plus ekor relatifnya. */
export function protectedCommandPaths(): string[] {
  return [
    ...new Set([
      ...protectedDirs(),
      tail(CONFIG.accountsDir),
      tail(ACCOUNTS_FILE),
      tail(CONFIG.antigravity.dir),
      tail(ANTIGRAVITY_CODE_DIR),
    ]),
  ];
}
