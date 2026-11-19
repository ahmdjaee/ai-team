import type { ContextUsage, UiEvent } from "../../types.ts";
import { uiTool } from "./tools.ts";

/** Field `tool_call` agy di luar skema ACP: nama asli tool (argumennya juga ada di `rawInput`). */
export type AgyToolFields = { toolCallId: string; name?: string; args?: Record<string, unknown>; status?: string };

const PREVIEW_MAX = 600;

function preview(text: string): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  return clean.length > PREVIEW_MAX ? `${clean.slice(0, PREVIEW_MAX)}…` : clean;
}

/** Isi hasil tool: output perintah, teks konten, atau ringkasan diff. */
function resultPreview(update: Record<string, unknown>): string {
  const raw = update.rawOutput as Record<string, unknown> | undefined;
  if (raw && typeof raw.output === "string") {
    // agy menaruh cap waktu di depan output perintah; yang penting bagi pembaca ada setelah "Command output:".
    const marker = raw.output.indexOf("Command output:");
    return preview(marker >= 0 ? raw.output.slice(marker + "Command output:".length) : raw.output);
  }
  const parts: string[] = [];
  for (const item of Array.isArray(update.content) ? update.content : []) {
    const block = item as Record<string, unknown>;
    if (block.type === "diff" && typeof block.path === "string") parts.push(`diff ${block.path}`);
    if (block.type === "content") {
      const content = block.content as Record<string, unknown> | undefined;
      if (content?.type === "text" && typeof content.text === "string") parts.push(content.text);
      else if (content?.type === "image") parts.push("[gambar]");
    }
  }
  if (parts.length) return preview(parts.join("\n"));
  if (raw && typeof raw.error === "string") return preview(raw.error);
  return "";
}

/**
 * `session/update` → `UiEvent`, setara `toUiEvents` jalur Claude. Potongan teks dikirim sebagai
 * `delta` (live) lalu digabung menjadi satu `assistant`/`thinking` saat tool berikutnya mulai atau
 * turn selesai — UI memperlakukannya persis seperti pesan Claude.
 */
export class AcpEventMapper {
  private text = "";
  private thought = "";
  private readonly announced = new Set<string>();
  private readonly finished = new Set<string>();
  /** Tool yang sudah dimulai dan belum selesai — tanda sesi masih bekerja. */
  readonly running = new Set<string>();
  lastText = "";
  usage?: ContextUsage;

  constructor(
    private readonly emit: (event: UiEvent) => void,
    private readonly hooks: {
      /** `ask_question` agy: pertanyaan untuk owner, dijawab di prompt berikutnya. */
      onQuestion?: (toolCallId: string, args: Record<string, unknown>) => void;
    } = {},
  ) {}

  /** Tutup teks yang sedang mengalir menjadi event utuh. */
  flush(): void {
    if (this.thought.trim()) this.emit({ type: "thinking", text: this.thought.trim() });
    this.thought = "";
    if (this.text.trim()) {
      this.lastText = this.text.trim();
      this.emit({ type: "assistant", text: this.lastText });
    }
    this.text = "";
  }

  /** Awal turn baru: teks akhir turn sebelumnya bukan lagi ringkasannya. */
  resetTurn(): void {
    this.flush();
    this.lastText = "";
  }

  /** Mengembalikan true kalau update ini menandakan agen sedang bekerja. */
  update(update: Record<string, unknown>): boolean {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type !== "text" || typeof content.text !== "string") return true;
        if (this.thought.trim()) {
          this.emit({ type: "thinking", text: this.thought.trim() });
          this.thought = "";
        }
        this.text += content.text;
        this.emit({ type: "delta", kind: "text", text: content.text });
        return true;
      }
      case "agent_thought_chunk": {
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type !== "text" || typeof content.text !== "string") return true;
        this.thought += content.text;
        this.emit({ type: "delta", kind: "thinking", text: content.text });
        return true;
      }
      case "tool_call":
      case "tool_call_update":
        this.toolUpdate(update as Record<string, unknown> & AgyToolFields);
        return true;
      case "usage_update": {
        const used = Number(update.used);
        const size = Number(update.size);
        if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return false;
        this.usage = { usedTokens: used, maxTokens: size, percentage: Math.round((used / size) * 1000) / 10 };
        this.emit({ type: "context", ...this.usage });
        return false;
      }
      case "compaction_update": {
        if (update.status === "completed" || update.status === "complete") {
          this.emit({ type: "compact", trigger: "auto", preTokens: this.usage?.usedTokens ?? 0 });
        }
        return true;
      }
      default:
        return false;
    }
  }

  private toolUpdate(update: Record<string, unknown> & AgyToolFields): void {
    const id = update.toolCallId;
    if (!id) return;
    const name = typeof update.name === "string" ? update.name : undefined;
    // Parser SDK ACP membuang `args` (bukan bagian skema); agy mengirim isi yang sama di `rawInput`.
    const raw = update.rawInput ?? update.args;
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (!this.announced.has(id) && name) {
      this.announced.add(id);
      this.running.add(id);
      this.flush();
      const tool = uiTool(name, args);
      this.emit({ type: "tool", toolUseId: id, name: tool.name, input: tool.input });
      if (name === "ask_question") this.hooks.onQuestion?.(id, args);
    }
    if ((update.status === "completed" || update.status === "failed") && !this.finished.has(id)) {
      this.finished.add(id);
      this.running.delete(id);
      this.emit({ type: "tool_result", toolUseId: id, isError: update.status === "failed", preview: resultPreview(update) });
    }
  }

  /** Tool yang tidak akan pernah selesai sendiri (ask_question setelah dijawab, turn dihentikan). */
  closeTool(id: string, text: string, isError = false): void {
    if (!this.announced.has(id) || this.finished.has(id)) return;
    this.finished.add(id);
    this.running.delete(id);
    this.emit({ type: "tool_result", toolUseId: id, isError, preview: preview(text) });
  }

  closeAllTools(text: string): void {
    for (const id of [...this.running]) this.closeTool(id, text, true);
  }
}
