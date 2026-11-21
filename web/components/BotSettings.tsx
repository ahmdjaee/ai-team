import type { ReactNode } from "react";
import {
  EFFORT_LABEL,
  MODE_LABEL,
  MODE_NOTE,
  type AutonomyMode,
  type Effort,
  type EngineId,
  type EngineInfo,
  type ModelKey,
  type RoleInfo,
  type SettingsView,
} from "../api.ts";
import type { SettingsPatch } from "../../server/settings.ts";
import { ENGINE_SHORT, GeminiRiskNote, modelName } from "./EnginePicker.tsx";
import { Select } from "./Select.tsx";

const MODES: AutonomyMode[] = ["auto", "ask", "readonly"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ENGINE_IDS: EngineId[] = ["claude", "antigravity"];

/** Satu sel tabel; di layar sempit labelnya tampil di atas isinya. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-faint md:hidden">{label}</span>
      {children}
    </div>
  );
}

function ModelSelect({
  engine,
  info,
  value,
  fallback,
  disabled,
  onChange,
}: {
  engine: EngineId;
  info?: EngineInfo;
  value?: string;
  /** Model yang berlaku kalau kosong: `.env` (Claude) atau bawaan agy (Gemini). */
  fallback?: string;
  disabled?: boolean;
  onChange: (model: string | null) => void;
}) {
  const models = info?.models ?? [];
  const fallbackName = modelName(models, fallback);
  const selected = models.find((item) => item.id === value);
  return (
    <Select
      value={value ?? ""}
      disabled={disabled}
      onChange={(next) => onChange(next || null)}
      ariaLabel={`Model ${ENGINE_SHORT[engine]}`}
      title={selected ? `${selected.description ?? selected.name} — ${selected.id}` : fallback}
      className="w-full"
      options={[
        {
          value: "",
          label: engine === "claude" ? `Bawaan (.env: ${fallbackName ?? "—"})` : `Bawaan agy${fallbackName ? ` (${fallbackName})` : ""}`,
        },
        ...models.map((item) => ({ value: item.id, label: item.name, description: item.description })),
        ...(value && !selected ? [{ value, label: `${value} (tidak terdaftar di akun)` }] : []),
      ]}
    />
  );
}

function EffortSelect({
  value,
  fallback,
  disabled,
  onChange,
}: {
  value?: Effort;
  fallback: Effort;
  disabled?: boolean;
  onChange: (effort: Effort | null) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      disabled={disabled}
      onChange={(next) => onChange((next || null) as Effort | null)}
      ariaLabel="Tingkat penalaran"
      className="w-full"
      options={[
        { value: "", label: `Bawaan (${EFFORT_LABEL[fallback]})` },
        ...EFFORTS.map((effort) => ({ value: effort, label: EFFORT_LABEL[effort] })),
      ]}
    />
  );
}

