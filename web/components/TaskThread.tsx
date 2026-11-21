import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deriveActivity, formatElapsed, formatTokens, type Activity } from "../activity.ts";
import {
  api,
  attachmentUrl,
  isImageFile,
  type EngineId,
  type StoredEvent,
  type TaskStatus,
  type UiEvent,
  type WorkerStatus,
} from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { ApprovalCard, QuestionCard, ToolCall } from "./Cards.tsx";
import { ENGINE_SHORT } from "./EnginePicker.tsx";

const ROLE_LABEL: Record<string, string> = {
  qa: "QA",
  engineer: "Engineer",
  devops: "DevOps",
  uiux: "UI/UX",
};

/** Markdown pesan asisten di-parse sekali per pesan, bukan tiap token streaming atau tiap polling. */
const AssistantMessage = memo(function AssistantMessage({ text, dim }: { text: string; dim?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className="max-w-[92%]">
      <div className={`markdown text-sm${dim ? " opacity-80" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

function rowKey(event: StoredEvent): string {
  // Tanpa seq: kartu tidak boleh dipasang ulang (dan kehilangan isian) saat seq 0 diganti salinan tersimpan.
  if (event.type === "approval") return `approval-${event.approvalId}`;
  if (event.type === "question") return `question-${event.questionId}`;
  return `${event.seq}-${event.type}-${event.type === "tool" ? event.toolUseId : ""}`;
}

type ToolResult = Extract<UiEvent, { type: "tool_result" }>;

/** Nama tampilan lampiran: cap waktu yang ditambahkan server dibuang. */
function attachmentLabel(file: string): string {
  return file.replace(/^\d{8}-\d{6}-/, "");
}

function PaperclipIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M13.5 7.5 8.2 12.8a3.25 3.25 0 0 1-4.6-4.6l5.6-5.6a2.1 2.1 0 0 1 3 3L6.6 11.2a1 1 0 0 1-1.4-1.4L10.3 4.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lampiran di gelembung pesan Anda: gambar sebagai pratinjau, berkas lain sebagai chip nama. */
function MessageAttachments({ taskId, files }: { taskId: string; files: string[] }) {
  return (
    <div className="mt-1.5 flex max-w-[85%] flex-wrap items-start justify-end gap-2">
      {files.map((file) =>
        isImageFile(file) ? (
          <a key={file} href={attachmentUrl(taskId, file)} target="_blank" rel="noreferrer" title={attachmentLabel(file)}>
            <img
              src={attachmentUrl(taskId, file)}
              alt={attachmentLabel(file)}
              loading="lazy"
              className="max-h-40 max-w-[240px] cursor-zoom-in rounded-lg border border-line object-cover"
            />
          </a>
        ) : (
          <a
            key={file}
            href={attachmentUrl(taskId, file)}
            target="_blank"
            rel="noreferrer"
            className="flex max-w-[240px] items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-ink hover:bg-hover"
          >
            <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="truncate">{attachmentLabel(file)}</span>
          </a>
        ),
      )}
    </div>
  );
}

function renderRow(event: StoredEvent, resolved: Set<string>, results: Map<string, ToolResult>, taskId: string) {
  const key = rowKey(event);
  switch (event.type) {
    case "user":
      if (event.from === "system") {
        return (
          <div key={key}>
            <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">{event.text}</div>
          </div>
        );
      }
      return (
        <div key={key} className="flex flex-col items-end">
          {event.text && (
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-on-accent">
              {event.text}
            </div>
          )}
          {event.attachments && event.attachments.length > 0 && <MessageAttachments taskId={taskId} files={event.attachments} />}
        </div>
      );
    case "assistant":
      return <AssistantMessage key={key} text={event.text} />;
    case "thinking":
      return (
        <details key={key} className="text-xs text-muted">
          <summary className="cursor-pointer select-none">berpikir…</summary>
          <p className="mt-1 whitespace-pre-wrap border-l border-line pl-3 italic">{event.text}</p>
        </details>
      );
    case "tool":
      return <ToolCall key={key} name={event.name} input={event.input} result={results.get(event.toolUseId)} />;
    case "approval":
      return resolved.has(event.approvalId) ? null : <ApprovalCard key={key} event={event} />;
    case "question":
      return resolved.has(event.questionId) ? null : <QuestionCard key={key} event={event} />;
    case "approval_resolved":
      return (
        <p key={key} className="text-xs text-muted">
          Keputusan Anda: {event.decision === "allow" ? "diizinkan" : "ditolak"}
          {event.remember ? " (diingat)" : ""}
          {event.message ? ` — ${event.message}` : ""}
        </p>
      );
    case "notice":
      return (
        <p key={key} data-thread-notice className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">
          {event.text}
        </p>
      );
    case "compact":
      return (
        <p key={key} data-thread-compact className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">
          Konteks diringkas {event.trigger === "auto" ? "otomatis" : "manual"} pada {formatTokens(event.preTokens)} token. Bot bisa kehilangan detail lama; laporan dan register tetap utuh.
        </p>
      );
    case "handoff":
      return (
        <p key={key} className="rounded-lg border border-line bg-tag-blue px-3 py-2 text-xs text-tag-blue-ink">
          Dioper: {ROLE_LABEL[event.from] ?? event.from}
          {engineTag(event.fromEngine, event.toEngine, event.fromEngine)} → {ROLE_LABEL[event.to] ?? event.to}
          {engineTag(event.fromEngine, event.toEngine, event.toEngine)}
          {event.note ? ` · ${event.note}` : ""}
        </p>
      );
    case "result":
      return (
        <p key={key} className="border-t border-line pt-2 text-[11px] text-faint">
          {event.interrupted ? "dihentikan" : event.subtype}
          {event.background ? " · dimulai agen sendiri" : ""} · {event.numTurns} turn · {(event.durationMs / 1000).toFixed(0)}s
          {event.tokens !== undefined ? ` · ${formatTokens(event.tokens)} token` : ""}
          {/* costUsd = total berjalan sesi; event lama belum punya biaya per turn. */}
          {event.turnCostUsd !== undefined
            ? ` · $${event.turnCostUsd.toFixed(4)}`
            : event.costUsd !== undefined
              ? ` · total sesi $${event.costUsd.toFixed(4)}`
              : ""}
        </p>
      );
    case "error":
      return (
        <p key={key} className="rounded-lg border border-line bg-tag-red p-2 text-xs text-tag-red-ink">
          {event.message}
        </p>
      );
    default:
      return null;
  }
}

/** Label mesin di baris operan — hanya kalau salah satu sisinya bukan Claude, supaya operan lama tetap ringkas. */
function engineTag(from: EngineId | undefined, to: EngineId | undefined, side: EngineId | undefined): string {
  if ((from ?? "claude") === "claude" && (to ?? "claude") === "claude") return "";
  return ` (${ENGINE_SHORT[side ?? "claude"]})`;
}

/** Timer hidup di sini: tick per detik tidak boleh me-render ulang seluruh thread. */
function ActivityBar({ activity }: { activity?: Activity }) {
  const since = activity?.since;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);

  if (!activity) return null;
  const waiting = activity.tone === "waiting";

  return (
    <div
      role="status"
      className={`flex items-center gap-2 text-xs ${waiting ? "text-tag-yellow-ink" : "text-muted"}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${waiting ? "bg-tag-yellow-ink" : "bg-accent motion-safe:animate-pulse"}`}
      />
      <span className="min-w-0 truncate">{activity.label}</span>
      {since && (
        <span aria-hidden="true" className="shrink-0 tabular-nums text-faint">
          {formatElapsed(now - new Date(since).getTime())}
        </span>
      )}
    </div>
  );
}

/** Tinggi maksimum kotak ketik (±8 baris); setelah itu isinya yang di-scroll. */
const INPUT_MAX_HEIGHT = 176;
/** Jeda simpan-otomatis draf setelah Anda berhenti mengetik. */
const DRAFT_SAVE_DELAY_MS = 600;
/** Batas body `fetch(..., { keepalive })` di browser 64 KiB; di atas itu fetch-nya langsung gagal. */
const KEEPALIVE_MAX_BYTES = 60_000;
/** Sama dengan batas server (`ATTACHMENTS_PER_MESSAGE`, `ATTACHMENT_MAX_BYTES`). */
const MAX_ATTACHMENTS = 10;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

type Upload = { key: string; name: string; error?: string };

const serializeDraft = (text: string, attachments: string[]): string => JSON.stringify({ text, attachments });
const EMPTY_DRAFT = serializeDraft("", []);

export function TaskThread({
  taskId,
  events,
  status,
  taskStatus,
  streaming,
  error,
  disconnected = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  canSend,
}: {
  taskId: string;
  events: StoredEvent[];
  status: WorkerStatus;
  taskStatus?: TaskStatus;
  streaming: string;
  error?: string;
  disconnected?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  canSend: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Boleh ikut turun atau tidak — di ref supaya efek di bawah tidak membaca nilai basi.
  const stick = useRef(true);
  const instant = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  // Seq event terakhir, bukan panjang array: memuat event lama (prepend) bukan "pesan baru".
  const tailSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  const lastTail = useRef(tailSeq);

  // Toleransi supaya "hampir di dasar" tetap dihitung sedang mengikuti.
  const NEAR_BOTTOM = 80;
  // Jarak dari atas tempat riwayat lama mulai dimuat, sebelum Anda benar-benar sampai di ujung.
  const LOAD_OLDER_THRESHOLD = 200;
  // Event scroll datang beruntun sebelum `loadingOlder` sempat berubah: cegah permintaan ganda.
  const fetchingOlder = useRef(false);

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    const bottomNow = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
    stick.current = bottomNow;
    setAtBottom(bottomNow);
    if (bottomNow) setHasNew(false);
    // Hanya dipicu oleh guliran Anda — kalau gagal, guliran berikutnya yang mencoba lagi.
    if (hasMore && !loadingOlder && el.scrollTop < LOAD_OLDER_THRESHOLD) void loadOlder();
  };

  const jumpToBottom = (behavior: ScrollBehavior = "smooth") => {
    stick.current = true;
    setHasNew(false);
    setAtBottom(true);
    bottom.current?.scrollIntoView({ behavior, block: "end" });
  };

  // Kalau Anda sedang membaca ke atas, tampilan tidak disentuh sama sekali —
  // agen boleh terus menulis, yang muncul hanya tombol "Pesan baru".
  useEffect(() => {
    const grew = tailSeq !== lastTail.current;
    lastTail.current = tailSeq;
    if (stick.current) {
      bottom.current?.scrollIntoView({ behavior: instant.current ? "auto" : "smooth", block: "end" });
      instant.current = false;
    } else if (grew) {
      setHasNew(true);
    }
  }, [tailSeq]);

  // Token streaming datang ±10×/detik: geser langsung ke dasar tanpa animasi yang terus di-restart.
  useEffect(() => {
    if (!streaming) return;
    const el = viewport.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
    else if (!stick.current) setHasNew(true);
  }, [streaming]);

  // Membuka tugas lain selalu mendarat di pesan terbaru, tanpa animasi panjang.
  useEffect(() => {
    stick.current = true;
    instant.current = true;
    setHasNew(false);
    setAtBottom(true);
  }, [taskId]);

  // Draf (teks + lampiran yang sudah terunggah) disimpan di server per tugas: tetap ada saat pindah
  // tugas, halaman, atau browser. Pola simpannya sama dengan TaskNotes — `saved` = JSON terakhir
  // yang sudah diterima server.
  const [files, setFiles] = useState<string[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const draft = useRef<{ taskId: string; saved: string; text: string; files: string[] }>({
    taskId,
    saved: EMPTY_DRAFT,
    text: "",
    files: [],
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef<Promise<unknown>>(Promise.resolve());

  const flushDraft = (keepalive = false) => {
    clearTimeout(saveTimer.current);
    const { taskId: id, saved, text: value, files: attached } = draft.current;
    const body = serializeDraft(value, attached);
    if (body === saved) return;
    const small = new Blob([body]).size <= KEEPALIVE_MAX_BYTES;
    const request = fetch(`/api/tasks/${encodeURIComponent(id)}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: keepalive && small,
    })
      .then((response) => {
        if (!response.ok) return;
        // Gagal → dicoba lagi di flush berikutnya; jawaban lama tidak menimpa simpanan yang lebih baru.
        if (draft.current.taskId === id && draft.current.saved === saved) draft.current.saved = body;
      })
      .catch(() => undefined);
    inFlight.current = request;
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushDraft(), DRAFT_SAVE_DELAY_MS);
  };

  const dirty = () => serializeDraft(draft.current.text, draft.current.files) !== draft.current.saved;

  // Memuat draf tugas dari server. Dipasang hanya kalau Anda belum mengubah apa pun sejak sinkron terakhir.
  const pullDraft = (id: string) => {
    void api
      .taskDraft(id)
      .then((remote) => {
        if (draft.current.taskId !== id || dirty()) return;
        draft.current = { taskId: id, saved: serializeDraft(remote.text, remote.attachments), text: remote.text, files: remote.attachments };
        setText(remote.text);
        setFiles(remote.attachments);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    // Pindah tugas: draf tugas sebelumnya disimpan dulu, lalu kotak ketik diisi draf tugas ini.
    if (draft.current.taskId !== taskId) flushDraft(true);
    draft.current = { taskId, saved: EMPTY_DRAFT, text: "", files: [] };
    setText("");
    setFiles([]);
    setUploads([]);
    pullDraft(taskId);
  }, [taskId]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushDraft(true);
      // Kembali ke tab ini: ambil draf yang mungkin diubah di browser lain.
      else pullDraft(draft.current.taskId);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      flushDraft(true);
    };
  }, []);

  const onType = (value: string) => {
    setText(value);
    draft.current.text = value;
    scheduleSave();
  };

  const setAttached = (next: string[]) => {
    draft.current.files = next;
    setFiles(next);
    scheduleSave();
  };

  /** Tiap berkas langsung diunggah; chip "mengunggah…" berganti jadi lampiran setelah server menyimpannya. */
  const addFiles = (list: FileList | File[]) => {
    const id = taskId;
    const incoming = [...list];
    const room = MAX_ATTACHMENTS - draft.current.files.length - uploads.filter((item) => !item.error).length;
    if (incoming.length > room) alert(`Maksimal ${MAX_ATTACHMENTS} lampiran per pesan.`);
    for (const file of incoming.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Screenshot dari clipboard selalu bernama "image.png": beri nama yang bisa dibedakan.
      const name = file.name && file.name !== "image.png" ? file.name : `tempel-${new Date().toLocaleTimeString("sv-SE").replace(/:/g, "")}.png`;
      if (file.size > ATTACHMENT_MAX_BYTES) {
        setUploads((current) => [...current, { key, name, error: "lebih dari 25 MB" }]);
        continue;
      }
      setUploads((current) => [...current, { key, name }]);
      const named = name === file.name ? file : new File([file], name, { type: file.type });
      void api
        .uploadAttachment(id, named)
        .then(({ file: stored }) => {
          setUploads((current) => current.filter((item) => item.key !== key));
          // Pindah tugas selama mengunggah: berkasnya milik tugas lama, jangan ikut ke kotak ketik ini.
          if (draft.current.taskId !== id) return;
          setAttached([...draft.current.files, stored]);
        })
        .catch((cause: Error) =>
          setUploads((current) => current.map((item) => (item.key === key ? { ...item, error: cause.message } : item))),
        );
    }
  };

  const removeFile = (file: string) => {
    setAttached(draft.current.files.filter((item) => item !== file));
    void api.deleteAttachment(taskId, file).catch(() => undefined);
  };

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  // Kotak ketik dan bar aktivitas mengubah tinggi area pesan; pesan terakhir jangan sampai tertutup.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadOlder = async () => {
    if (fetchingOlder.current || !onLoadOlder) return;
    fetchingOlder.current = true;
    const el = viewport.current;
    const before = el?.scrollHeight ?? 0;
    try {
      await onLoadOlder();
    } finally {
      fetchingOlder.current = false;
    }
    // Baris lama masuk di atas: pertahankan apa yang sedang Anda baca di tempatnya.
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before;
    });
  };

  // Thread yang belum cukup panjang untuk digulir tidak akan pernah memicu guliran: muat langsung.
  // Bergantung pada jumlah event, jadi kegagalan tidak berulang terus-menerus.
  const eventCount = events.length;
  useEffect(() => {
    const el = viewport.current;
    if (!el || !hasMore || loadingOlder) return;
    if (el.scrollHeight <= el.clientHeight) void loadOlder();
  }, [eventCount, hasMore, loadingOlder]);

  const resolved = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.type === "approval_resolved") ids.add(event.approvalId);
      if (event.type === "question_resolved") ids.add(event.questionId);
    }
    return ids;
  }, [events]);

  const results = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const event of events) if (event.type === "tool_result") map.set(event.toolUseId, event);
    return map;
  }, [events]);

  // Baris dibentuk ulang hanya saat daftar event berubah — bukan saat token streaming datang.
  const rows = useMemo(() => events.map((event) => renderRow(event, resolved, results, taskId)), [events, resolved, results, taskId]);

  const streamingNow = Boolean(streaming);
  const activity = useMemo(
    () => deriveActivity({ status, taskStatus, streaming: streamingNow, events }),
    [status, taskStatus, streamingNow, events],
  );

  // Indikatornya bagian dari thread: saat muncul, tetap ikut ke dasar kalau Anda sedang mengikuti.
  const activityLabel = activity?.label;
  useEffect(() => {
    const el = viewport.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
  }, [activityLabel]);

  const uploading = uploads.some((item) => !item.error);
  const canSubmit = canSend && !sending && !uploading && (text.trim() !== "" || files.length > 0);

  const send = async () => {
    const value = text.trim();
    const sent = draft.current.files;
    if (!canSubmit) return;
    setSending(true);
    try {
      // Simpanan draf yang masih di jalan tidak boleh mendarat setelah server membersihkannya.
      clearTimeout(saveTimer.current);
      await inFlight.current;
      await api.message(taskId, value, sent);
      // Server sudah menghapus draf; yang sempat diketik/dilampirkan selama pengiriman tidak ikut terhapus.
      const rest = draft.current.text.trim() === value ? "" : draft.current.text;
      const restFiles = draft.current.files.filter((file) => !sent.includes(file));
      draft.current = { taskId, saved: EMPTY_DRAFT, text: rest, files: restFiles };
      setText(rest);
      setFiles(restFiles);
      setUploads((current) => current.filter((item) => !item.error));
      if (rest || restFiles.length > 0) flushDraft();
      // Pesan Anda sendiri wajib terlihat.
      jumpToBottom();
    } catch (cause) {
      alert((cause as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={viewport} onScroll={onScroll} className="thread-rows h-full space-y-3 overflow-y-auto px-5 py-4 [overflow-anchor:none]">
          {error && (
            <div className="rounded-lg border border-line bg-tag-red p-3 text-sm text-tag-red-ink">{error}</div>
          )}

          {loadingOlder && <div className="text-center text-xs text-muted">Memuat…</div>}

          {rows}

          {streaming && <AssistantMessage text={streaming} dim />}
          {!disconnected && <ActivityBar activity={activity} />}
          <div ref={bottom} />
        </div>

        {disconnected && (
          <p className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-line bg-tag-yellow px-3 py-1 text-xs text-tag-yellow-ink shadow">
            Sambungan terputus — menyambung ulang…
          </p>
        )}

        {!atBottom && (hasNew || status === "waiting") && (
          <button
            onClick={() => jumpToBottom()}
            className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs shadow-lg ${
              status === "waiting"
                ? "border-line bg-tag-yellow text-tag-yellow-ink"
                : "border-line bg-raised text-ink hover:bg-hover"
            }`}
          >
            {status === "waiting" ? "Menunggu keputusan Anda ↓" : "Pesan baru ↓"}
          </button>
        )}
      </div>

      <div className="px-4 pb-4 pt-2">
        <div
          data-composer
          onDragOver={(e) => {
            if (!canSend || !hasFiles(e)) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            // Pindah ke elemen anak juga memicu dragleave; hanya keluar sungguhan yang dihitung.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!canSend || !hasFiles(e)) return;
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          className={`rounded-2xl border bg-raised transition-colors focus-within:border-accent ${
            dragging ? "border-accent ring-2 ring-accent/30" : "border-line"
          } ${canSend ? "" : "opacity-60"}`}
        >
          {(files.length > 0 || uploads.length > 0) && (
            <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Lampiran">
              {files.map((file) => (
                <span
                  key={file}
                  data-attachment-chip={file}
                  className="group relative flex items-center gap-2 rounded-lg border border-line bg-panel py-1 pl-1 pr-7 text-xs text-ink"
                >
                  {isImageFile(file) ? (
                    <img src={attachmentUrl(taskId, file)} alt="" className="h-10 w-10 rounded object-cover" />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded bg-hover text-muted">
                      <PaperclipIcon />
                    </span>
                  )}
                  <span className="max-w-[160px] truncate">{attachmentLabel(file)}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(file)}
                    aria-label={`Hapus lampiran ${attachmentLabel(file)}`}
                    title="Hapus lampiran"
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ))}
              {uploads.map((item) => (
                <span
                  key={item.key}
                  data-attachment-upload={item.error ? "error" : "pending"}
                  className={`relative flex items-center gap-2 rounded-lg border py-1 pl-2 pr-7 text-xs ${
                    item.error ? "border-line bg-tag-red text-tag-red-ink" : "border-line bg-panel text-muted"
                  }`}
                >
                  <span className="max-w-[160px] truncate">{item.name}</span>
                  <span>{item.error ? `gagal: ${item.error}` : "mengunggah…"}</span>
                  {item.error && (
                    <button
                      type="button"
                      onClick={() => setUploads((current) => current.filter((other) => other.key !== item.key))}
                      aria-label="Tutup"
                      className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full hover:bg-hover"
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              // Enter saat IME masih merangkai kata hanya memilih kata, bukan mengirim.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              // Screenshot atau berkas dari clipboard jadi lampiran; teks biasa ditempel seperti biasa.
              if (e.clipboardData.files.length === 0) return;
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }}
            rows={1}
            disabled={!canSend}
            aria-label="Arahan untuk agen"
            placeholder={canSend ? "Arahan tambahan untuk tugas ini…" : "Tugas sudah ditutup — buka lagi lewat review."}
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm text-ink outline-none placeholder:text-faint"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                // Memilih berkas yang sama lagi tetap memicu onChange.
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={!canSend}
              aria-label="Lampirkan berkas"
              title="Lampirkan berkas (atau tempel / seret ke sini)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink disabled:text-faint disabled:hover:bg-transparent"
            >
              <PaperclipIcon />
            </button>
            <span className="hidden min-w-0 flex-1 truncate text-[11px] text-faint sm:block">
              {canSend ? "Enter kirim · Shift+Enter baris baru · tempel atau seret berkas untuk melampirkan" : ""}
            </span>
            <button
              onClick={() => void send()}
              disabled={!canSubmit}
              aria-label="Kirim"
              title={uploading ? "Tunggu lampiran selesai diunggah" : "Kirim"}
              className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hover disabled:bg-hover disabled:text-faint"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4">
                <path
                  d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
