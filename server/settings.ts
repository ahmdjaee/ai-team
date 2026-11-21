import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { ENGINE_IDS, isEffort, type AutonomyMode, type Effort, type EngineId, type RoleId } from "./types.ts";

export type NotificationSettings = {
  approval: boolean;
  question: boolean;
  needsReview: boolean;
  failed: boolean;
  /** true = notifikasi hanya muncul saat tab aplikasi tidak aktif. */
  onlyWhenHidden: boolean;
};

/** Bot, kurator memori, dan panel Tanya: semua yang punya model dan tingkat penalaran sendiri. */
export type ModelKey = RoleId | "curator" | "ask";

export type Settings = {
  modes: Record<RoleId, AutonomyMode>;
  /** Mesin bawaan tiap bot untuk tugas dan operan baru; penugasan yang sudah jalan tidak ikut berubah. */
  engines: Record<RoleId, EngineId>;
  /** Mesin kurator memori; kalau akunnya belum siap, kurator memakai mesin lain yang siap. */
  curatorEngine: EngineId;
  /** Mesin bawaan panel Tanya (bisa diganti per pertanyaan); kalau akunnya belum siap, mesin lain yang siap. */
  askEngine: EngineId;
  /** Model Antigravity per bot, kurator, dan Tanya (id dari daftar model `agy`); kosong = model bawaan agy. */
  geminiModels: Partial<Record<ModelKey, string>>;
  /** Model Claude per bot, kurator, dan Tanya (id dari daftar model akun); kosong = `MODEL_*` di `.env`. */
  claudeModels: Partial<Record<ModelKey, string>>;
  /** Tingkat penalaran per bot, kurator, dan Tanya; kosong = `EFFORT_*` di `.env`. */
  efforts: Partial<Record<ModelKey, Effort>>;
  notifications: NotificationSettings;
};

/** Nilai `.env` yang berlaku kalau Pengaturan kosong, untuk label "Bawaan" di UI. */
export type ModelDefaults = { claudeModels: Record<ModelKey, string>; efforts: Record<ModelKey, Effort> };

const PATH = join(CONFIG.dataDir, "settings.json");
const MODES: AutonomyMode[] = ["auto", "ask", "readonly"];
const ROLE_KEYS: RoleId[] = ["qa", "engineer", "devops", "uiux"];
const MODEL_KEYS: ModelKey[] = [...ROLE_KEYS, "curator", "ask"];
/**
 * Id model: huruf, angka, titik, tanda hubung, garis bawah, dan kurung siku (mis.
 * `gemini-3.8-flash`, `claude-opus-5-5`, `sonnet[1m]`). Tidak ada spasi atau karakter shell.
 */
const MODEL_ID = /^[a-z0-9][a-z0-9._\-[\]]{0,79}$/i;

export function validModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

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
    curatorEngine: "claude",
    askEngine: "claude",
    geminiModels: {},
    claudeModels: {},
    efforts: {},
    notifications: { approval: true, question: true, needsReview: true, failed: true, onlyWhenHidden: true },
  };
}

/** Buang nilai yang tidak dikenal: settings.json bisa disunting tangan, dan PUT tidak divalidasi skema. */
function sanitize(settings: Settings): Settings {
  for (const role of ROLE_KEYS) {
    if (!MODES.includes(settings.modes[role])) settings.modes[role] = "ask";
    if (!ENGINE_IDS.includes(settings.engines[role])) settings.engines[role] = "claude";
  }
  if (!ENGINE_IDS.includes(settings.curatorEngine)) settings.curatorEngine = "claude";
  if (!ENGINE_IDS.includes(settings.askEngine)) settings.askEngine = "claude";
  for (const key of Object.keys(settings.geminiModels)) {
    if (!MODEL_KEYS.includes(key as ModelKey) || !validModelId(settings.geminiModels[key as ModelKey])) {
      delete settings.geminiModels[key as ModelKey];
    }
  }
  for (const key of Object.keys(settings.claudeModels)) {
    if (!MODEL_KEYS.includes(key as ModelKey) || !validModelId(settings.claudeModels[key as ModelKey])) {
      delete settings.claudeModels[key as ModelKey];
    }
  }
  for (const key of Object.keys(settings.efforts)) {
    if (!MODEL_KEYS.includes(key as ModelKey) || !isEffort(settings.efforts[key as ModelKey])) delete settings.efforts[key as ModelKey];
  }
  return settings;
}

/** Salinan objek peta dari JSON: abaikan yang bukan objek biasa. */
function record<T>(value: unknown): Partial<Record<string, T>> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, T>) } : {};
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
        curatorEngine: stored.curatorEngine ?? base.curatorEngine,
        askEngine: stored.askEngine ?? base.askEngine,
        geminiModels: record<string>(stored.geminiModels),
        claudeModels: record<string>(stored.claudeModels),
        efforts: record<Effort>(stored.efforts),
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

export type SettingsPatch = Partial<Omit<Settings, "geminiModels" | "claudeModels" | "efforts">> & {
  geminiModels?: Partial<Record<ModelKey, string | null>>;
  claudeModels?: Partial<Record<ModelKey, string | null>>;
  efforts?: Partial<Record<ModelKey, Effort | null>>;
};

/** Terapkan patch peta: `null`/"" = hapus kunci itu (kembali ke bawaan); nilai tidak sah diabaikan. */
function merge<T>(current: Partial<Record<string, T>>, patch: unknown, valid: (value: unknown) => boolean): Partial<Record<string, T>> {
  const next = { ...current };
  for (const [key, value] of Object.entries(record<T | null | "">(patch))) {
    if (value === null || value === "" || value === undefined) delete next[key];
    else if (valid(value)) next[key] = value as T;
  }
  return next;
}

export function updateSettings(patch: SettingsPatch): Settings {
  const current = getSettings();
  const next = sanitize({
    modes: { ...current.modes, ...(patch.modes ?? {}) },
    engines: { ...current.engines, ...(patch.engines ?? {}) },
    curatorEngine: patch.curatorEngine ?? current.curatorEngine,
    askEngine: patch.askEngine ?? current.askEngine,
    geminiModels: merge(current.geminiModels, patch.geminiModels, validModelId),
    claudeModels: merge(current.claudeModels, patch.claudeModels, validModelId),
    efforts: merge(current.efforts, patch.efforts, isEffort),
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

/** Pilihan model di Pengaturan untuk mesin ini, tanpa jatuh ke `.env`; undefined = bawaan. */
export function modelSetting(key: ModelKey, engine: EngineId): string | undefined {
  return engine === "claude" ? getSettings().claudeModels[key] : getSettings().geminiModels[key];
}

/**
 * Model yang benar-benar dipakai: pilihan per penugasan, lalu Pengaturan, lalu `.env` (Claude).
 * Untuk Gemini undefined berarti model bawaan akun agy.
 */
export function modelFor(key: ModelKey, engine: EngineId, override?: string): string | undefined {
  if (override) return override;
  return modelSetting(key, engine) ?? (engine === "claude" ? CONFIG.models[key] : undefined);
}

/** Tingkat penalaran: Pengaturan, lalu `.env`. */
export function effortFor(key: ModelKey): Effort {
  return getSettings().efforts[key] ?? CONFIG.effort[key];
}

export function modelDefaults(): ModelDefaults {
  return { claudeModels: { ...CONFIG.models }, efforts: { ...CONFIG.effort } };
}
