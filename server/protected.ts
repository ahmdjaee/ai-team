import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.ts";

/**
 * Folder yang menentukan pagar mesin Antigravity. Agen (mesin apa pun) tidak boleh membaca atau
 * menulisnya: yang membaca bisa menyusun perintah yang lolos pola, yang menulis bisa mematikan pagar.
 */

/** Kode hook PreToolUse `agy` — dijalankan agy di setiap tool call. */
export const ANTIGRAVITY_CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), "engines", "antigravity");

/** ~/.gemini pribadi pemilik (riwayat dan setelan agy di luar AI Team). */
export const PERSONAL_GEMINI_DIR = join(homedir(), ".gemini");

/** Dua segmen terakhir sebuah path, untuk menangkap penyebutan relatif seperti `../data/antigravity`. */
function tail(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`;
}

/** Folder terlindung, path absolut. */
export function protectedDirs(): string[] {
  return [CONFIG.antigravity.dir, PERSONAL_GEMINI_DIR, ANTIGRAVITY_CODE_DIR];
}

/** Untuk `classifyCommand`: path absolut plus ekor relatifnya. */
export function protectedCommandPaths(): string[] {
  return [...new Set([...protectedDirs(), tail(CONFIG.antigravity.dir), tail(ANTIGRAVITY_CODE_DIR)])];
}
