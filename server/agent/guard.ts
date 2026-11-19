import { resolve } from "node:path";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { workspaceForTask } from "../context.ts";
import { CATEGORY_LABEL, classifyCommand, commitDecision } from "../policy.ts";
import { protectedCommandPaths } from "../protected.ts";
import { threads } from "../store.ts";
import { reportPath, taskDir } from "../tasks.ts";
import type { RoleId, StoredEvent } from "../types.ts";
import { bus } from "./bus.ts";

/** Pesan pemilik di tugas ini: deskripsi, chat, komentar review, dan catatan operan. */
function ownerText(event: StoredEvent): string | undefined {
  if (event.type === "user" && event.from === "owner") return event.text;
  if (event.type === "handoff" && event.note) return event.note;
  return undefined;
}

/**
 * Pesan pemilik terbaru yang menyebut commit yang menentukan. Dicari mundur di seluruh transcript —
 * bukan hanya 2 000 event terakhir, yang di tugas panjang sudah tidak memuat permintaan awalnya.
 */
function ownerRequestedCommit(taskId: string): boolean {
  let decision: boolean | undefined;
  threads.findLast(taskId, (event) => {
    const text = ownerText(event);
    decision = text === undefined ? undefined : commitDecision(text);
    return decision !== undefined;
  });
  return decision === true;
}

/**
 * Penilaian pagar keras untuk satu perintah shell tugas ini. Dipakai PreToolUse hook Claude dan
 * hook Antigravity, supaya kedua mesin menolak dan menanyakan hal yang persis sama.
 */
export function commandVerdict(
  taskId: string,
  role: RoleId,
  command: string,
): { decision: "deny" | "ask" | "pass"; message: string } {
  const verdict = classifyCommand(command, {
    // Workspace project tugas ini — bukan workspace global.
    workspaceDir: workspaceForTask(taskId),
    taskDir: taskDir(taskId),
    // Hanya Engineer yang commit otomatis; role lain punya deny atau kartu persetujuan.
    commitRequested: role === "engineer" ? ownerRequestedCommit(taskId) : undefined,
    protectedPaths: protectedCommandPaths(),
  });
  if (verdict.decision === "pass") return { decision: "pass", message: "" };
  const label = verdict.category ? ` · ${CATEGORY_LABEL[verdict.category]}` : "";
  const head = verdict.decision === "deny" ? "Ditolak pagar keras" : "Perlu persetujuan owner";
  return { decision: verdict.decision, message: `${head}${label}: ${verdict.reason}.` };
}

/**
 * Pagar keras sebagai PreToolUse hook.
 *
 * Hook berjalan sebelum deny/ask/allow dan sebelum permission mode, jadi inilah
 * satu-satunya tempat yang bisa menilai isi `ssh host '…'` secara utuh — dan
 * satu-satunya yang tetap berlaku ketika tugas dijalankan dalam mode auto.
 */
export function guardHooks(
  taskId: string,
  role: RoleId,
): Partial<Record<"PreToolUse" | "PostToolUse", HookCallbackMatcher[]>> {
  return {
    // Bukan pagar: memberi tahu tab Laporan begitu report.md ditulis, pengganti polling 10 detik.
    PostToolUse: [
      {
        matcher: "Write|Edit|MultiEdit",
        hooks: [
          async (input) => {
            const path = (input as { tool_input?: { file_path?: unknown } }).tool_input?.file_path;
            if (typeof path === "string" && resolve(workspaceForTask(taskId), path) === reportPath(taskId)) {
              bus.emit(taskId, role, { type: "report_changed" });
            }
            return {};
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          async (input) => {
            const command = (input as { tool_input?: { command?: unknown } }).tool_input?.command;
            if (typeof command !== "string") return {};

            const verdict = commandVerdict(taskId, role, command);
            if (verdict.decision === "pass") return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: verdict.decision,
                permissionDecisionReason: verdict.message,
              },
            };
          },
        ],
      },
    ],
  };
}
