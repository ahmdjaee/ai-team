import { useEffect, useRef, useState } from "react";
import { api, type ProjectInfo, type RoleInfo } from "../api.ts";
import {
  ATTACHMENT_MAX_BYTES,
  ComposerCard,
  FolderIcon,
  MAX_ATTACHMENTS,
  ModelChip,
  RoleChip,
  UrlStrip,
  attachmentName,
  leadingMention,
  useBotChoice,
  type ComposerAttachment,
} from "./ChatComposer.tsx";
import { ENGINE_SHORT } from "./EnginePicker.tsx";
import { Combobox } from "./Combobox.tsx";

/** Teks yang belum terkirim di chat tugas baru; tugasnya belum ada, jadi disimpan di browser ini. */
const DRAFT_KEY = "ai-team-new-task-draft";

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // localStorage bisa diblokir; drafnya cukup hidup selama halaman terbuka.
  }
}

type LocalFile = { key: string; file: File; name: string; preview?: string };

/**
 * Chat utama yang masih kosong: pesan pertama membuat tugasnya. Bot dipilih lewat `@` atau select di
 * kartu yang sama, begitu juga mesin, model, project, dan URL uji untuk bot yang memakai browser.
 * Judul tugas diambil dari pesan ini oleh server; namanya bisa diganti di header tugas.
 */
