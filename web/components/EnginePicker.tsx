import { useCallback, useEffect, useState } from "react";
import { api, type EngineId, type EngineInfo } from "../api.ts";

export const ENGINE_SHORT: Record<EngineId, string> = { claude: "Claude", antigravity: "Gemini" };

const ENGINE_IDS: EngineId[] = ["claude", "antigravity"];

/** Daftar mesin dibagi antarkomponen: probe agy butuh beberapa detik dan di-cache server 10 menit. */
let shared: Promise<EngineInfo[]> | undefined;

export function useEngines(): { engines?: EngineInfo[]; checking: boolean; refresh: () => void } {
  const [engines, setEngines] = useState<EngineInfo[]>();
  const [checking, setChecking] = useState(false);
  const load = useCallback((refresh: boolean) => {
    if (refresh || !shared) shared = api.engines(refresh).then((data) => data.engines, () => []);
    setChecking(true);
    void shared.then((list) => {
      setEngines(list);
      setChecking(false);
    });
  }, []);
  useEffect(() => load(false), [load]);
  return { engines, checking, refresh: () => load(true) };
}

export function geminiInfo(engines?: EngineInfo[]): EngineInfo | undefined {
  return engines?.find((engine) => engine.id === "antigravity");
}

/**
 * Pilihan mesin + model Gemini. Claude memakai model role dari `.env`, jadi hanya ditampilkan;
 * Gemini bisa dipilih modelnya, kosong = model bawaan akun agy.
 */
export function EnginePicker({
  engines,
  engine,
  model,
  claudeModel,
  disabled,
  onChange,
  size = "md",
}: {
  engines?: EngineInfo[];
  engine: EngineId;
  model?: string;
  claudeModel?: string;
  disabled?: boolean;
  onChange: (engine: EngineId, model?: string) => void;
  size?: "sm" | "md";
}) {
  const gemini = geminiInfo(engines);
  const geminiBlocked = !gemini || !gemini.available;
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex gap-1" role="radiogroup" aria-label="Mesin agen">
        {ENGINE_IDS.map((id) => {
          const blocked = id === "antigravity" && geminiBlocked && engine !== "antigravity";
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={engine === id}
              disabled={disabled || blocked}
              title={
                id === "antigravity"
                  ? gemini?.available
                    ? "Gemini lewat Antigravity CLI, memakai akun Google Anda"
                    : gemini?.reason ?? "Memeriksa Antigravity CLI…"
                  : "Claude Agent SDK, memakai login Claude Anda"
              }
              onClick={() => onChange(id, id === "antigravity" ? model : undefined)}
              className={`rounded-lg border ${pad} disabled:opacity-40 ${
                engine === id ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:border-line-strong"
              }`}
            >
              {ENGINE_SHORT[id]}
            </button>
          );
        })}
      </div>
      {engine === "claude" && claudeModel && <span className="truncate font-mono text-[10px] text-faint">{claudeModel}</span>}
      {engine === "antigravity" && (
        <select
          value={model ?? ""}
          disabled={disabled || !gemini?.models?.length}
          onChange={(event) => onChange("antigravity", event.target.value || undefined)}
          aria-label="Model Gemini"
          className={`max-w-[15rem] rounded-lg border border-line bg-page ${pad} text-ink`}
        >
          <option value="">Bawaan agy{gemini?.defaultModel ? ` (${gemini.defaultModel})` : ""}</option>
          {(gemini?.models ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
          {model && !(gemini?.models ?? []).some((item) => item.id === model) && <option value={model}>{model} (tidak terdaftar)</option>}
        </select>
      )}
    </div>
  );
}

/** Satu kalimat risiko yang wajib terlihat di dekat setiap pilihan Gemini. */
export function GeminiRiskNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] text-faint ${className}`}>
      Gemini berjalan lewat Antigravity CLI dengan akun Google Anda. Google menyebut pemakaian agy di dalam aplikasi lain
      belum didukung untuk akun pribadi, dan akun bisa ditangguhkan — pakai dengan sadar risikonya.
    </p>
  );
}