/** Pilihan mesin satu baris; dengan satu mesin siap cukup ditampilkan namanya. */
function EngineChoice({
  label,
  engine,
  engines,
  disabled,
  onPick,
}: {
  label: string;
  engine: EngineId;
  engines?: EngineInfo[];
  disabled?: boolean;
  onPick: (engine: EngineId) => void;
}) {
  const info = (id: EngineId) => engines?.find((item) => item.id === id);
  const ready = ENGINE_IDS.filter((id) => info(id)?.available);
  const blocked = engines && !info(engine)?.available;
  if (ready.length <= 1 && !blocked) return <span className="text-xs text-muted">{ENGINE_SHORT[engine]}</span>;
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={`Mesin ${label}`}>
      {ENGINE_IDS.map((id) => {
        const available = info(id)?.available ?? false;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={engine === id}
            disabled={disabled || (!available && engine !== id)}
            title={available ? undefined : info(id)?.reason}
            onClick={() => onPick(id)}
            className={`rounded-lg border px-2 py-0.5 text-[11px] disabled:opacity-40 ${
              engine === id ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:border-line-strong"
            }`}
          >
            {ENGINE_SHORT[id]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Baris pembantu tanpa mode (kurator memori, panel Tanya): mesin, model, penalaran. Kalau akun mesin
 * pilihannya belum siap, pembantu ini memakai mesin lain yang siap — dan baris ini menyebutnya.
 */
function HelperRow({
  label,
  blurb,
  modelKey,
  engine,
  settings,
  engines,
  saving,
  save,
  onPickEngine,
}: {
  label: string;
  blurb: string;
  modelKey: "curator" | "ask";
  engine: EngineId;
  settings: SettingsView;
  engines?: EngineInfo[];
  saving: boolean;
  save: (patch: SettingsPatch) => void;
  onPickEngine: (engine: EngineId) => void;
}) {
  const engineInfo = engines?.find((item) => item.id === engine);
  const blocked = engines && !engineInfo?.available;
  const fallback = blocked ? engines?.find((item) => item.available) : undefined;
  return (
    <div className="grid grid-cols-2 gap-3 border-t border-line px-3 py-2.5 md:grid-cols-[10rem_8.5rem_minmax(0,1fr)_10rem_9rem] md:items-center">
      <div className="col-span-2 min-w-0 md:col-span-1">
        <span className="block text-sm text-ink">{label}</span>
        {blocked ? (
          <span className="block text-[11px] text-tag-yellow-ink" title={engineInfo?.reason}>
            {fallback
              ? `Akun ${ENGINE_SHORT[engine]} belum siap — sementara memakai ${ENGINE_SHORT[fallback.id]}`
              : `Akun ${ENGINE_SHORT[engine]} belum siap`}
          </span>
        ) : (
          <span className="block text-[11px] text-faint">{blurb}</span>
        )}
      </div>
      <Cell label="Mesin">
        <EngineChoice label={label} engine={engine} engines={engines} disabled={saving} onPick={onPickEngine} />
      </Cell>
      <Cell label="Model">
        <ModelSelect
          engine={engine}
          info={engineInfo}
          value={engine === "claude" ? settings.claudeModels[modelKey] : settings.geminiModels[modelKey]}
          fallback={engine === "claude" ? settings.defaults.claudeModels[modelKey] : engineInfo?.defaultModel}
          disabled={saving}
          onChange={(model) => save(modelPatch(engine, modelKey, model))}
        />
      </Cell>
      <Cell label="Penalaran">
        <EffortSelect
          value={settings.efforts[modelKey]}
          fallback={settings.defaults.efforts[modelKey]}
          disabled={saving}
          onChange={(effort) => save({ efforts: { [modelKey]: effort } })}
        />
      </Cell>
      <span className="hidden text-xs text-faint md:block">—</span>
    </div>
  );
}

function modelPatch(engine: EngineId, key: ModelKey, model: string | null): SettingsPatch {
  return engine === "claude" ? { claudeModels: { [key]: model } } : { geminiModels: { [key]: model } };
}

/**
 * Pengaturan → Bot: mesin, model, tingkat penalaran, dan mode bawaan tiap bot, plus kurator memori dan
 * panel Tanya. Berlaku untuk tugas dan operan baru; tugas yang sudah jalan memakai pilihannya sendiri.
 */
export function BotSettings({
  roles,
  settings,
  engines,
  saving,
  save,
}: {
  roles: RoleInfo[];
  settings: SettingsView;
  engines?: EngineInfo[];
  saving: boolean;
  save: (patch: SettingsPatch) => void;
}) {
  const info = (engine: EngineId) => engines?.find((item) => item.id === engine);
  const usesGemini =
    roles.some((role) => settings.engines[role.id] === "antigravity") ||
    settings.curatorEngine === "antigravity" ||
    settings.askEngine === "antigravity";

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-muted">Bot</h3>
      <p className="mt-1 text-xs text-faint">
        Bawaan untuk tugas dan operan baru; bisa diganti per tugas di form Tugas baru dan saat Oper. Model dan penalaran yang
        dikosongkan memakai nilai <code>.env</code>.
      </p>

      <div className="mt-3 rounded-lg border border-line bg-panel">
        <div className="hidden gap-3 border-b border-line px-3 py-2 text-[10px] uppercase tracking-wide text-faint md:grid md:grid-cols-[10rem_8.5rem_minmax(0,1fr)_10rem_9rem]">
          <span>Bot</span>
          <span>Mesin</span>
          <span>Model</span>
          <span>Penalaran</span>
          <span>Mode</span>
        </div>
        {roles.map((role) => {
          const engine = settings.engines[role.id];
          const engineInfo = info(engine);
          const blocked = engines && !engineInfo?.available;
          return (
            <div
              key={role.id}
              className="grid grid-cols-2 gap-3 border-b border-line px-3 py-2.5 last:border-b-0 md:grid-cols-[10rem_8.5rem_minmax(0,1fr)_10rem_9rem] md:items-center"
            >
              <div className="col-span-2 min-w-0 md:col-span-1">
                <span className="block truncate text-sm text-ink" title={role.blurb}>
                  {role.title}
                </span>
                {blocked && (
                  <span className="block text-[11px] text-tag-yellow-ink" title={engineInfo?.reason}>
                    Akun {ENGINE_SHORT[engine]} belum siap
                  </span>
                )}
              </div>
              <Cell label="Mesin">
                <EngineChoice
                  label={role.title}
                  engine={engine}
                  engines={engines}
                  disabled={saving}
                  onPick={(id) => save({ engines: { ...settings.engines, [role.id]: id } })}
                />
              </Cell>
              <Cell label="Model">
                <ModelSelect
                  engine={engine}
                  info={engineInfo}
                  value={engine === "claude" ? settings.claudeModels[role.id] : settings.geminiModels[role.id]}
                  fallback={engine === "claude" ? settings.defaults.claudeModels[role.id] : engineInfo?.defaultModel}
                  disabled={saving}
                  onChange={(model) => save(modelPatch(engine, role.id, model))}
                />
              </Cell>
              <Cell label="Penalaran">
                <EffortSelect
                  value={settings.efforts[role.id]}
                  fallback={settings.defaults.efforts[role.id]}
                  disabled={saving}
                  onChange={(effort) => save({ efforts: { [role.id]: effort } })}
                />
              </Cell>
              <Cell label="Mode">
                <Select
                  value={settings.modes[role.id]}
                  disabled={saving}
                  onChange={(next) => save({ modes: { ...settings.modes, [role.id]: next as AutonomyMode } })}
                  ariaLabel={`Mode ${role.title}`}
                  title={MODE_NOTE[settings.modes[role.id]]}
                  className="w-full"
                  options={MODES.map((mode) => ({ value: mode, label: MODE_LABEL[mode], description: MODE_NOTE[mode] }))}
                />
              </Cell>
            </div>
          );
        })}
        <HelperRow
          label="Kurator memori"
          blurb="Merangkum temuan ke register project"
          modelKey="curator"
          engine={settings.curatorEngine}
          settings={settings}
          engines={engines}
          saving={saving}
          save={save}
          onPickEngine={(id) => save({ curatorEngine: id })}
        />
        <HelperRow
          label="Panel Tanya"
          blurb="Bawaan saat panel dibuka; bisa diganti per pertanyaan"
          modelKey="ask"
          engine={settings.askEngine}
          settings={settings}
          engines={engines}
          saving={saving}
          save={save}
          onPickEngine={(id) => save({ askEngine: id })}
        />
      </div>

      <p className="mt-2 text-xs text-faint">
        Panel Tanya hanya membaca; mesin dan modelnya bisa diganti di panel untuk tiap pertanyaan. Di mode{" "}
        <strong className="text-muted">Auto</strong>, empat kategori ini tetap memunculkan kartu persetujuan: service &amp;
        container, data &amp; database, kredensial/firewall/akses, hapus berkas &amp; paket. Perintah katastrofik tetap ditolak
        tanpa bisa disetujui.
      </p>
      {usesGemini && <GeminiRiskNote className="mt-2" />}
    </section>
  );
}
