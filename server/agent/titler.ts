/**
 * Judul otomatis tugas yang dibuat dari chat utama, seperti riwayat chat AI pada umumnya. Tugas
 * langsung memakai judul sementara dari pesan pertama (`fallbackTitle`); judul yang lebih rapi dari
 * model murah menggantikannya beberapa detik kemudian, hanya kalau pemilik belum mengganti namanya.
 */
import { tmpdir } from "node:os";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv, pickEngine } from "../accounts/index.ts";
import { CONFIG } from "../config.ts";
import { workspaceForTask } from "../context.ts";
import { AgyChat, type ChatOptions } from "../engines/antigravity/chat.ts";
import { ARTIFACT_TOOLS, DENY_ALWAYS } from "../roles.ts";
import { validModelId } from "../settings.ts";
import { currentAssignment, engineOf, getTask, taskDir, updateTask } from "../tasks.ts";
import type { EngineId } from "../types.ts";

/** Batas waktu satu permintaan judul; lewat dari ini judul sementara tetap dipakai. */
const TITLE_TIMEOUT_MS = 60_000;
const TITLE_MAX = 80;
/** Pesan yang sangat panjang cukup diambil awalnya. */
const MESSAGE_MAX = 4_000;

const INSTRUCTION = [
  "Anda memberi nama percakapan kerja, seperti judul riwayat chat.",
  "Balas HANYA dengan satu judul: paling banyak 8 kata, dalam bahasa pesan, tanpa tanda kutip, tanpa titik di akhir, tanpa awalan seperti \"Judul:\".",
  "Judulnya menyebut pekerjaan yang diminta, bukan sapaan.",
].join("\n");

const TOOLS_DENIED = ["Bash", "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite", "mcp__*"];

/** Rapikan jawaban model jadi satu judul; kosong kalau jawabannya tidak bisa dipakai. */
export function cleanTitle(raw: string): string | undefined {
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  // Tanda kutip, markdown, dan titik bisa berlapis ("Judul: **"X".**"): kupas sampai tidak berubah.
  let title = line.replace(/^(judul|title)\s*:\s*/i, "");
  for (let previous = ""; previous !== title; ) {
    previous = title;
    title = title
      .replace(/^[#*_\s"'“”‘’`]+/, "")
      .replace(/[*_\s"'“”‘’`.。]+$/, "");
  }
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

function prompt(message: string): string {
  return `Pesan pertama pemilik produk:\n\n${message.slice(0, MESSAGE_MAX)}`;
}

/**
 * Sesi Claude sekali jalan tanpa tool apa pun. Seperti sesi app lain, Artifact dan konektor claude.ai
 * ditolak lewat `DENY_ALWAYS` dan disembunyikan lewat `disallowedTools` (lihat CLAUDE.md proyek).
 */
export function titleOptions(abort: AbortController): Options {
  return {
    systemPrompt: INSTRUCTION,
    model: validModelId(CONFIG.titleModel) ? CONFIG.titleModel : undefined,
    effort: "low",
    cwd: tmpdir(),
    settingSources: [],
    settings: { permissions: { allow: [], ask: [], deny: [...TOOLS_DENIED, ...DENY_ALWAYS] } },
    tools: [],
    allowedTools: [],
    disallowedTools: [...TOOLS_DENIED, ...ARTIFACT_TOOLS],
    permissionMode: "default",
    canUseTool: async () => ({ behavior: "deny", message: "Pemberi judul tidak memakai tool." }),
    maxTurns: 1,
    persistSession: false,
    abortController: abort,
    env: claudeEnv(),
  };
}

async function claudeTitle(message: string): Promise<string | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
  timer.unref();
  try {
    let text = "";
    for await (const event of query({ prompt: prompt(message), options: titleOptions(abort) })) {
      if (event.type !== "result") continue;
      const result = event as unknown as Record<string, unknown>;
      if (result.subtype === "success" && typeof result.result === "string") text = result.result;
    }
    return cleanTitle(text);
  } finally {
    clearTimeout(timer);
  }
}

async function geminiTitle(taskId: string, message: string, deps: Pick<ChatOptions, "launch" | "accountEnv">): Promise<string | undefined> {
  const chat = new AgyChat({
    ...deps,
    cwd: workspaceForTask(taskId),
    areaDir: taskDir(taskId),
    systemPrompt: INSTRUCTION,
    effort: "low",
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("judul otomatis melewati batas waktu")), TITLE_TIMEOUT_MS);
  timer.unref();
  try {
    const reply = await chat.prompt(prompt(message), abort.signal);
    return cleanTitle(reply.text);
  } finally {
    clearTimeout(timer);
    await chat.close();
  }
}

export type TitleGenerator = (taskId: string, message: string, engine: EngineId) => Promise<string | undefined>;

export class Titler {
  constructor(
    /** Uji menyuntik pembuat judul palsu; server memanggil model sungguhan. */
    private readonly generate?: TitleGenerator,
    private readonly gemini: Pick<ChatOptions, "launch" | "accountEnv"> = {},
  ) {}

  /**
   * Cari judul untuk tugas yang baru dibuat. Tidak pernah melempar galat: kalau tidak ada akun,
   * model gagal, atau pemilik sudah mengganti nama, judul tugas dibiarkan.
   */
  async suggest(taskId: string, fallback: string): Promise<string | undefined> {
    if (!CONFIG.autoTitles && !this.generate) return undefined;
    const task = getTask(taskId);
    if (!task) return undefined;
    const engine = pickEngine(engineOf(currentAssignment(task)));
    if (!engine) return undefined;
    try {
      const title = this.generate
        ? await this.generate(taskId, task.description, engine)
        : engine === "claude"
          ? await claudeTitle(task.description)
          : await geminiTitle(taskId, task.description, this.gemini);
      if (!title) return undefined;
      // Pemilik mengganti nama selama model bekerja: namanya yang menang.
      const fresh = getTask(taskId);
      if (!fresh || fresh.title !== fallback || title === fallback) return undefined;
      updateTask(taskId, { title });
      return title;
    } catch (error) {
      console.error(`judul otomatis ${taskId} dilewati: ${(error as Error).message}`);
      return undefined;
    }
  }
}

export const titler = new Titler();
