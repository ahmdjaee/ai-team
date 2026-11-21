import type { Effort } from "../../types.ts";

/**
 * Model dan thinking level sesi `agy` dipasang lewat `configOptions` sesi ACP (bukan flag CLI). Dipakai
 * runner tugas dan sesi ringan (kurator, panel Tanya), supaya keduanya memilih model dengan cara sama.
 */

/** Effort (skala Claude) → `thought_level` agy. */
export const THOUGHT_LEVEL: Record<Effort, string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

export type ConfigSelect = { id: string; category?: string; currentValue?: unknown; options?: unknown[] };

export function configValues(option: ConfigSelect): string[] {
  const values: string[] = [];
  for (const item of option.options ?? []) {
    const record = item as Record<string, unknown>;
    if (typeof record.value === "string") values.push(record.value);
    if (Array.isArray(record.options)) values.push(...configValues({ id: "", options: record.options }));
  }
  return values;
}

export function configList(raw: unknown): ConfigSelect[] {
  return (Array.isArray(raw) ? raw : []) as ConfigSelect[];
}

export function modelOption(raw: unknown): ConfigSelect | undefined {
  return configList(raw).find((option) => option.id === "model" || option.category === "model");
}

export type SetConfig = (configId: string, value: string) => Promise<unknown>;

/**
 * Pasang model (kalau diminta dan tersedia) dan thinking level (kalau `effort` diberikan). Mengembalikan
 * model yang berlaku dan pemberitahuan untuk pemakai; model yang tidak ada di akun bukan galat.
 */
export async function applySessionConfig(
  raw: unknown,
  wanted: { model?: string; effort?: Effort },
  set: SetConfig,
  /** Model yang sedang berlaku kalau sudah diganti sejak `raw` diterima (nilai di `raw` sudah basi). */
  activeModel?: string,
): Promise<{ model?: string; notices: string[] }> {
  const notices: string[] = [];
  const model = modelOption(raw);
  let current = activeModel ?? (typeof model?.currentValue === "string" ? model.currentValue : undefined);
  if (model && wanted.model && wanted.model !== current) {
    if (configValues(model).includes(wanted.model)) {
      await set(model.id, wanted.model).then(
        () => {
          current = wanted.model;
        },
        (error: Error) => notices.push(`Model ${wanted.model} tidak bisa dipasang: ${error.message}`),
      );
    } else {
      notices.push(`Model ${wanted.model} tidak tersedia di akun Antigravity ini — memakai ${current ?? "model bawaan"}.`);
    }
  }

  if (wanted.effort) {
    const thought = configList(raw).find((option) => option.id === "thought_level" || option.category === "thought_level");
    const level = THOUGHT_LEVEL[wanted.effort] ?? "high";
    if (thought && thought.currentValue !== level && configValues(thought).includes(level)) {
      await set(thought.id, level).catch(() => undefined);
    }
  }
  return { model: current, notices };
}
