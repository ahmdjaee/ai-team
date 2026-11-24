import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG } from "../../config.ts";
import { protectedDirs } from "../../protected.ts";
import { ROLES, permissionsFor } from "../../roles.ts";
import type { AutonomyMode, RoleId } from "../../types.ts";
import { hasHiddenEffects, matchBashRules, matchPathRules, splitCommand } from "./rules.ts";
import { classifyTool } from "./tools.ts";

/**
 * Keputusan izin satu tool call agy, dibuat oleh hook PreToolUse sebelum tool berjalan.
 *
 * Padanan perilaku jalur Claude:
 *   - pagar keras `server/policy.ts` berlaku di semua mode (deny = tolak, ask = kartu);
 *   - "Minta approval" = permissionMode bawaan role: edit di workspace & folder tugas langsung jalan
 *     untuk QA/Engineer/UI-UX (acceptEdits), DevOps hanya folder tugas; perintah di allow-list role
 *     langsung jalan, selebihnya kartu;
 *   - "Auto" = semua yang lolos pagar keras jalan, kecuali menulis di luar area kerja;
 *   - "Hanya baca" = tidak ada tulis, perintah hanya yang membaca.
 */
export type Verdict = { decision: "allow" } | { decision: "deny"; reason: string } | { decision: "ask"; reason?: string };

export type DecideInput = {
  role: RoleId;
  mode: AutonomyMode;
  name: string;
  args: Record<string, unknown>;
  /** cwd sesi agy (workspace project). */
  workspaceDir: string;
  /** Folder tugas ini. */
  taskDir: string;
  /** Pagar keras perintah shell (`commandVerdict` di guard.ts), disuntikkan supaya modul ini bisa diuji. */
  commandVerdict: (command: string) => { decision: "deny" | "ask" | "pass"; message: string };
};

/** Role yang di mode "Minta approval" menyunting berkas tanpa bertanya (acceptEdits di jalur Claude). */
const ACCEPTS_EDITS: RoleId[] = ["qa", "engineer", "uiux"];

/** Perintah yang hanya membaca: boleh jalan di mode Hanya baca. */
const READ_ONLY_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "du", "df", "pwd", "tree", "file",
  "git status", "git diff", "git log", "git show", "git branch", "git blame", "git rev-parse",
  "uname", "ps", "free", "uptime", "whoami", "id", "which", "echo", "printf", "sort", "uniq", "cut",
  "jq", "realpath", "dirname", "basename", "date",
].map((command) => `Bash(${command}:*)`);

/** `find -delete/-exec` dan sejenisnya mengubah berkas walau perintahnya "membaca". */
const READ_ONLY_ESCAPES = /\s-(delete|exec|execdir|ok|fprint\w*)\b|\bsed\s+(?:-\S*\s+)*-i/;

function within(path: string, dir: string): boolean {
  const base = dir.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Path nyata (symlink diikuti) supaya `ln -s ~/.gemini x` lalu `read_file x/...` tidak lolos. Berkas
 * yang belum ada dinilai dari folder induk terdekat yang ada.
 */
export function realPath(path: string, cwd: string): string {
  // `~` tidak diperluas agy, tapi pagar tidak boleh bergantung pada itu.
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  let current = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync(current);
  } catch {
    // tidak bisa dibaca: pakai path apa adanya
  }
  return tail.length ? join(current, ...tail) : current;
}

function protectedHit(path: string): string | undefined {
  return protectedDirs()
    .map((dir) => realPath(dir, "/"))
    .find((dir) => within(path, dir));
}

function decideRead(input: DecideInput, path: string): Verdict {
  if (!path) return { decision: "deny", reason: "path berkas kosong" };
  const real = realPath(path, input.workspaceDir);
  const hit = protectedHit(real);
  if (hit) return { decision: "deny", reason: `folder ${hit} terlindung — berisi data dan pagar mesin agen` };
  const rule = matchPathRules(permissionsFor(input.role, input.workspaceDir).deny, ["Read"], real);
  if (rule) return { decision: "deny", reason: `dilarang aturan role (${rule})` };
  return { decision: "allow" };
}

