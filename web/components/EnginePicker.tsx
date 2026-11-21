import type { EngineId, EngineInfo, ModelOption, RoleId, SettingsView } from "../api.ts";
import { Select } from "./Select.tsx";

export { useEngines, usableEngine } from "../accounts.ts";

export const ENGINE_SHORT: Record<EngineId, string> = { claude: "Claude", antigravity: "Gemini" };

const ENGINE_IDS: EngineId[] = ["claude", "antigravity"];

/** Model bawaan bot untuk mesin itu: Pengaturan → Bot, lalu `.env` (Claude); Gemini kosong = bawaan agy. */
export function botDefaultModel(settings: SettingsView | undefined, role: RoleId, engine: EngineId): string | undefined {
  if (!settings) return undefined;
  return engine === "claude" ? (settings.claudeModels[role] ?? settings.defaults.claudeModels[role]) : settings.geminiModels[role];
}

/** Nama model untuk ditampilkan: nama dari daftar akun kalau ada, kalau tidak id-nya. */
export function modelName(models: ModelOption[] | undefined, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return models?.find((model) => model.id === id)?.name ?? id;
}

/**
 * Pilihan mesin + model untuk satu penugasan. Mesin tanpa akun siap tidak bisa dipilih; model
 * kosong = bawaan bot (`defaultModel`, dari Pengaturan → Bot atau `.env`; Gemini: bawaan akun agy).
 */
export function EnginePicker({
  engines,
  engine,
  model,
  defaultModel,
  disabled,
  onChange,
  size = "md",
  defaultLabel = "Bawaan bot",
}: {
  engines?: EngineInfo[];
  engine: EngineId;
  model?: string;
  /** Model bawaan bot untuk mesin yang sedang dipilih; hanya untuk label opsi "Bawaan". */
  defaultModel?: string;
  disabled?: boolean;
  onChange: (engine: EngineId, model?: string) => void;
  size?: "sm" | "md";
  /** Teks opsi model kosong, mis. "Bawaan Tanya". */
  defaultLabel?: string;
}) {
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  const info = engines?.find((item) => item.id === engine);
  const models = info?.models ?? [];
  const fallback = modelName(models, defaultModel ?? (engine === "antigravity" ? info?.defaultModel : undefined));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex gap-1" role="radiogroup" aria-label="Mesin agen">
        {ENGINE_IDS.map((id) => {
          const item = engines?.find((entry) => entry.id === id);
          const blocked = !item?.available && engine !== id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={engine === id}
              disabled={disabled || blocked}
              title={item?.available ? `${ENGINE_SHORT[id]} — memakai akun ${item.label} di app ini` : (item?.reason ?? "Memeriksa akun…")}
              onClick={() => onChange(id, undefined)}
              className={`rounded-lg border ${pad} disabled:opacity-40 ${
                engine === id ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:border-line-strong"
              }`}
            >
              {ENGINE_SHORT[id]}
            </button>
          );
        })}
      </div>
      <Select
        value={model ?? ""}
        options={[
          { value: "", label: `${defaultLabel}${fallback ? ` (${fallback})` : engine === "antigravity" ? " (bawaan agy)" : ""}` },
          ...models.map((item) => ({ value: item.id, label: item.name, description: item.description })),
          ...(model && !models.some((item) => item.id === model) ? [{ value: model, label: `${model} (tidak terdaftar)` }] : []),
        ]}
        onChange={(value) => onChange(engine, value || undefined)}
        disabled={disabled || !info?.available}
        ariaLabel={`Model ${ENGINE_SHORT[engine]}`}
        size={size}
        className="max-w-[16rem]"
      />
      {info && !info.available && <span className="text-[11px] text-tag-yellow-ink">{info.reason}</span>}
    </div>
  );
}

/** Satu kalimat risiko yang wajib terlihat di dekat setiap pilihan Gemini. */
export function GeminiRiskNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] text-faint ${className}`}>
      Gemini berjalan lewat Antigravity CLI dengan akun Google yang Anda tambahkan di app. Google menyebut pemakaian agy di
      dalam aplikasi lain belum didukung untuk akun pribadi, dan akun bisa ditangguhkan — pakai dengan sadar risikonya.
    </p>
  );
}