export function NewTaskChat({
  roles,
  projects,
  defaultProjectId,
  defaultTargetUrl,
  onCreated,
}: {
  roles: RoleInfo[];
  projects: ProjectInfo[];
  defaultProjectId: string;
  defaultTargetUrl: string;
  onCreated: (id: string) => void;
}) {
  const [text, setText] = useState(readDraft);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [sending, setSending] = useState(false);
  const [projectId, setProjectId] = useState(defaultProjectId);
  const project = projects.find((item) => item.id === projectId);
  const [targetUrl, setTargetUrl] = useState(project?.targetUrl || defaultTargetUrl);
  const [touchedTarget, setTouchedTarget] = useState(false);
  const choice = useBotChoice(undefined, "new");
  const input = useRef<HTMLTextAreaElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // Filter project di sidebar berganti (atau daftar project baru dimuat) → ikut, selama belum dipilih di sini.
  const [touchedProject, setTouchedProject] = useState(false);
  useEffect(() => {
    if (!touchedProject && defaultProjectId) setProjectId(defaultProjectId);
  }, [defaultProjectId, touchedProject]);

  // Ganti project → URL uji ikut berganti, selama Anda belum mengisinya sendiri.
  useEffect(() => {
    if (!touchedTarget) setTargetUrl(project?.targetUrl || defaultTargetUrl);
  }, [projectId, project?.targetUrl, defaultTargetUrl, touchedTarget]);

  useEffect(() => {
    input.current?.focus();
    // Pratinjau `blob:` dilepas saat chat ini ditutup.
    return () => filesRef.current.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
  }, []);

  const onText = (value: string) => {
    setText(value);
    writeDraft(value);
  };

  const addFiles = (incoming: File[]) => {
    const room = MAX_ATTACHMENTS - files.length;
    if (incoming.length > room) alert(`Maksimal ${MAX_ATTACHMENTS} lampiran per pesan.`);
    const accepted: LocalFile[] = [];
    for (const file of incoming.slice(0, Math.max(0, room))) {
      const name = attachmentName(file);
      if (file.size > ATTACHMENT_MAX_BYTES) {
        alert(`${name} lebih dari 25 MB.`);
        continue;
      }
      const named = name === file.name ? file : new File([file], name, { type: file.type });
      accepted.push({
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file: named,
        name,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(named) : undefined,
      });
    }
    if (accepted.length > 0) setFiles((current) => [...current, ...accepted]);
  };

  const removeFile = (key: string) =>
    setFiles((current) => {
      const gone = current.find((item) => item.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return current.filter((item) => item.key !== key);
    });

  const selected = roles.find((item) => item.id === choice.role);
  const canSubmit = !sending && choice.engineReady && Boolean(projectId) && text.trim() !== "";

  const send = async () => {
    if (!canSubmit) return;
    // `@qa …` yang ditempel penuh: bot dipilih dulu, Anda yang menekan Kirim lagi.
    const lead = leadingMention(roles, text.trim());
    if (lead && lead.role !== choice.role) {
      choice.setRole(lead.role);
      onText(lead.text);
      return;
    }
    const description = (lead ? lead.text : text).trim();
    if (!description) return;
    setSending(true);
    try {
      const { task } = await api.createTask({
        description,
        role: choice.role,
        projectId,
        targetUrl: selected?.usesBrowser ? targetUrl.trim() || undefined : undefined,
        engine: choice.engine,
        model: choice.model,
        hold: files.length > 0,
      });
      if (files.length > 0) {
        // Lampiran baru bisa diunggah setelah tugasnya ada; pesan pembuka menunggu sampai selesai.
        const results = await Promise.allSettled(files.map((item) => api.uploadAttachment(task.id, item.file)));
        const stored = results.flatMap((result) => (result.status === "fulfilled" ? [result.value.file] : []));
        await api.startTask(task.id, stored);
        const failed = results.length - stored.length;
        if (failed > 0) alert(`${failed} lampiran gagal diunggah; tugas tetap dijalankan tanpa lampiran itu.`);
      }
      writeDraft("");
      onCreated(task.id);
    } catch (error) {
      alert((error as Error).message);
      setSending(false);
    }
  };

  const attachments: ComposerAttachment[] = files.map((item) => ({
    key: item.key,
    name: item.name,
    image: Boolean(item.preview),
    preview: item.preview,
    state: "ready",
  }));

  return (
    <div data-new-task-chat className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-8">
        <h2 className="text-center text-lg font-semibold text-ink">Tugas baru</h2>
        <p className="mt-1 text-center text-sm text-muted">
          Tulis apa yang harus dikerjakan. Sebut bot dengan <span className="font-semibold text-ink">@</span> atau pilih di
          bawah kotak. Nama tugas dibuat otomatis dari pesan ini.
        </p>
        <div className="mt-6">
          <ComposerCard
            roles={roles}
            onMention={choice.setRole}
            text={text}
            onText={onText}
            attachments={attachments}
            onAddFiles={addFiles}
            onRemoveAttachment={removeFile}
            inputRef={input}
            strips={
              selected?.usesBrowser ? (
                <UrlStrip
                  value={targetUrl}
                  onChange={(value) => {
                    setTouchedTarget(true);
                    setTargetUrl(value);
                  }}
                />
              ) : undefined
            }
            toolbarLeft={
              <>
                <RoleChip roles={roles} choice={choice} />
                <Combobox
                  variant="chip"
                  placement="above"
                  value={projectId}
                  options={projects.map((item) => ({
                    value: item.id,
                    label: item.name,
                    hint: item.workspaceDir,
                    badge: String(item.taskCount),
                  }))}
                  onChange={(value) => {
                    setTouchedProject(true);
                    setProjectId(value);
                  }}
                  ariaLabel="Project tugas"
                  title={project ? `Bot membaca konteks & memori ${project.name} dan bekerja di ${project.workspaceDir}` : undefined}
                  searchPlaceholder="Cari project…"
                  trigger={
                    <>
                      <FolderIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-[12rem] truncate">{project?.name ?? "Pilih project…"}</span>
                    </>
                  }
                />
              </>
            }
            toolbarRight={<ModelChip roles={roles} choice={choice} />}
            canSend
            canSubmit={canSubmit}
            onSend={() => void send()}
            placeholder={`Apa yang harus dikerjakan ${selected?.title ?? "bot"}?`}
            sendLabel="Buat tugas"
            sendTitle={
              !choice.engineReady
                ? "Mesin ini belum punya akun yang siap — lihat Pengaturan → Akun AI"
                : !projectId
                  ? "Pilih project dulu"
                  : "Buat tugas dan langsung jalankan"
            }
            hint={
              sending
                ? "Membuat tugas…"
                : choice.switched && choice.settings
                  ? `Mesin bawaan bot ini (${ENGINE_SHORT[choice.settings.engines[choice.role]]}) belum punya akun, jadi tugas ini memakai ${ENGINE_SHORT[choice.engine]}.`
                  : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
