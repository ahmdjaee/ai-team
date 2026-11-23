import { Link, Navigate, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  STATUS_LABEL,
  type ProjectInfo,
  type RoleId,
  type RoleInfo,
  type Settings as SettingsData,
  type TaskListItem,
  type TaskStatus,
} from "./api.ts";
import { Memory } from "./components/Memory.tsx";
import { NewTaskChat } from "./components/NewTaskChat.tsx";
import { ProjectPage } from "./components/ProjectPage.tsx";
import { Settings } from "./components/Settings.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";

export const TABS = ["work", "live", "report", "docs", "notes", "diff", "settings"] as const;
export type Tab = (typeof TABS)[number];

export function isTab(value: string | undefined): value is Tab {
  return TABS.includes(value as Tab);
}

export const ROLE_IDS: RoleId[] = ["qa", "engineer", "devops", "uiux"];
export const STATUSES = Object.keys(STATUS_LABEL) as TaskStatus[];

/**
 * Hanya filter daftar yang ikut berpindah halaman. `doc` sengaja ditinggal:
 * berkas lampiran milik satu tugas, tidak ada artinya di tugas lain.
 */
export function keepFilters(search: URLSearchParams | string): string {
  const source = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of ["project", "role", "status"]) {
    const value = source.get(key);
    if (value) kept.set(key, value);
  }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

export function projectPath(id: string, search?: URLSearchParams | string): string {
  return `/projects/${encodeURIComponent(id)}${search === undefined ? "" : keepFilters(search)}`;
}

export function taskPath(id: string, tab?: Tab, search?: URLSearchParams | string): string {
  return `/tasks/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}${search === undefined ? "" : keepFilters(search)}`;
}

export type AppContext = {
  tasks: TaskListItem[];
  tasksLoaded: boolean;
  roles: RoleInfo[];
  projects: ProjectInfo[];
  /** URL uji bawaan dari `.env`; project boleh punya sendiri. */
  targetUrl: string;
  refreshKey: number;
  refresh: () => void;
  onSettingsSaved: (next: SettingsData) => void;
};

/** Chat tugas baru (`/tasks/new`), dengan filter yang sedang aktif. */
export function newTaskPath(search?: URLSearchParams | string): string {
  return `/tasks/new${search === undefined ? "" : keepFilters(search)}`;
}

export function useAppContext(): AppContext {
  return useOutletContext<AppContext>();
}

/**
 * `/` → tugas teratas, dengan replace supaya Back tidak memantul ke sini lagi. Belum ada tugas: chat
 * utama yang masih kosong langsung terbuka, pesan pertama membuat tugasnya.
 */
export function TasksIndex() {
  const { tasks, tasksLoaded } = useAppContext();
  const [search] = useSearchParams();
  const project = search.get("project");
  // Saat project tertentu dipilih, jangan pernah melompat ke tugas project lain.
  const first = project ? tasks.find((task) => task.projectId === project) : tasks[0];

  if (first) return <Navigate to={taskPath(first.id, undefined, search)} replace />;
  if (!tasksLoaded) return <p className="p-6 text-sm text-faint">Memuat daftar tugas…</p>;
  return <NewTaskRoute />;
}

export function NewTaskRoute() {
  const { roles, projects, targetUrl, refresh } = useAppContext();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const project = search.get("project");
  return (
    <NewTaskChat
      roles={roles}
      projects={projects}
      defaultProjectId={(project && projects.some((item) => item.id === project) ? project : projects[0]?.id) ?? ""}
      defaultTargetUrl={targetUrl}
      onCreated={(id) => {
        navigate(taskPath(id, undefined, search));
        refresh();
      }}
    />
  );
}

export function TaskRoute() {
  const { id, tab } = useParams();
  const { roles, projects, targetUrl, refreshKey, refresh } = useAppContext();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const targetUrlFor = (projectId: string) => projects.find((item) => item.id === projectId)?.targetUrl || targetUrl;

  if (!id) return <Navigate to="/" replace />;
  // Tab yang tidak dikenal dikembalikan ke tab bawaan tugas itu, bukan ke daftar.
  if (tab !== undefined && !isTab(tab)) return <Navigate to={taskPath(id, undefined, search)} replace />;

  return (
    <TaskDetail
      taskId={id}
      tab={tab ?? "work"}
      tabInUrl={tab !== undefined}
      onTab={(next, replace) => navigate(taskPath(id, next, search), { replace })}
      roles={roles}
      targetUrlFor={targetUrlFor}
      refreshKey={refreshKey}
      onChanged={refresh}
    />
  );
}

export function ProjectRoute() {
  const { projectId } = useParams();
  const { projects, refresh } = useAppContext();
  if (!projectId) return <Navigate to="/" replace />;
  return <ProjectPage projectId={projectId} projects={projects} onChanged={refresh} />;
}

export function MemoryRoute() {
  return <Memory />;
}

export function SettingsRoute() {
  const { roles, tasks, onSettingsSaved } = useAppContext();
  return <Settings roles={roles} tasks={tasks} onSaved={onSettingsSaved} />;
}
