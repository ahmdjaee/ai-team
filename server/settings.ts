import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { ENGINE_IDS, type AutonomyMode, type EngineId, type RoleId } from "./types.ts";

export type NotificationSettings = {
  approval: boolean;
  question: boolean;
  needsReview: boolean;
  failed: boolean;
  /** true = notifikasi hanya muncul saat tab aplikasi tidak aktif. */
  onlyWhenHidden: boolean;
};

export type Settings = {
  modes: Record<RoleId, AutonomyMode>;
  /** Mesin bawaan tiap bot untuk tugas dan operan baru; penugasan yang sudah jalan tidak ikut berubah. */
  engines: Record<RoleId, EngineId>;
  /** Model Antigravity per bot (id dari daftar model `agy`); kosong = model bawaan agy. */
  geminiModels: Partial<Record<RoleId, string>>;
  notifications: NotificationSettings;
};

const PATH = join(CONFIG.dataDir, "settings.json");
const MODES: AutonomyMode[] = ["auto", "ask", "readonly"];
const ROLE_KEYS: RoleId[] = ["qa", "engineer", "devops", "uiux"];
/** Id model agy: huruf, angka, titik, dan tanda hubung saja (mis. `gemini-3.8-flash`). */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/i;

/** `.env` hanya dipakai sebagai nilai awal; setelah itu Pengaturan di aplikasi yang berlaku. */
function envMode(name: string): AutonomyMode {
  const value = process.env[name];
  return MODES.includes(value as AutonomyMode) ? (value as AutonomyMode) : "ask";
}

function defaults(): Settings {
  return {
    modes: {
      qa: envMode("AUTONOMY_QA"),
      engineer: envMode("AUTONOMY_ENGINEER"),
      devops: envMode("AUTONOMY_DEVOPS"),
      uiux: envMode("AUTONOMY_UIUX"),
    },
    engines: { qa: "claude", engineer: "claude", devops: "claude", uiux: "claude" },
    geminiModels: {},
    notifications: { approval: true, question: true, needsReview: true, failed: true, onlyWhenHidden: true },
  };
}

/** Buang nilai yang tidak dikenal: settings.json bisa disunting tangan, dan PUT tidak divalidasi skema. */
function sanitize(settings: Settings): Settings {
  for (const role of ROLE_KEYS) {
    if (!MODES.includes(settings.modes[role])) settings.modes[role] = "ask";
    if (!ENGINE_IDS.includes(settings.engines[role])) settings.engines[role] = "claude";
    const model = settings.geminiModels[role];
    if (model !== undefined && (typeof model !== "string" || !MODEL_ID.test(model))) delete settings.geminiModels[role];
  }
  for (const key of Object.keys(settings.geminiModels)) {
    if (!ROLE_KEYS.includes(key as RoleId)) delete settings.geminiModels[key as RoleId];
  }
  return settings;
}

let cache: Settings | undefined;

export function getSettings(): Settings {
  if (cache) return cache;
  const base = defaults();
  if (existsSync(PATH)) {
    try {
      const stored = JSON.parse(readFileSync(PATH, "utf8")) as Partial<Settings>;
      cache = sanitize({
        modes: { ...base.modes, ...(stored.modes ?? {}) },
        engines: { ...base.engines, ...(stored.engines ?? {}) },
        geminiModels: { ...(stored.geminiModels ?? {}) },
        notifications: { ...base.notifications, ...(stored.notifications ?? {}) },
      });
      return cache;
    } catch {
      // berkas rusak: pakai bawaan
    }
  }
  cache = base;
  return cache;
}

export type SettingsPatch = Partial<Omit<Settings, "geminiModels">> & {
  geminiModels?: Partial<Record<RoleId, string | null>>;
};

export function updateSettings(patch: SettingsPatch): Settings {
  const current = getSettings();
  const geminiModels = { ...current.geminiModels };
  // `null`/"" di patch = kembali ke model bawaan agy.
  for (const [role, model] of Object.entries(patch.geminiModels ?? {})) {
    if (model === null || model === "") delete geminiModels[role as RoleId];
    else geminiModels[role as RoleId] = model;
  }
  const next = sanitize({
    modes: { ...current.modes, ...(patch.modes ?? {}) },
    engines: { ...current.engines, ...(patch.engines ?? {}) },
    geminiModels,
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  });
  const tmp = `${PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, PATH);
  cache = next;
  return next;
}

export function defaultModeFor(role: RoleId): AutonomyMode {
  return getSettings().modes[role];
}

export function defaultEngineFor(role: RoleId): EngineId {
  return getSettings().engines[role];
}

export function geminiModelFor(role: RoleId): string | undefined {
  return getSettings().geminiModels[role];
}
