import { useEffect, useState } from "react";
import { api, type EngineId, type ProjectInfo, type RoleId, type RoleInfo, type SettingsView } from "../api.ts";
import { Combobox } from "./Combobox.tsx";
import { ENGINE_SHORT, EnginePicker, GeminiRiskNote, botDefaultModel, modelName, usableEngine, useEngines } from "./EnginePicker.tsx";

export function NewTaskDialog({
  roles,
  projects,
  defaultProjectId,
  defaultTargetUrl,
  onClose,
  onCreated,
}: {
  roles: RoleInfo[];
  projects: ProjectInfo[];
  defaultProjectId: string;
  defaultTargetUrl: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<RoleId>("qa");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const project = projects.find((item) => item.id === projectId);
  const [targetUrl, setTargetUrl] = useState(project?.targetUrl ?? defaultTargetUrl);
  const [touchedTarget, setTouchedTarget] = useState(false);
  const [sending, setSending] = useState(false);
  const { engines } = useEngines();
  const [settings, setSettings] = useState<SettingsView>();
  const [engine, setEngine] = useState<EngineId>("claude");
  const [model, setModel] = useState<string>();
  /** Mesin mengikuti setelan bot yang dipilih, sampai Anda memilih sendiri. */
  const [touchedEngine, setTouchedEngine] = useState(false);

  useEffect(() => {
    void api.settings().then(setSettings, () => undefined);
  }, []);

  // Model kosong = bawaan bot; server mengisinya dari Pengaturan saat tugas dibuat. Kalau mesin
  // bawaan bot belum punya akun, mesin lain yang siap dipakai.
  useEffect(() => {
    if (touchedEngine || !settings) return;
    setEngine(usableEngine(settings.engines[role], engines));
    setModel(undefined);
  }, [role, settings, touchedEngine, engines]);
  const engineReady = engines?.find((item) => item.id === engine)?.available ?? false;
  const switched = settings && !touchedEngine && engines && engine !== settings.engines[role];

  // Ganti project → kolom target ikut berganti, selama Anda belum mengisinya sendiri.
  useEffect(() => {
    if (!touchedTarget) setTargetUrl(project?.targetUrl ?? defaultTargetUrl);
  }, [projectId, project?.targetUrl, defaultTargetUrl, touchedTarget]);

  const selected = roles.find((item) => item.id === role);

  const submit = async () => {
    if (!title.trim() || sending) return;
    setSending(true);
    try {
      const { task } = await api.createTask({
        title: title.trim(),
        description: description.trim() || title.trim(),
        role,
        projectId,
        targetUrl: selected?.usesBrowser ? targetUrl.trim() || undefined : undefined,
        engine,
        model,
      });
      onCreated(task.id);
      onClose();
    } catch (error) {
      alert((error as Error).message);
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-scrim p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-line bg-raised p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ink">Tugas baru</h3>

        <label className="mt-4 block text-xs text-muted">Project</label>
        <div className="mt-1">
          <Combobox
            value={projectId}
            options={projects.map((item) => ({
              value: item.id,
              label: item.name,
              hint: item.workspaceDir,
              badge: String(item.taskCount),
            }))}
            onChange={setProjectId}
            ariaLabel="Pilih project tugas"
            searchPlaceholder="Cari project…"
          />
        </div>
        <p className="mt-1 text-[11px] text-faint">
          Bot membaca konteks & memori project ini, dan bekerja di{" "}
          <span className="font-mono text-muted">{project?.workspaceDir ?? "folder bawaan"}</span>.
        </p>

        <label className="mt-3 block text-xs text-muted">Judul</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="mis. Uji alur login staging"
          className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        <label className="mt-3 block text-xs text-muted">Instruksi untuk bot</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          placeholder="Jelaskan apa yang harus dikerjakan, batasannya, dan apa yang Anda anggap selesai."
          className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        <label className="mt-3 block text-xs text-muted">Tugaskan ke</label>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {roles.map((item) => (
            <button
              key={item.id}
              onClick={() => setRole(item.id)}
              title={item.blurb}
              className={`flex-1 rounded-lg border px-3 py-2 text-left ${
                role === item.id ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"
              }`}
            >
              <span className="block text-sm text-ink">{item.title}</span>
              <span className="block truncate font-mono text-[10px] text-muted">
                {(() => {
                  const botEngine = settings?.engines[item.id] ?? "claude";
                  const info = engines?.find((entry) => entry.id === botEngine);
                  const name = modelName(info?.models, botDefaultModel(settings, item.id, botEngine) ?? (botEngine === "claude" ? item.model : undefined));
                  return `${ENGINE_SHORT[botEngine]}${name ? ` · ${name}` : ""}`;
                })()}
              </span>
            </button>
          ))}
        </div>

        <label className="mt-3 block text-xs text-muted">Mesin</label>
        <div className="mt-1">
          <EnginePicker
            engines={engines}
            engine={engine}
            model={model}
            defaultModel={botDefaultModel(settings, role, engine) ?? (engine === "claude" ? selected?.model : undefined)}
            onChange={(next, nextModel) => {
              setTouchedEngine(true);
              setEngine(next);
              setModel(nextModel);
            }}
          />
        </div>
        {switched && (
          <p className="mt-1 text-[11px] text-faint">
            Mesin bawaan bot ini ({ENGINE_SHORT[settings.engines[role]]}) belum punya akun, jadi tugas ini memakai {ENGINE_SHORT[engine]}.
          </p>
        )}
        {engine === "antigravity" && <GeminiRiskNote className="mt-1" />}

        {selected?.usesBrowser && (
          <>
            <label className="mt-3 block text-xs text-muted">URL yang diuji</label>
            <input
              value={targetUrl}
              onChange={(e) => {
                setTouchedTarget(true);
                setTargetUrl(e.target.value);
              }}
              placeholder="https://staging.contoh.com/login"
              className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-faint">Tugas langsung dikerjakan begitu ada slot.</span>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Batal
          </button>
          <button
            onClick={() => void submit()}
            disabled={!title.trim() || sending || !engineReady}
            title={engineReady ? undefined : "Mesin ini belum punya akun yang siap — lihat Pengaturan → Akun AI"}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            Buat & jalankan
          </button>
        </div>
      </div>
    </div>
  );
}
