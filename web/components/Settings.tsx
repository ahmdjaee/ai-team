import { useEffect, useState } from "react";
import { api, type RoleInfo, type SettingsView, type TaskListItem } from "../api.ts";
import type { SettingsPatch } from "../../server/settings.ts";
import { useEngines } from "../accounts.ts";
import { AccountsSection } from "./AccountsSection.tsx";
import { BotSettings } from "./BotSettings.tsx";
import { permissionState, requestPermission } from "../notifications.ts";

const NOTIF_LABEL: Array<[keyof SettingsView["notifications"], string]> = [
  ["approval", "Kartu persetujuan muncul"],
  ["question", "Agen bertanya"],
  ["needsReview", "Tugas selesai & perlu dibaca"],
  ["failed", "Tugas gagal"],
];

export function Settings({
  roles,
  tasks,
  onSaved,
}: {
  roles: RoleInfo[];
  tasks: TaskListItem[];
  onSaved: (settings: SettingsView) => void;
}) {
  const [settings, setSettings] = useState<SettingsView>();
  const [permission, setPermission] = useState(permissionState());
  const [saving, setSaving] = useState(false);
  const { engines } = useEngines();

  useEffect(() => {
    void api.settings().then(setSettings);
  }, []);

  const save = async (patch: SettingsPatch) => {
    setSaving(true);
    try {
      const next = await api.saveSettings(patch);
      setSettings(next);
      onSaved(next);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <p className="p-6 text-sm text-faint">Memuat pengaturan…</p>;

  return (
    <div className="h-full overflow-y-auto px-4 py-5 sm:px-6">
      <h2 className="text-sm font-semibold text-ink">Pengaturan</h2>

      <div className="mt-5">
        <AccountsSection tasks={tasks} />
      </div>

      <div className="mt-7">
        <BotSettings roles={roles} settings={settings} engines={engines} saving={saving} save={(patch) => void save(patch)} />
      </div>

      <section className="mt-7">
        <div className="flex items-center gap-3">
          <h3 className="text-xs uppercase tracking-wide text-muted">Notifikasi browser</h3>
          {permission === "granted" ? (
            <span className="rounded bg-tag-green px-2 py-0.5 text-[11px] text-tag-green-ink">izin diberikan</span>
          ) : permission === "unsupported" ? (
            <span className="rounded bg-tag-gray px-2 py-0.5 text-[11px] text-tag-gray-ink">tidak didukung browser</span>
          ) : (
            <button
              onClick={async () => setPermission(await requestPermission())}
              className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
            >
              {permission === "denied" ? "Izin ditolak — buka setelan situs" : "Izinkan notifikasi"}
            </button>
          )}
        </div>

        <div className="mt-3 space-y-1.5">
          {NOTIF_LABEL.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={settings.notifications[key]}
                onChange={(e) =>
                  void save({ notifications: { ...settings.notifications, [key]: e.target.checked } })
                }
              />
              {label}
            </label>
          ))}
          <label className="flex items-center gap-2 border-t border-line pt-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={settings.notifications.onlyWhenHidden}
              onChange={(e) =>
                void save({ notifications: { ...settings.notifications, onlyWhenHidden: e.target.checked } })
              }
            />
            Hanya saat tab tidak aktif
          </label>
        </div>
        <p className="mt-2 text-xs text-faint">
          Jumlah tugas yang menunggu keputusan Anda selalu tampil di judul tab, mis. “(2) AI Team”.
        </p>
      </section>
    </div>
  );
}
