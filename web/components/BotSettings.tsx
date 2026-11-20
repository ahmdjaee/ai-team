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

const MODES: AutonomyMode[] = ["auto", "ask", "readonly"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ENGINE_IDS: EngineId[] = ["claude", "antigravity"];

const SELECT = "w-full min-w-0 rounded-lg border border-line bg-page px-2 py-1 text-xs text-ink disabled:opacity-50";

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
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      aria-label={`Model ${ENGINE_SHORT[engine]}`}
      title={selected ? `${selected.description ?? selected.name} — ${selected.id}` : fallback}
      className={SELECT}
    >
      <option value="">
        {engine === "claude" ? `Bawaan (.env: ${fallbackName ?? "—"})` : `Bawaan agy${fallbackName ? ` (${fallbackName})` : ""}`}
      </option>
      {models.map((item) => (
        <option key={item.id} value={item.id} title={`${item.description ?? ""} ${item.id}`.trim()}>
          {item.name}
        </option>
      ))}
      {value && !selected && <option value={value}>{value} (tidak terdaftar di akun)</option>}
    </select>
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
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange((event.target.value || null) as Effort | null)}
      aria-label="Tingkat penalaran"
      className={SELECT}
    >
      <option value="">Bawaan ({EFFORT_LABEL[fallback]})</option>
      {EFFORTS.map((effort) => (
        <option key={effort} value={effort}>
          {EFFORT_LABEL[effort]}
        </option>
      ))}
    </select>
  );
}

/**
 * Pengaturan → Bot: mesin, model, tingkat penalaran, dan mode bawaan tiap bot, plus model kurator.
 * Berlaku untuk tugas dan operan baru; tugas yang sudah jalan memakai pilihannya sendiri.
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
  const ready = ENGINE_IDS.filter((engine) => info(engine)?.available);
  const claude = info("claude");
  const usesGemini = roles.some((role) => settings.engines[role.id] === "antigravity");
  const modelPatch = (engine: EngineId, key: ModelKey, model: string | null): SettingsPatch =>
    engine === "claude" ? { claudeModels: { [key]: model } } : { geminiModels: { [key]: model } };

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
                {ready.length <= 1 && !blocked ? (
                  <span className="text-xs text-muted">{ENGINE_SHORT[engine]}</span>
                ) : (
                  <div className="flex gap-1" role="radiogroup" aria-label={`Mesin ${role.title}`}>
                    {ENGINE_IDS.map((id) => {
                      const available = info(id)?.available ?? false;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={engine === id}
                          disabled={saving || (!available && engine !== id)}
                          title={available ? undefined : info(id)?.reason}
                          onClick={() => save({ engines: { ...settings.engines, [role.id]: id } })}
                          className={`rounded-lg border px-2 py-0.5 text-[11px] disabled:opacity-40 ${
                            engine === id ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:border-line-strong"
                          }`}
                        >
                          {ENGINE_SHORT[id]}
                        </button>
                      );
                    })}
                  </div>
                )}
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
                <select
                  value={settings.modes[role.id]}
                  disabled={saving}
                  onChange={(event) => save({ modes: { ...settings.modes, [role.id]: event.target.value as AutonomyMode } })}
                  aria-label={`Mode ${role.title}`}
                  title={MODE_NOTE[settings.modes[role.id]]}
                  className={SELECT}
                >
                  {MODES.map((mode) => (
                    <option key={mode} value={mode} title={MODE_NOTE[mode]}>
                      {MODE_LABEL[mode]}
                    </option>
                  ))}
                </select>
              </Cell>
            </div>
          );
        })}
        <div className="grid grid-cols-2 gap-3 border-t border-line px-3 py-2.5 md:grid-cols-[10rem_8.5rem_minmax(0,1fr)_10rem_9rem] md:items-center">
          <div className="col-span-2 min-w-0 md:col-span-1">
            <span className="block text-sm text-ink">Kurator memori</span>
            <span className="block text-[11px] text-faint">Merangkum temuan ke register project</span>
          </div>
          <Cell label="Mesin">
            <span className="text-xs text-muted">Claude</span>
          </Cell>
          <Cell label="Model">
            <ModelSelect
              engine="claude"
              info={claude}
              value={settings.claudeModels.curator}
              fallback={settings.defaults.claudeModels.curator}
              disabled={saving}
              onChange={(model) => save({ claudeModels: { curator: model } })}
            />
          </Cell>
          <Cell label="Penalaran">
            <EffortSelect
              value={settings.efforts.curator}
              fallback={settings.defaults.efforts.curator}
              disabled={saving}
              onChange={(effort) => save({ efforts: { curator: effort } })}
            />
          </Cell>
          <span className="hidden text-xs text-faint md:block">—</span>
        </div>
      </div>

      <p className="mt-2 text-xs text-faint">
        Panel Tanya memakai model Claude bot QA (cepat) dan Engineer (analisis berat). Di mode{" "}
        <strong className="text-muted">Auto</strong>, empat kategori ini tetap memunculkan kartu persetujuan: service &amp;
        container, data &amp; database, kredensial/firewall/akses, hapus berkas &amp; paket. Perintah katastrofik tetap ditolak
        tanpa bisa disetujui.
      </p>
      {usesGemini && <GeminiRiskNote className="mt-2" />}
    </section>
  );
}
