import type { AttentionEvent } from "../server/types.ts";
import type { NotificationSettings } from "../server/settings.ts";
import { subscribe } from "./realtime.ts";

export type { AttentionEvent, NotificationSettings };

const BASE_TITLE = "AI Team";

/**
 * `insecure` = halaman bukan secure context (mis. `http://ai-team.local`). Browser lalu menolak Notification API
 * tanpa pernah bertanya, dan setelan situs pun tidak bisa mengubahnya. Satu-satunya jalan adalah pindah alamat.
 */
export type PermissionView = NotificationPermission | "unsupported" | "insecure";

export function permissionState(): PermissionView {
  if (!window.isSecureContext) return "insecure";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Harus dipanggil dari gestur pengguna (tombol di Pengaturan). */
export async function requestPermission(): Promise<PermissionView> {
  const state = permissionState();
  if (state !== "default") return state;
  return await Notification.requestPermission();
}

/**
 * Alamat aman untuk halaman yang sama: alias `ai-team.localhost` lewat nginx, atau server app langsung.
 * Lewat nginx (port kosong), port app tidak terlihat dari sini, jadi dipakai port bawaan 4320.
 */
export function secureAddresses(): Array<{ label: string; href: string }> {
  const port = location.port || "4320";
  const path = `${location.pathname}${location.search}`;
  return [
    { label: "ai-team.localhost", href: `http://ai-team.localhost${path}` },
    { label: `localhost:${port}`, href: `http://localhost:${port}${path}` },
  ];
}

type GlobalEvent = { type: "attention"; attention: AttentionEvent } | { type: "tasks_changed" };

/**
 * Satu aliran untuk seluruh aplikasi (topik `global` di WebSocket), supaya notifikasi tetap jalan
 * di tugas mana pun. `onTasksChanged` dipanggil saat server menandai daftar tugas berubah, dan saat
 * sambungan terpasang/pulih (perubahan selama terputus tidak terlewat) — pengganti polling daftar.
 */
export function startAttentionStream(
  onEvent: (event: AttentionEvent) => void,
  onTasksChanged?: () => void,
): () => void {
  return subscribe<GlobalEvent>(
    "global",
    (event) => {
      if (event.type === "attention") onEvent(event.attention);
      else if (event.type === "tasks_changed") onTasksChanged?.();
    },
    { onReady: () => onTasksChanged?.() },
  );
}

function enabledFor(kind: AttentionEvent["kind"], settings: NotificationSettings): boolean {
  if (kind === "approval") return settings.approval;
  if (kind === "question") return settings.question;
  if (kind === "needs_review") return settings.needsReview;
  return settings.failed;
}

export function maybeNotify(
  event: AttentionEvent,
  settings: NotificationSettings,
  onClick: (taskId: string) => void,
): void {
  if (event.silent || !enabledFor(event.kind, settings)) return;
  if (settings.onlyWhenHidden && !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

  const notification = new Notification(`${event.taskId} · ${event.title}`, {
    body: event.detail ?? "",
    tag: `${event.taskId}-${event.kind}`,
    // Approval & pertanyaan menunggu Anda: jangan hilang sendiri.
    requireInteraction: event.kind === "approval" || event.kind === "question",
  });
  notification.onclick = () => {
    window.focus();
    onClick(event.taskId);
    notification.close();
  };
}

/** Penanda jumlah yang menunggu keputusan di judul tab: "(2) AI Team". */
export function setTitleBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}