function decideWrite(input: DecideInput, path: string): Verdict {
  if (input.mode === "readonly") return { decision: "deny", reason: "mode Hanya baca — tidak boleh mengubah berkas" };
  if (!path) return { decision: "deny", reason: "path berkas kosong" };
  const real = realPath(path, input.workspaceDir);
  const hit = protectedHit(real);
  if (hit) return { decision: "deny", reason: `folder ${hit} terlindung — berisi data dan pagar mesin agen` };
  const permissions = permissionsFor(input.role, input.workspaceDir);
  const denied = matchPathRules(permissions.deny, ["Edit", "Write"], real);
  if (denied) return { decision: "deny", reason: `dilarang aturan role (${denied})` };

  const tasksDir = realPath(CONFIG.tasksDir, "/");
  const dataDir = realPath(CONFIG.dataDir, "/");
  const workspace = realPath(input.workspaceDir, "/");
  // Data aplikasi (settings, project, sesi) bukan area kerja bot mana pun.
  if (within(real, dataDir) && !within(real, tasksDir) && !within(real, workspace)) {
    return { decision: "deny", reason: "data aplikasi AI Team tidak boleh disunting agen" };
  }

  if (matchPathRules(permissions.allow, ["Edit", "Write"], real)) return { decision: "allow" };
  const workArea = within(real, workspace) || within(real, tasksDir);
  if (workArea && (input.mode === "auto" || ACCEPTS_EDITS.includes(input.role))) return { decision: "allow" };
  return {
    decision: "ask",
    reason: workArea ? undefined : "menulis di luar workspace dan folder tugas",
  };
}

/**
 * `cd <folder> && …` dengan folder di dalam workspace atau folder tugas tidak mengubah apa pun; Gemini
 * hampir selalu menulisnya di depan perintah. Bagian itu dibuang sebelum allow-list dicocokkan,
 * supaya `cd ws && cat x` diperlakukan seperti `cat x`. `cd` ke tempat lain tetap ikut dinilai.
 */
function withoutHarmlessCd(input: DecideInput, command: string): string {
  const areas = [realPath(input.workspaceDir, "/"), realPath(CONFIG.tasksDir, "/")];
  const parts = splitCommand(command);
  const kept = parts.filter((part) => {
    const match = /^cd\s+(?:--\s+)?(['"]?)([^'"\s]+)\1$/.exec(part);
    if (!match) return true;
    const target = realPath(match[2] ?? "", input.workspaceDir);
    return !areas.some((area) => within(target, area));
  });
  return kept.length === parts.length ? command : kept.join(" && ");
}

function decideCommand(input: DecideInput, raw: string): Verdict {
  const command = withoutHarmlessCd(input, raw);
  if (!raw.trim()) return { decision: "deny", reason: "perintah kosong" };
  // Pagar keras menilai perintah utuh, termasuk `cd`-nya.
  const verdict = input.commandVerdict(raw);
  if (verdict.decision === "deny") return { decision: "deny", reason: verdict.message };
  if (verdict.decision === "ask") return { decision: "ask", reason: verdict.message };

  // Hanya `cd` ke area kerja: tidak ada yang dijalankan.
  if (!command.trim()) return { decision: "allow" };
  const permissions = permissionsFor(input.role, input.workspaceDir);
  if (matchBashRules(permissions.deny, command, "some")) {
    const part = splitCommand(command).find((piece) => matchBashRules(permissions.deny, piece, "some")) ?? command;
    return { decision: "deny", reason: `dilarang aturan role ${ROLES[input.role].title}: \`${part.slice(0, 80)}\`` };
  }

  if (input.mode === "readonly") {
    if (!hasHiddenEffects(command) && !READ_ONLY_ESCAPES.test(command) && matchBashRules(READ_ONLY_COMMANDS, command, "every")) {
      return { decision: "allow" };
    }
    return { decision: "deny", reason: "mode Hanya baca — hanya perintah yang membaca (ls, cat, grep, git log, …)" };
  }
  if (input.mode === "auto") return { decision: "allow" };
  if (!hasHiddenEffects(command) && matchBashRules(permissions.allow, command, "every")) return { decision: "allow" };
  return { decision: "ask" };
}

export function decideTool(input: DecideInput): Verdict {
  const tool = classifyTool(input.name, input.args);
  switch (tool.kind) {
    case "read":
      return decideRead(input, tool.path);
    case "write":
      return decideWrite(input, tool.path);
    case "exec":
      return decideCommand(input, tool.command);
    case "ours":
    case "question":
    case "background":
    case "progress":
      // `progress` setara TodoWrite di allow-list semua role jalur Claude; boleh juga di Hanya baca.
      return { decision: "allow" };
    case "web":
      // Setara WebSearch di jalur Claude: bukan bagian allow-list role, jadi ditanyakan kecuali Auto.
      return input.mode === "ask" ? { decision: "ask" } : { decision: "allow" };
    case "foreign_mcp":
      return { decision: "deny", reason: `server MCP "${tool.server}" bukan milik AI Team` };
    case "blocked":
      return { decision: "deny", reason: tool.reason };
    case "unknown":
      return input.mode === "readonly"
        ? { decision: "deny", reason: `tool ${input.name} tidak dikenal AI Team — mode Hanya baca menolaknya` }
        : { decision: "ask", reason: `tool ${input.name} belum dikenal AI Team` };
  }
}
