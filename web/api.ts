import type {
  AccountView,
  AttentionEvent,
  AutonomyMode,
  ContextUsage,
  Effort,
  EngineId,
  ModelOption,
  ProviderId,
  RoleId,
  StoredEvent,
  UiEvent,
  WorkerStatus,
} from "../server/types.ts";
import type { ModelDefaults, ModelKey, Settings, SettingsPatch } from "../server/settings.ts";
import type { Assignment, Review, Task, TaskStatus, TaskSummary } from "../server/tasks.ts";
import type { Project } from "../server/projects.ts";
import type { AskDefaults, AskMessage } from "../server/agent/ask.ts";
import type { DeletedRef } from "../server/deleted-tasks.ts";
import type {
  DeletedRecapEntry,
  ProjectRecap,
  RecapEntry,
  RecapFinding,
  RecapSeverity,
  RecapTone,
  RecapTotals,
  RecapVerdict,
} from "../server/recap.ts";

export type { AskDefaults, AskMessage, Assignment, AttentionEvent, AutonomyMode, ContextUsage, EngineId, Project, RoleId, Review, Settings, StoredEvent, Task, TaskStatus, TaskSummary, UiEvent, WorkerStatus };

export type { AccountView, Effort, ModelDefaults, ModelKey, ModelOption, ProviderId };

/** Pengaturan dari server plus nilai `.env` yang berlaku kalau model/penalaran dikosongkan. */
export type SettingsView = Settings & { defaults: ModelDefaults };

export type EngineInfo = {
  id: EngineId;
  label: string;
  available: boolean;
  reason?: string;
  version?: string;
  models?: ModelOption[];
  defaultModel?: string;
  checkedAt?: string;
};

export const EFFORT_LABEL: Record<Effort, string> = {
  low: "Rendah",
  medium: "Sedang",
  high: "Tinggi",
  xhigh: "Sangat tinggi",
  max: "Maksimal",
};
export type { DeletedRecapEntry, DeletedRef, ProjectRecap, RecapEntry, RecapFinding, RecapSeverity, RecapTone, RecapTotals, RecapVerdict };
export type { CoverageCell, CoverageState, Finding, FindingSeverity, FindingStatus, UnlinkedFinding } from "../server/findings.ts";
export type { CuratorStatus } from "../server/agent/curator.ts";

export type { ReportRound } from "../server/recap.ts";
export type { TaskFinding, TaskUnlinkedFinding } from "../server/task-report.ts";

export type TaskReportView = {
  hasReport: boolean;
  verdict: RecapVerdict | null;
  rounds: import("../server/recap.ts").ReportRound[];
  assets: string[];
  opened: import("../server/task-report.ts").TaskFinding[];
  resolved: import("../server/task-report.ts").TaskFinding[];
  unlinked: import("../server/task-report.ts").TaskUnlinkedFinding[];
};

export type CurationLogItem = {
  at: string;
  by: string;
  action: string;
  target?: string;
  detail: string;
  revertible: boolean;
};

export type ProjectReport = {
  projectId: string;
  generatedAt: string;
  state: string;
  findings: import("../server/findings.ts").Finding[];
  unlinked: import("../server/findings.ts").UnlinkedFinding[];
  counts: Record<string, number>;
  coverage: import("../server/findings.ts").CoverageCell[];
  /** Tugas dihapus yang masih dirujuk register, cakupan, atau rekap — diberi label "dihapus". */
  deletedTasks: Record<string, DeletedRef>;
  curator: import("../server/agent/curator.ts").CuratorStatus;
  log: CurationLogItem[];
  recap: ProjectRecap;
};

/** Project + angka ringkas untuk pemilih sidebar dan halaman Project. */
export type ProjectInfo = Project & {
  /** Workspace efektif (folder sendiri kalau diisi, kalau tidak folder bawaan aplikasi). */
  workspaceDir: string;
  ownWorkspaceDir?: string;
  taskCount: number;
  waitingCount: number;
  reviewCount: number;
  costUsd: number;
};

export type ProjectDetail = { project: ProjectInfo; context: string; memory: string; tasks: TaskSummary[] };

export type RoleInfo = {
  id: RoleId;
  title: string;
  blurb: string;
  /** Model Claude yang berlaku (Pengaturan, lalu `.env`). */
  model: string;
  effort: Effort;
  engine: EngineId;
  producesReport: boolean;
  usesBrowser: boolean;
};

