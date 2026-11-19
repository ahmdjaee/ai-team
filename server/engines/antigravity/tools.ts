import type { AskQuestion } from "../../types.ts";

/**
 * Tool bawaan `agy` 1.5 (nama dan argumen dicatat dari spike 19 Nov 2026). Tool yang tidak ada di
 * sini dianggap tidak dikenal dan selalu lewat kartu persetujuan.
 */
export type ToolClass =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string }
  | { kind: "exec"; command: string }
  | { kind: "ours" }
  | { kind: "foreign_mcp"; server: string }
  | { kind: "question" }
  | { kind: "web" }
  | { kind: "background" }
  | { kind: "blocked"; reason: string }
  | { kind: "unknown" };

/** Server MCP yang dipasang AI Team ke sesi agy. */
export const OUR_MCP_SERVERS = ["team", "browser"] as const;

const BLOCKED: Record<string, string> = {
  invoke_subagent: "subagen tidak didukung di AI Team — kerjakan langsung di sesi ini",
  define_subagent: "subagen tidak didukung di AI Team — kerjakan langsung di sesi ini",
  manage_subagents: "subagen tidak didukung di AI Team — kerjakan langsung di sesi ini",
  swarm: "kerja kelompok agen tidak didukung di AI Team — kerjakan langsung di sesi ini",
  send_message: "tidak ada agen lain untuk dikirimi pesan — usulkan operan lewat mcp_team_suggest_handoff",
  run_workflow: "skrip workflow agy tidak didukung di AI Team — jalankan langkahnya satu per satu",
  schedule: "penjadwalan tidak didukung di AI Team — owner yang menentukan kapan tugas dilanjutkan",
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `mcp_team_findings_list` → { server: "team", tool: "findings_list" }. */
export function splitMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp_")) return undefined;
  const rest = name.slice(4);
  for (const server of OUR_MCP_SERVERS) {
    if (rest.startsWith(`${server}_`)) return { server, tool: rest.slice(server.length + 1) };
  }
  const index = rest.indexOf("_");
  if (index <= 0) return undefined;
  return { server: rest.slice(0, index), tool: rest.slice(index + 1) };
}

export function classifyTool(name: string, args: Record<string, unknown>): ToolClass {
  switch (name) {
    case "read_file":
      return { kind: "read", path: str(args.Path) };
    case "write_file":
    case "edit_file":
      return { kind: "write", path: str(args.Path) };
    case "run_command":
      return { kind: "exec", command: str(args.CommandLine) };
    case "ask_question":
      return { kind: "question" };
    case "search_web":
      return { kind: "web" };
    case "manage_task":
      // Mengelola perintah latar milik sesi ini sendiri (baca output, kirim input, hentikan).
      return { kind: "background" };
  }
  const blocked = BLOCKED[name];
  if (blocked) return { kind: "blocked", reason: blocked };
  const mcp = splitMcpName(name);
  if (mcp) {
    return (OUR_MCP_SERVERS as readonly string[]).includes(mcp.server)
      ? { kind: "ours" }
      : { kind: "foreign_mcp", server: mcp.server };
  }
  if (/browser/i.test(name)) {
    return { kind: "blocked", reason: "browser bawaan agy tidak dipakai — gunakan tool mcp_browser_* milik AI Team" };
  }
  return { kind: "unknown" };
}

/** Argumen tambahan agy yang tidak perlu tampil di UI. */
function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { toolSummary: _summary, ArtifactMetadata: _artifact, ...rest } = args;
  return rest;
}

/**
 * Nama dan input tool versi UI, setara Claude Code: Bash/Read/Write/Edit dengan `command` dan
 * `file_path`, `mcp__server__tool` untuk MCP. Dengan begitu timeline, kartu, dan tab Live tidak
 * perlu tahu mesin mana yang menjalankan tugas.
 */
export function uiTool(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const summary = str(args.toolSummary) || undefined;
  switch (name) {
    case "run_command":
      return {
        name: "Bash",
        input: {
          command: str(args.CommandLine),
          ...(summary ? { description: summary } : {}),
          ...(args.IsDaemon === true ? { run_in_background: true } : {}),
        },
      };
    case "read_file":
      return {
        name: "Read",
        input: {
          file_path: str(args.Path),
          ...(typeof args.StartLine === "number" ? { offset: args.StartLine } : {}),
          ...(typeof args.EndLine === "number" && typeof args.StartLine === "number"
            ? { limit: args.EndLine - args.StartLine + 1 }
            : {}),
        },
      };
    case "write_file":
      return { name: "Write", input: { file_path: str(args.Path), content: str(args.Content) } };
    case "edit_file":
      return {
        name: "Edit",
        input: { file_path: str(args.Path), old_string: str(args.Target), new_string: str(args.Replacement) },
      };
    case "search_web":
      return { name: "WebSearch", input: cleanArgs(args) };
    case "ask_question":
      return { name: "AskUserQuestion", input: { questions: toAskQuestions(args.questions) } };
  }
  const mcp = splitMcpName(name);
  if (mcp) return { name: `mcp__${mcp.server}__${mcp.tool}`, input: cleanArgs(args) };
  return { name, input: cleanArgs(args) };
}

/** `ask_question` agy: `[{question, options: string[] | {label}[]}]` → format kartu pertanyaan. */
export function toAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: AskQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = str(record.question) || str(record.Question);
    if (!question) continue;
    const options = Array.isArray(record.options) ? record.options : Array.isArray(record.Options) ? record.Options : [];
    questions.push({
      question,
      ...(str(record.header) ? { header: str(record.header) } : {}),
      multiSelect: record.multiSelect === true || record.multi_select === true,
      options: options
        .map((option) => {
          if (typeof option === "string") return { label: option };
          if (option && typeof option === "object") {
            const value = option as Record<string, unknown>;
            const label = str(value.label) || str(value.value) || str(value.name);
            return label ? { label, ...(str(value.description) ? { description: str(value.description) } : {}) } : undefined;
          }
          return undefined;
        })
        .filter((option): option is { label: string; description?: string } => option !== undefined),
    });
  }
  return questions;
}
