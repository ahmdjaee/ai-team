import type { AutonomyMode, EngineId, RoleId, UiEvent, WorkerStatus } from "../types.ts";
import type { RunnerHooks } from "./runner.ts";

/**
 * Permukaan runner yang dipakai scheduler dan route. Satu runner = satu penugasan aktif; tiap
 * mesin (Claude Agent SDK, Antigravity ACP) punya kelasnya sendiri dengan perilaku luar yang sama:
 * slot & kunci workspace, status, kartu persetujuan/pertanyaan, Stop, dan idle shutdown.
 */
export interface AgentRunner {
  readonly taskId: string;
  readonly role: RoleId;
  readonly engine: EngineId;
  status: WorkerStatus;
  sessionId?: string;
  readonly autonomyMode: AutonomyMode;
  setMode(mode: AutonomyMode): Promise<void>;
  send(text: string, options?: { display?: string; from?: "owner" | "system"; attachments?: string[] }): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  openRequests(): UiEvent[];
  resolveRequest(id: string, value: unknown): boolean;
  hasRequest(id: string): boolean;
}

/** Pembuat runner satu mesin. `model` hanya untuk mesin yang modelnya dipilih per penugasan. */
export type RunnerFactory = (input: {
  taskId: string;
  role: RoleId;
  hooks: RunnerHooks;
  sessionId?: string;
  mode: AutonomyMode;
  model?: string;
}) => AgentRunner;

/** Lampiran pesan owner hanya ikut di event kalau ada, supaya thread.jsonl lama dan baru berbentuk sama. */
export function withAttachments(attachments?: string[]): { attachments?: string[] } {
  return attachments && attachments.length > 0 ? { attachments } : {};
}