export type Slots = { inUse: number; max: number; runners: number; workspaceBusy: boolean };

/** Keadaan tab Live; didorong server (event `live` di WebSocket) dan ikut di detail tugas. */
export type LiveState = {
  active: boolean;
  url?: string;
  title?: string;
  hasFrame?: boolean;
  /** Ukuran viewport halaman bot (px CSS), untuk memetakan koordinat ke gambar Live. */
  viewport?: { width: number; height: number };
  /** Owner memegang kendali browser sejak (ms epoch); agen menunggu. */
  controlledSince?: number;
};

/** Aksi bot di browser untuk overlay Live (topik `live:<id>`); lihat server/browser/live.ts. */
export type BrowserAction = {
  kind: "open" | "click" | "fill" | "press" | "hover" | "select" | "scroll" | "upload" | "shot" | "read";
  label: string;
  box?: { x: number; y: number; width: number; height: number };
  point?: { x: number; y: number };
  text?: string;
  key?: string;
  at: number;
};

export type TaskListItem = TaskSummary & { live?: boolean };

/** Lampiran: berkas teks lain di folder tugas, selain report.md dan gambar bukti. */
export type DocInfo = { path: string; size: number; mtime: string };
export type DocContent = DocInfo & { text?: string; truncated?: boolean; binary?: boolean };

export type TaskDetail = {
  task: Task;
  project?: { id: string; name: string; workspaceDir: string };
  events: StoredEvent[];
  /** Masih ada event lebih lama di server daripada jendela yang dikirim. */
  eventsHasMore?: boolean;
  openRequests: UiEvent[];
  runnerStatus: WorkerStatus;
  assets: string[];
  docs: DocInfo[];
  report: string | null;
  /** Ada isinya atau tidak — dipakai untuk menandai tab Catatan. */
  hasNotes: boolean;
  live: LiveState;
  mode: AutonomyMode;
};

function docUrl(id: string, path: string, raw = false): string {
  return `/api/tasks/${encodeURIComponent(id)}/doc${raw ? "/raw" : ""}?path=${encodeURIComponent(path)}`;
}

