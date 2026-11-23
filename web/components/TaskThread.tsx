import { memo, useEffect, useMemo, useRef, useState } from "react";
import { deriveActivity, formatElapsed, formatTokens, type Activity } from "../activity.ts";
import {
  ROLE_SHORT,
  api,
  attachmentUrl,
  isImageFile,
  type EngineId,
  type RoleId,
  type RoleInfo,
  type StoredEvent,
  type Task,
  type TaskStatus,
  type UiEvent,
  type WorkerStatus,
} from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { ApprovalCard, QuestionCard, ToolCall } from "./Cards.tsx";
import {
  ATTACHMENT_MAX_BYTES,
  ComposerCard,
  HandoffStrip,
  ModelChip,
  RoleChip,
  UrlStrip,
  MAX_ATTACHMENTS,
  PaperclipIcon,
  attachmentLabel,
  attachmentName,
  choiceLabel,
  leadingMention,
  roleTitle,
  useBotChoice,
  type ComposerAttachment,
} from "./ChatComposer.tsx";
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
        // Operan dari chat utama bisa membawa lampiran.
        return (
          <div key={key}>
            <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">{event.text}</div>
            {event.attachments && event.attachments.length > 0 && (
              <div className="flex justify-end">
                <MessageAttachments taskId={taskId} files={event.attachments} />
              </div>
            )}
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

/** Jeda simpan-otomatis draf setelah Anda berhenti mengetik. */
const DRAFT_SAVE_DELAY_MS = 600;
/** Batas body `fetch(..., { keepalive })` di browser 64 KiB; di atas itu fetch-nya langsung gagal. */
const KEEPALIVE_MAX_BYTES = 60_000;

type Upload = { key: string; name: string; error?: string };

const serializeDraft = (text: string, attachments: string[]): string => JSON.stringify({ text, attachments });
const EMPTY_DRAFT = serializeDraft("", []);

/**
 * Usul agen untuk mengoper tugas, satu baris yang bisa dibentang, tepat di atas kotak chat. "Oper"
 * mengisi kotak chat dengan bot dan catatan usulnya; Anda yang menekan Kirim.
 */
function SuggestionBar({ suggestion, onUse }: { suggestion: NonNullable<Task["suggestedNext"]>; onUse: () => void }) {
  // Usul agen dibiarkan tertutup: catatannya sering panjang.
  const [open, setOpen] = useState(false);
  // Usul yang baru ditulis agen tidak boleh muncul dalam keadaan terbentang.
  useEffect(() => setOpen(false), [suggestion.at]);
  return (
    <div data-suggestion className="mb-2 rounded-lg border border-line bg-tag-orange px-3 py-1.5 text-xs text-tag-orange-ink">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title={open ? "Tutup usul agen" : "Baca usul agen selengkapnya"}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left hover:opacity-80"
        >
          <span aria-hidden className="shrink-0">
            {open ? "▾" : "▸"}
          </span>
          <span className="truncate">
            Usul agen: lanjutkan ke <strong>{ROLE_SHORT[suggestion.role]}</strong>
            {open ? null : ` — ${suggestion.note}`}
          </span>
        </button>
        <button
          type="button"
          onClick={onUse}
          title="Isi kotak chat dengan bot dan catatan usul ini, lalu tekan Oper untuk mengoper"
          className="shrink-0 rounded-md border border-line-strong px-2.5 py-0.5 font-semibold hover:bg-hover"
        >
          Terapkan di chat
        </button>
      </div>
      {/* Dibatasi tingginya: catatan agen bisa ribuan karakter. */}
      {open && <p className="mt-1.5 max-h-56 overflow-y-auto break-words whitespace-pre-wrap">{suggestion.note}</p>}
    </div>
  );
}

export function TaskThread({
  taskId,
  task,
  roles,
  defaultTargetUrl = "",
  onChanged,
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
  /** Tugas yang dibuka: penugasan terakhirnya jadi pilihan bot bawaan di kotak chat. */
  task: Task;
  roles: RoleInfo[];
  /** URL uji bawaan (project, lalu `.env`) kalau tugasnya belum punya. */
  defaultTargetUrl?: string;
  /** Dipanggil setelah tugas dioper dari kotak chat. */
  onChanged?: () => void;
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

  // Pilihan bot di kotak chat. Bawaannya penugasan yang berjalan; berbeda dari itu = kirim berarti oper.
  const current = task.assignments.at(-1);
  const baseline = { role: task.role, engine: current?.engine ?? "claude", model: current?.model } satisfies {
    role: RoleId;
    engine: EngineId;
    model?: string;
  };
  const choiceKey = `${taskId}:${task.assignments.length}`;
  const choice = useBotChoice(baseline, choiceKey);
  const [targetUrl, setTargetUrl] = useState(task.targetUrl ?? defaultTargetUrl);
  useEffect(() => setTargetUrl(task.targetUrl ?? defaultTargetUrl), [choiceKey]);
  const usesBrowser = roles.find((item) => item.id === choice.role)?.usesBrowser ?? false;
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
  const addFiles = (incoming: File[]) => {
    const id = taskId;
    const room = MAX_ATTACHMENTS - draft.current.files.length - uploads.filter((item) => !item.error).length;
    if (incoming.length > room) alert(`Maksimal ${MAX_ATTACHMENTS} lampiran per pesan.`);
    for (const file of incoming.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const name = attachmentName(file);
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
  // Oper boleh tanpa catatan: bot baru tetap menerima instruksi asli dan ringkasan serah terima.
  const canSubmit =
    canSend && !sending && !uploading && (choice.handoff ? choice.engineReady : text.trim() !== "" || files.length > 0);

  /** Usul agen → kotak chat: bot usulan dipilih dan catatannya siap disunting. */
  const applySuggestion = (role: RoleId, note: string) => {
    choice.setRole(role);
    const now = draft.current.text;
    if (!now.includes(note)) onType(now.trim() ? `${now.trimEnd()}\n\n${note}` : note);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const send = async () => {
    if (!canSubmit) return;
    let value = text.trim();
    const sent = draft.current.files;
    // `@qa …` yang ditempel penuh: bot dipilih dulu, Anda yang menekan Kirim lagi.
    const lead = leadingMention(roles, value);
    if (lead && lead.role !== choice.role) {
      choice.setRole(lead.role);
      onType(lead.text);
      return;
    }
    if (lead) value = lead.text.trim();
    setSending(true);
    try {
      // Simpanan draf yang masih di jalan tidak boleh mendarat setelah server membersihkannya.
      clearTimeout(saveTimer.current);
      await inFlight.current;
      if (choice.handoff) {
        await api.handoff(taskId, {
          role: choice.role,
          note: value || undefined,
          engine: choice.engine,
          model: choice.model,
          targetUrl: usesBrowser ? targetUrl.trim() || undefined : undefined,
          attachments: sent,
        });
      } else {
        const url = usesBrowser && targetUrl.trim() !== (task.targetUrl ?? "") ? targetUrl.trim() || undefined : undefined;
        await api.message(taskId, value, sent, url);
      }
      // Server sudah menghapus draf; yang sempat diketik/dilampirkan selama pengiriman tidak ikut terhapus.
      const rest = draft.current.text.trim() === text.trim() ? "" : draft.current.text;
      const restFiles = draft.current.files.filter((file) => !sent.includes(file));
      draft.current = { taskId, saved: EMPTY_DRAFT, text: rest, files: restFiles };
      setText(rest);
      setFiles(restFiles);
      setUploads((current) => current.filter((item) => !item.error));
      if (rest || restFiles.length > 0) flushDraft();
      if (choice.handoff) onChanged?.();
      // Pesan Anda sendiri wajib terlihat.
      jumpToBottom();
    } catch (cause) {
      alert((cause as Error).message);
    } finally {
      setSending(false);
    }
  };

  const attachments: ComposerAttachment[] = [
    ...files.map((file) => ({
      key: file,
      name: attachmentLabel(file),
      image: isImageFile(file),
      preview: isImageFile(file) ? attachmentUrl(taskId, file) : undefined,
      state: "ready" as const,
    })),
    ...uploads.map((item) => ({
      key: item.key,
      name: item.name,
      image: false,
      state: item.error ? ("error" as const) : ("pending" as const),
      error: item.error,
    })),
  ];
  const handoffTo = choiceLabel(roles, choice);

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
        {task.suggestedNext && (
          <SuggestionBar
            suggestion={task.suggestedNext}
            onUse={() => applySuggestion(task.suggestedNext!.role, task.suggestedNext!.note)}
          />
        )}
        <ComposerCard
          roles={roles}
          onMention={choice.setRole}
          text={text}
          onText={onType}
          attachments={attachments}
          onAddFiles={addFiles}
          onRemoveAttachment={(key) =>
            files.includes(key) ? removeFile(key) : setUploads((current) => current.filter((item) => item.key !== key))
          }
          inputRef={input}
          strips={
            choice.handoff || usesBrowser ? (
              <>
                {choice.handoff && (
                  <HandoffStrip
                    target={`${roleTitle(roles, choice.role)}${choice.role === task.role ? " dengan mesin/model baru" : ""}`}
                    from={roleTitle(roles, task.role)}
                    onCancel={choice.reset}
                  />
                )}
                {usesBrowser && <UrlStrip value={targetUrl} onChange={setTargetUrl} disabled={!canSend} />}
              </>
            ) : undefined
          }
          toolbarLeft={<RoleChip roles={roles} choice={choice} disabled={!canSend} highlight={choice.handoff} />}
          toolbarRight={<ModelChip roles={roles} choice={choice} disabled={!canSend} />}
          canSend={canSend}
          canSubmit={canSubmit}
          onSend={() => void send()}
          placeholder={
            !canSend
              ? "Tugas sudah ditutup — buka lagi lewat review."
              : choice.handoff
                ? `Catatan untuk ${roleTitle(roles, choice.role)} (opsional)…`
                : `Arahan tambahan untuk ${roleTitle(roles, task.role)}…`
          }
          sendLabel={choice.handoff ? `Oper ke ${handoffTo}` : "Kirim"}
          sendText={choice.handoff ? "Oper" : undefined}
          sendTitle={uploading ? "Tunggu lampiran selesai diunggah" : !choice.engineReady && choice.handoff ? "Mesin ini belum punya akun yang siap — lihat Pengaturan → Akun AI" : undefined}
          hint={
            !canSend
              ? "Tugas sudah ditutup — buka lagi lewat review."
              : choice.switched && choice.settings
                ? `Mesin bawaan bot ini (${ENGINE_SHORT[choice.settings.engines[choice.role]]}) belum punya akun, jadi operan ini memakai ${ENGINE_SHORT[choice.engine]}.`
                : choice.handoff
                ? `Enter oper · pilih ${roleTitle(roles, task.role)} lagi untuk batal oper · @ sebut bot`
                : "Enter kirim · Shift+Enter baris baru · @ sebut bot lain untuk mengoper"
          }
        />
      </div>
    </div>
  );
}
