import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountStore } from "ai-agent-auth";
import { CONFIG } from "../config.ts";
import { engineOf, listTasks } from "../tasks.ts";
import type { ProviderId } from "../types.ts";

/**
 * Bagian akun Claude yang khas AI Team: transkrip sesi tugas. Login, status, dan env ada di
 * ai-agent-auth (`server/accounts/auth.ts`).
 */

const CLAUDE_MIGRATION = "claude-sessions-from-home";

/**
 * Sekali jalan setelah akun Claude app terhubung: salin transkrip sesi yang dipakai tugas dari
 * `~/.claude/projects` ke folder akun app, supaya tugas lama tetap bisa dilanjutkan. Hanya sesi
 * yang dirujuk penugasan tugas yang disalin; tidak ada berkas di `~/.claude` yang diubah.
 */
export function migrateClaudeSessions(source = join(homedir(), ".claude", "projects")): { copied: number; missing: number } {
  const wanted = new Set<string>();
  for (const task of listTasks()) {
    for (const assignment of task.assignments) {
      if (engineOf(assignment) === "claude" && assignment.sessionId) wanted.add(assignment.sessionId);
    }
  }
  let copied = 0;
  const found = new Set<string>();
  if (wanted.size && existsSync(source)) {
    for (const slug of readdirSync(source)) {
      const dir = join(source, slug);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const id = entry.endsWith(".jsonl") ? entry.slice(0, -".jsonl".length) : entry;
        if (!wanted.has(id)) continue;
        found.add(id);
        const target = join(CONFIG.claudeDir, "projects", slug, entry);
        if (existsSync(target)) continue;
        mkdirSync(join(CONFIG.claudeDir, "projects", slug), { recursive: true, mode: 0o700 });
        cpSync(join(dir, entry), target, { recursive: true, preserveTimestamps: true });
        if (entry.endsWith(".jsonl")) copied += 1;
      }
    }
  }
  return { copied, missing: wanted.size - found.size };
}

/** Salin transkrip sekali saja (penandanya di `accounts.json`). */
export function migrateClaudeOnce(store: Pick<AccountStore<ProviderId>, "migrationDone" | "markMigration">): void {
  if (store.migrationDone(CLAUDE_MIGRATION)) return;
  try {
    const result = migrateClaudeSessions();
    store.markMigration(CLAUDE_MIGRATION);
    if (result.copied || result.missing) {
      console.log(`[akun] transkrip sesi Claude disalin dari ~/.claude: ${result.copied}, tidak ditemukan: ${result.missing}`);
    }
  } catch (error) {
    console.warn(`[akun] salin transkrip sesi Claude gagal: ${(error as Error).message}`);
  }
}

/** Transkrip sesi ada di akun app? Kalau tidak, `resume` akan gagal dan sesi harus dimulai baru. */
export function claudeSessionExists(sessionId: string): boolean {
  const root = join(CONFIG.claudeDir, "projects");
  if (!existsSync(root)) return false;
  for (const slug of readdirSync(root)) {
    if (existsSync(join(root, slug, `${sessionId}.jsonl`))) return true;
  }
  return false;
}