/** Tautan unduh lampiran apa adanya (dipakai di href, bukan lewat fetch). */
export function docRawUrl(id: string, path: string): string {
  return docUrl(id, path, true);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type TaskDraft = { text: string; attachments: string[] };

export function attachmentUrl(taskId: string, file: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(file)}`;
}

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif)$/i;
export const isImageFile = (name: string): boolean => IMAGE_FILE_RE.test(name);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(detail.error ?? `${response.status} ${response.statusText}`, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  roles: () =>
    request<{ workspaceDir: string; targetUrl: string; slots: Slots; roles: RoleInfo[] }>("/api/roles"),

  tasks: (filter?: { role?: RoleId | ""; status?: TaskStatus | ""; project?: string }) => {
    const params = new URLSearchParams();
    if (filter?.role) params.set("role", filter.role);
    if (filter?.status) params.set("status", filter.status);
    if (filter?.project) params.set("project", filter.project);
    const query = params.toString();
    return request<{ tasks: TaskListItem[]; slots: Slots }>(`/api/tasks${query ? `?${query}` : ""}`);
  },
  /** `events` membatasi jendela transcript; `before` mengambil yang lebih lama dari seq itu. */
  task: (id: string, opts?: { events?: number; before?: number }) => {
    const params = new URLSearchParams();
    if (opts?.events !== undefined) params.set("events", String(opts.events));
    if (opts?.before !== undefined) params.set("before", String(opts.before));
    const query = params.toString();
    return request<TaskDetail>(`/api/tasks/${id}${query ? `?${query}` : ""}`);
  },
  /** Detail tanpa transcript — untuk menyegarkan header/tab tanpa menarik ribuan event. */
  taskMeta: (id: string) => request<TaskDetail>(`/api/tasks/${id}?events=0`),
  /** Hanya teks report.md — jauh lebih ringan daripada api.task() untuk menampilkan laporan. */
  taskReport: (id: string) => request<{ text: string | null }>(`/api/tasks/${id}/report`),
  taskReportView: (id: string) => request<TaskReportView>(`/api/tasks/${encodeURIComponent(id)}/report-view`),
  taskFindingsMarkdownUrl: (id: string) => `/api/tasks/${encodeURIComponent(id)}/findings.md`,
  taskDoc: (id: string, path: string) => request<DocContent>(docUrl(id, path)),
  taskNotes: (id: string) => request<{ text: string }>(`/api/tasks/${id}/notes`),
  askHistory: (id: string) =>
    request<{ messages: AskMessage[]; busy: boolean; costUsd: number; defaults: AskDefaults }>(
      `/api/tasks/${id}/ask`,
    ),
  ask: (id: string, body: { text: string; engine?: EngineId; model?: string }) =>
    request<{ message: AskMessage }>(`/api/tasks/${id}/ask`, { method: "POST", body: JSON.stringify(body) }),
  clearAsk: (id: string) => request<{ ok: true }>(`/api/tasks/${id}/ask`, { method: "DELETE" }),
  saveTaskNotes: (id: string, text: string) =>
    request<{ text: string }>(`/api/tasks/${id}/notes`, { method: "PUT", body: JSON.stringify({ text }) }),
  taskDraft: (id: string) => request<TaskDraft>(`/api/tasks/${id}/draft`),
  /** Satu berkas, body mentah — bukan lewat `request` karena itu selalu memasang content-type JSON. */
  uploadAttachment: async (id: string, file: File) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/attachments?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      const message = response.status === 413 ? "berkas lebih dari 25 MB" : (detail.error ?? `${response.status} ${response.statusText}`);
      throw new ApiError(message, response.status);
    }
    return (await response.json()) as { file: string; size: number; image: boolean };
  },
  deleteAttachment: (id: string, file: string) =>
    request<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(file)}`, { method: "DELETE" }),
  engines: (refresh = false) => request<{ engines: EngineInfo[] }>(`/api/engines${refresh ? "?refresh=1" : ""}`),
  /** Tanpa `title`, server memberi judul dari pesan pertama lalu judul otomatis menyusul. */
  createTask: (body: {
    title?: string;
    description: string;
    role: RoleId;
    projectId: string;
    targetUrl?: string;
    engine?: EngineId;
    model?: string;
    /** Tahan pesan pembuka sampai lampiran terunggah dan `startTask` dipanggil. */
    hold?: boolean;
  }) =>
    request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  startTask: (id: string, attachments: string[] = []) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/start`, { method: "POST", body: JSON.stringify({ attachments }) }),
  /** `targetUrl` hanya kalau URL uji di kotak chat diganti; bot diberi tahu di pesan ini. */
  message: (id: string, text: string, attachments: string[] = [], targetUrl?: string) =>
    request<{ ok: true }>(`/api/tasks/${id}/message`, { method: "POST", body: JSON.stringify({ text, attachments, targetUrl }) }),
  interrupt: (id: string) => request<{ ok: true }>(`/api/tasks/${id}/interrupt`, { method: "POST" }),
  cancel: (id: string) => request<{ ok: true }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  /** `confirm` harus sama persis dengan ID tugas — server menolak kalau tidak. */
  deleteTask: (id: string, confirm: string) =>
    request<{ ok: true; projectId: string }>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm }),
    }),
  handoff: (
    id: string,
    body: { role: RoleId; note?: string; engine?: EngineId; model?: string; targetUrl?: string; attachments?: string[] },
  ) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/handoff`, { method: "POST", body: JSON.stringify(body) }),
  review: (id: string, body: { status: "approved" | "changes_requested"; comment: string; sendBackToAgent: boolean }) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/review`, { method: "POST", body: JSON.stringify(body) }),

  approve: (id: string, body: { decision: "allow" | "deny"; message?: string; remember?: boolean }) =>
    request<{ ok: true }>(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify(body) }),
  answer: (id: string, answers: Record<string, string>) =>
    request<{ ok: true }>(`/api/questions/${id}`, { method: "POST", body: JSON.stringify({ answers }) }),

  renameTask: (id: string, title: string) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  setMode: (id: string, mode: AutonomyMode) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/mode`, { method: "POST", body: JSON.stringify({ mode }) }),
  settings: () => request<SettingsView>("/api/settings"),
  saveSettings: (patch: SettingsPatch) =>
    request<SettingsView>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  accounts: () => request<{ accounts: AccountView[] }>("/api/accounts"),
  startLogin: (provider: ProviderId) =>
    request<{ account: AccountView }>(`/api/accounts/${provider}/login`, { method: "POST" }),
  submitLoginCode: (provider: ProviderId, code: string) =>
    request<{ account: AccountView }>(`/api/accounts/${provider}/login/code`, { method: "POST", body: JSON.stringify({ code }) }),
  /** Batalkan login yang berjalan, atau tutup hasil login yang sudah selesai. */
  closeLogin: (provider: ProviderId) => request<{ account: AccountView }>(`/api/accounts/${provider}/login`, { method: "DELETE" }),
  checkAccount: (provider: ProviderId) => request<{ account: AccountView }>(`/api/accounts/${provider}/check`, { method: "POST" }),
  logoutAccount: (provider: ProviderId) => request<{ account: AccountView }>(`/api/accounts/${provider}/logout`, { method: "POST" }),

  projects: () => request<{ projects: ProjectInfo[] }>("/api/projects"),
  project: (id: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  projectRecap: (id: string) => request<ProjectRecap>(`/api/projects/${encodeURIComponent(id)}/recap`),
  projectReport: (id: string) => request<ProjectReport>(`/api/projects/${encodeURIComponent(id)}/report`),
  projectReportMarkdownUrl: (id: string) => `/api/projects/${encodeURIComponent(id)}/report.md`,
  projectFindingsMarkdownUrl: (id: string) => `/api/projects/${encodeURIComponent(id)}/findings.md`,
  curate: (id: string) => request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/curate`, { method: "POST" }),
  patchFinding: (id: string, fid: string, body: { status?: string; note?: string; verified?: boolean; mergeInto?: string }) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/findings/${encodeURIComponent(fid)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  revertCuration: (id: string, entry: { at: string; action?: string; target?: string }) =>
    request<{ ok: true; detail: string }>(`/api/projects/${encodeURIComponent(id)}/curation-log/revert`, {
      method: "POST",
      body: JSON.stringify(entry),
    }),
  createProject: (body: { name: string; targetUrl?: string; workspaceDir?: string }) =>
    request<{ project: ProjectInfo }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  patchProject: (id: string, patch: { name?: string; targetUrl?: string; workspaceDir?: string; archived?: boolean }) =>
    request<{ project: ProjectInfo }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  saveProjectContext: (id: string, text: string) =>
    request<{ text: string }>(`/api/projects/${encodeURIComponent(id)}/context`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  saveProjectMemory: (id: string, text: string) =>
    request<{ text: string }>(`/api/projects/${encodeURIComponent(id)}/memory`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteProject: (id: string) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  moveTask: (id: string, projectId: string) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/project`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),

  memory: () => request<{ text: string }>("/api/memory"),
  saveMemory: (text: string) =>
    request<{ text: string }>("/api/memory", { method: "PUT", body: JSON.stringify({ text }) }),

  diff: (projectId?: string) =>
    request<{
      isRepo: boolean;
      dir: string;
      branch: string;
      status: string;
      /** Gabungan staged + unstaged (kompatibilitas). */
      diff: string;
      staged: string;
      unstaged: string;
      untracked: string;
    }>(
      `/api/workspace/diff${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
    ),
};

export const ROLE_SHORT: Record<RoleId, string> = { qa: "QA", engineer: "Engineer", devops: "DevOps", uiux: "UI/UX" };

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "antre",
  running: "dikerjakan",
  waiting: "butuh Anda",
  needs_review: "perlu dibaca",
  done: "selesai",
  failed: "gagal",
  cancelled: "dibatalkan",
};

export const STATUS_STYLE: Record<TaskStatus, string> = {
  queued: "bg-tag-gray text-tag-gray-ink",
  running: "bg-tag-blue text-tag-blue-ink",
  waiting: "bg-tag-yellow text-tag-yellow-ink",
  needs_review: "bg-tag-orange text-tag-orange-ink",
  done: "bg-tag-green text-tag-green-ink",
  failed: "bg-tag-red text-tag-red-ink",
  cancelled: "bg-hover text-muted",
};

export const MODE_LABEL: Record<AutonomyMode, string> = {
  auto: "Auto",
  ask: "Minta approval",
  readonly: "Hanya baca",
};

export const MODE_NOTE: Record<AutonomyMode, string> = {
  auto: "Agen menjalankan perintahnya sendiri; hanya kategori kritis yang masih ditanyakan.",
  ask: "Perilaku seperti sekarang: perintah di luar daftar aman memunculkan kartu persetujuan.",
  readonly: "Agen hanya boleh menyelidiki dan menyusun rencana, tidak mengubah apa pun.",
};
