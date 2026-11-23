import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ROLE_SHORT, api, type EngineId, type EngineInfo, type RoleId, type RoleInfo, type SettingsView } from "../api.ts";
import { ENGINE_SHORT, botDefaultModel, modelName, usableEngine, useEngines } from "./EnginePicker.tsx";
import { Combobox, type ComboOption } from "./Combobox.tsx";
import { Select } from "./Select.tsx";

/** Bot, mesin, dan model untuk pesan berikutnya di chat utama. */
export type BotChoice = { role: RoleId; engine: EngineId; model?: string };

/** Lampiran di kotak chat: sudah terunggah (`ready`), sedang diunggah, atau gagal. */
export type ComposerAttachment = {
  key: string;
  name: string;
  image: boolean;
  /** URL pratinjau gambar (lampiran server atau `blob:` sebelum tugasnya ada). */
  preview?: string;
  state: "ready" | "pending" | "error";
  error?: string;
};

/** Tinggi maksimum kotak ketik (±8 baris); setelah itu isinya yang di-scroll. */
const INPUT_MAX_HEIGHT = 200;
/** Sama dengan batas server (`ATTACHMENTS_PER_MESSAGE`, `ATTACHMENT_MAX_BYTES`). */
export const MAX_ATTACHMENTS = 10;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const ENGINE_IDS: EngineId[] = ["claude", "antigravity"];

/** Screenshot dari clipboard selalu bernama "image.png": beri nama yang bisa dibedakan. */
export function attachmentName(file: File): string {
  return file.name && file.name !== "image.png" ? file.name : `tempel-${new Date().toLocaleTimeString("sv-SE").replace(/:/g, "")}.png`;
}

/** Nama tampilan lampiran: cap waktu yang ditambahkan server dibuang. */
export function attachmentLabel(file: string): string {
  return file.replace(/^\d{8}-\d{6}-/, "");
}

// ---------- ikon ----------

export function PaperclipIcon({ className = "h-4 w-4" }: { className?: string }) {
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

export function FolderIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true" className={className}>
      <path
        d="M1.5 3.5c0-.6.4-1 1-1h2.8L6.8 4h4.7c.6 0 1 .4 1 1v5.5c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GlobeIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true" className={className}>
      <path d="M7 1a6 6 0 1 0 0 12A6 6 0 1 0 7 1M1 7h12M7 1c2 2 2 10 0 12M7 1C5 3 5 11 7 13" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function ArrowRightIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M2.5 8H13M9.5 4.5 13 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Warna ikon tiap mesin: Claude oranye, Gemini biru. */
const ENGINE_TONE: Record<EngineId, string> = { claude: "text-tag-orange-ink", antigravity: "text-tag-blue-ink" };

export function EngineIcon({ engine, className = "h-3.5 w-3.5" }: { engine: EngineId; className?: string }) {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" className={`${className} shrink-0 ${ENGINE_TONE[engine]}`}>
      <path d="M7 1l1.4 4.6L13 7l-4.6 1.4L7 13 5.6 8.4 1 7l4.6-1.4z" fill="currentColor" />
    </svg>
  );
}

// ---------- avatar bot ----------

const ROLE_AVATAR: Record<RoleId, { initials: string; tone: string }> = {
  qa: { initials: "QA", tone: "bg-tag-green text-tag-green-ink" },
  engineer: { initials: "EN", tone: "bg-tag-blue text-tag-blue-ink" },
  devops: { initials: "DO", tone: "bg-tag-orange text-tag-orange-ink" },
  uiux: { initials: "UX", tone: "bg-tag-yellow text-tag-yellow-ink" },
};

export function RoleAvatar({ role, size = "sm" }: { role: RoleId; size?: "sm" | "md" }) {
  const avatar = ROLE_AVATAR[role] ?? { initials: role.slice(0, 2).toUpperCase(), tone: "bg-tag-gray text-tag-gray-ink" };
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${avatar.tone} ${
        size === "md" ? "h-[26px] w-[26px] text-[10px]" : "h-[22px] w-[22px] text-[9px]"
      }`}
    >
      {avatar.initials}
    </span>
  );
}

// ---------- pilihan bot ----------

const roleKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Role yang disebut persis oleh `@token` (id atau nama: `@qa`, `@ui/ux`, `@uiux`). */
export function roleByMention(roles: RoleInfo[], token: string): RoleInfo | undefined {
  const key = roleKey(token);
  if (!key) return undefined;
  return roles.find((role) => roleKey(role.id) === key || roleKey(role.title) === key);
}

/**
 * `@role` yang diketik penuh di awal pesan (mis. ditempel) juga memilih bot: tokennya dibuang dari
 * teks. Kosong kalau awal pesan bukan sebutan bot.
 */
export function leadingMention(roles: RoleInfo[], text: string): { role: RoleId; text: string } | undefined {
  const match = /^\s*@([\w/]+)(?=\s|$)\s*/.exec(text);
  const role = match ? roleByMention(roles, match[1]!) : undefined;
  return role && match ? { role: role.id, text: text.slice(match[0].length) } : undefined;
}

/**
 * Bot, mesin, dan model yang dipilih di kotak chat. `baseline` = penugasan yang sedang berjalan (tugas
 * yang sudah ada); memilih role itu lagi kembali ke mesin dan modelnya, jadi kirim tidak berarti oper.
 * Role lain mengikuti setelan bot di Pengaturan sampai Anda memilih mesin sendiri.
 */
export function useBotChoice(baseline: BotChoice | undefined, resetKey: string, initialRole: RoleId = "qa") {
  const { engines } = useEngines();
  const [settings, setSettings] = useState<SettingsView>();
  const [role, setRoleState] = useState<RoleId>(baseline?.role ?? initialRole);
  const [engine, setEngine] = useState<EngineId>(baseline?.engine ?? "claude");
  const [model, setModel] = useState<string | undefined>(baseline?.model);
  const [touched, setTouched] = useState(false);
  const base = useRef(baseline);
  base.current = baseline;

  useEffect(() => {
    void api.settings().then(setSettings, () => undefined);
  }, []);

  const reset = () => {
    setRoleState(base.current?.role ?? initialRole);
    setEngine(base.current?.engine ?? "claude");
    setModel(base.current?.model);
    setTouched(false);
  };

  // Tugas lain atau penugasan baru (sesudah oper): kembali ke penugasan yang berjalan.
  useEffect(reset, [resetKey]);

  useEffect(() => {
    if (touched) return;
    const current = base.current;
    if (current && role === current.role) {
      setEngine(current.engine);
      setModel(current.model);
      return;
    }
    if (!settings) return;
    setEngine(usableEngine(settings.engines[role], engines));
    setModel(undefined);
  }, [role, settings, engines, touched, resetKey]);

  /** Ganti bot: mesin dan modelnya kembali ke bawaan bot itu. */
  const setRole = (next: RoleId) => {
    setRoleState(next);
    setTouched(false);
  };
  const pickEngine = (next: EngineId, nextModel?: string) => {
    setTouched(true);
    setEngine(next);
    setModel(nextModel);
  };

  const current = baseline;
  const handoff = Boolean(
    current && (role !== current.role || engine !== current.engine || (model ?? "") !== (current.model ?? "")),
  );
  const engineReady = engines?.find((item) => item.id === engine)?.available ?? false;
  const switched = Boolean(settings && !touched && engines && !(current && role === current.role) && engine !== settings.engines[role]);

  return { role, engine, model, setRole, pickEngine, reset, settings, engines, engineReady, switched, handoff };
}

export type BotChoiceState = ReturnType<typeof useBotChoice>;

/** "Engineer (Gemini)" untuk label oper; mesin hanya disebut kalau bukan Claude. */
export function choiceLabel(roles: RoleInfo[], choice: Pick<BotChoice, "role" | "engine">): string {
  const title = ROLE_SHORT[choice.role] ?? roles.find((item) => item.id === choice.role)?.title ?? choice.role;
  return choice.engine === "claude" ? title : `${title} (${ENGINE_SHORT[choice.engine]})`;
}

export function roleTitle(roles: RoleInfo[], role: RoleId): string {
  return roles.find((item) => item.id === role)?.title ?? ROLE_SHORT[role] ?? role;
}

/** Nama model tanpa nama mesinnya di depan: "Gemini 4 Hydrogen" → "4 Hydrogen". */
function shortModel(name: string | undefined, engine: EngineId): string | undefined {
  if (!name) return undefined;
  const prefix = new RegExp(`^${engine === "claude" ? "claude" : "gemini"}[\\s-]+`, "i");
  return name.replace(prefix, "") || name;
}

/** Model bawaan bot untuk mesin itu: Pengaturan → Bot, lalu `.env` (Claude) atau bawaan akun agy (Gemini). */
function defaultModelOf(settings: SettingsView | undefined, roleInfo: RoleInfo | undefined, engine: EngineId, info?: EngineInfo): string | undefined {
  if (!roleInfo) return undefined;
  return botDefaultModel(settings, roleInfo.id, engine) ?? (engine === "claude" ? roleInfo.model : info?.defaultModel);
}

/** Chip bot tujuan di toolbar kotak chat: avatar + nama, daftarnya berisi deskripsi tiap bot. */
export function RoleChip({
  roles,
  choice,
  disabled,
  highlight,
}: {
  roles: RoleInfo[];
  choice: BotChoiceState;
  disabled?: boolean;
  /** Pilihan ini berarti oper: chip diberi garis aksen. */
  highlight?: boolean;
}) {
  return (
    <Select
      variant="chip"
      value={choice.role}
      onChange={(next) => choice.setRole(next as RoleId)}
      ariaLabel="Bot tujuan"
      title="Bot yang menerima pesan ini — atau ketik @ di kotak chat"
      disabled={disabled}
      listWidth={360}
      className={`py-1 pl-1 pr-2.5 font-semibold text-ink ${
        highlight ? "bg-accent-soft ring-1 ring-accent" : "bg-hover hover:bg-line-strong"
      }`}
      trigger={
        <>
          <RoleAvatar role={choice.role} />
          <span className="truncate">{roleTitle(roles, choice.role)}</span>
        </>
      }
      options={roles.map((item) => ({
        value: item.id,
        label: item.title,
        description: item.blurb,
        leading: <RoleAvatar role={item.id} size="md" />,
        meta: `@${item.id}`,
      }))}
    />
  );
}

/**
 * Chip mesin + model: satu daftar, dikelompokkan per mesin. Baris pertama tiap mesin ("Bawaan bot",
 * "Bawaan Tanya") = model kosong, dengan nama model bawaannya di kanan; mesin tanpa akun siap tampil
 * nonaktif dengan alasannya.
 */
export function EngineModelChip({
  engines,
  engine,
  model,
  defaultModel,
  defaultLabel = "Bawaan bot",
  onChange,
  disabled,
  align = "end",
}: {
  engines: EngineInfo[] | undefined;
  engine: EngineId;
  model: string | undefined;
  /** Model yang dipakai kalau "Bawaan" dipilih, per mesin. */
  defaultModel: (engine: EngineId, info: EngineInfo | undefined) => string | undefined;
  defaultLabel?: string;
  onChange: (engine: EngineId, model?: string) => void;
  disabled?: boolean;
  /** Sisi panel daftar terhadap chip; "end" untuk chip di sisi kanan toolbar. */
  align?: "start" | "end";
}) {
  const options: ComboOption[] = ENGINE_IDS.flatMap((id) => {
    const info = engines?.find((entry) => entry.id === id);
    const keywords = `${ENGINE_SHORT[id]} ${id}`;
    if (!info?.available) {
      return [{ value: `${id}:`, label: "Akun belum siap", hint: info?.reason ?? "Memeriksa akun…", group: id, disabled: true, keywords }];
    }
    const models = info.models ?? [];
    const list: ComboOption[] = [
      { value: `${id}:`, label: defaultLabel, meta: shortModel(modelName(models, defaultModel(id, info)), id), group: id, keywords },
      ...models.map((item) => ({
        value: `${id}:${item.id}`,
        label: shortModel(item.name, id) ?? item.id,
        hint: item.description,
        group: id,
        keywords: `${keywords} ${item.id} ${item.name}`,
      })),
    ];
    if (id === engine && model && !models.some((item) => item.id === model)) {
      list.push({ value: `${id}:${model}`, label: model, meta: "tidak terdaftar", group: id, keywords });
    }
    return list;
  });
  const info = engines?.find((entry) => entry.id === engine);
  const shown = shortModel(modelName(info?.models, model ?? defaultModel(engine, info)), engine);
  return (
    <Combobox
      variant="chip"
      placement="above"
      align={align}
      value={`${engine}:${model ?? ""}`}
      onChange={(next) => {
        const [id, ...rest] = next.split(":");
        onChange(id as EngineId, rest.join(":") || undefined);
      }}
      ariaLabel="Mesin dan model"
      title={info?.available === false ? info.reason : "Mesin dan model untuk pesan ini"}
      searchPlaceholder="Cari model…"
      emptyText="Tidak ada model yang cocok."
      disabled={disabled}
      className="min-w-0"
      renderGroup={(group) => (
        <>
          <EngineIcon engine={group as EngineId} className="h-3 w-3" />
          {ENGINE_SHORT[group as EngineId]}
        </>
      )}
      trigger={
        <>
          <EngineIcon engine={engine} />
          <span className="font-semibold text-ink">{ENGINE_SHORT[engine]}</span>
          {shown && <span className="truncate">{shown}</span>}
        </>
      }
      options={options}
    />
  );
}

/** Mesin + model untuk pesan di kotak chat tugas; "Bawaan bot" mengikuti Pengaturan → Bot. */
export function ModelChip({ roles, choice, disabled }: { roles: RoleInfo[]; choice: BotChoiceState; disabled?: boolean }) {
  const roleInfo = roles.find((item) => item.id === choice.role);
  return (
    <EngineModelChip
      engines={choice.engines}
      engine={choice.engine}
      model={choice.model}
      defaultModel={(id, info) => defaultModelOf(choice.settings, roleInfo, id, info)}
      onChange={choice.pickEngine}
      disabled={disabled}
    />
  );
}

/** Strip tipis di atas kotak ketik untuk bot yang memakai browser: URL yang diuji, bisa disunting di tempat. */
export function UrlStrip({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div data-url-strip className="flex items-center gap-2 border-b border-line bg-panel px-4 py-2 text-xs">
      <GlobeIcon className="h-3.5 w-3.5 shrink-0 text-faint" />
      <span className="shrink-0 text-faint">Diuji di</span>
      <input
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="URL yang diuji"
        placeholder="isi URL yang diuji, mis. https://staging.contoh.com/login"
        className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-faint"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          input.current?.focus();
          input.current?.select();
        }}
        className="shrink-0 text-accent-ink hover:underline disabled:opacity-40"
      >
        Ubah
      </button>
    </div>
  );
}

/** Strip biru di puncak kartu: kirim berarti oper. "Batal" kembali ke bot yang memegang. */
export function HandoffStrip({ target, from, onCancel }: { target: string; from: string; onCancel: () => void }) {
  return (
    <div data-handoff-hint className="flex items-center gap-2 bg-accent-soft px-4 py-2 text-xs">
      <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 text-accent-ink" />
      <span className="shrink-0 font-semibold text-accent-ink">Oper ke {target}</span>
      <span className="min-w-0 flex-1 truncate text-muted">· pesan ini jadi catatan operan, {from} berhenti</span>
      <button type="button" onClick={onCancel} className="shrink-0 text-muted hover:text-ink">
        Batal
      </button>
    </div>
  );
}

// ---------- kartu kotak chat ----------

type Mention = { start: number; end: number; query: string };

/** `@kata` yang sedang diketik tepat sebelum kursor. */
function mentionBefore(text: string, caret: number): Mention | undefined {
  const match = /(^|\s)@([\w/]*)$/.exec(text.slice(0, caret));
  if (!match) return undefined;
  const start = caret - match[2]!.length - 1;
  return { start, end: caret, query: match[2]! };
}

/**
 * Kotak chat utama: strip di puncak (`strips`: oper, URL uji), chip lampiran, kotak ketik dengan sebutan
 * `@bot`, lalu toolbar — lampiran dan `toolbarLeft` (bot, project) di kiri, `toolbarRight` (mesin +
 * model) dan tombol kirim di kanan. Petunjuk keyboard di bawah kartu. Status (teks, lampiran, kirim)
 * dipegang pemanggilnya — chat tugas menyimpan draf di server, chat tugas baru di browser.
 */
export function ComposerCard({
  roles,
  onMention,
  text,
  onText,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  strips,
  toolbarLeft,
  toolbarRight,
  canSend,
  canSubmit,
  onSend,
  placeholder,
  sendLabel = "Kirim",
  sendText,
  sendTitle,
  hint,
  inputRef,
}: {
  roles: RoleInfo[];
  onMention: (role: RoleId) => void;
  text: string;
  onText: (value: string) => void;
  attachments: ComposerAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  strips?: ReactNode;
  toolbarLeft?: ReactNode;
  toolbarRight?: ReactNode;
  canSend: boolean;
  canSubmit: boolean;
  onSend: () => void;
  placeholder: string;
  sendLabel?: string;
  /** Tombol kirim jadi pil bertulisan (mis. "Oper") alih-alih ikon panah. */
  sendText?: string;
  sendTitle?: string;
  /** Baris kecil di bawah kartu; bawaannya petunjuk keyboard. */
  hint?: ReactNode;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? ownInput;
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<Mention>();
  const [active, setActive] = useState(0);
  const caretAfter = useRef<number | undefined>(undefined);

  const matches = useMemo(() => {
    if (!mention) return [];
    const key = roleKey(mention.query);
    return roles.filter((role) => roleKey(role.id).startsWith(key) || roleKey(role.title).startsWith(key));
  }, [mention, roles]);
  const listOpen = Boolean(mention) && matches.length > 0;

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
    if (caretAfter.current !== undefined) {
      el.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = undefined;
    }
  }, [text]);

  /** Token `@…` dibuang dari teks; bot yang disebut jadi bot tujuan. */
  const pick = (role: RoleId, at: Mention, value = text) => {
    const before = value.slice(0, at.start);
    const after = value.slice(at.end).replace(/^[^\S\n]+/, "");
    caretAfter.current = before.length;
    onText(before + after);
    onMention(role);
    setMention(undefined);
  };

  const track = (value: string, caret: number) => {
    const next = mentionBefore(value, caret);
    setMention(next);
    if (next?.query !== mention?.query) setActive(0);
  };

  const onChange = (value: string, caret: number) => {
    // `@qa` lalu spasi: bot dipilih seperti memilih dari daftar.
    const typed = value.slice(caret - 1, caret);
    if (/\s/.test(typed)) {
      const done = mentionBefore(value, caret - 1);
      const role = done ? roleByMention(roles, done.query) : undefined;
      if (done && role) {
        pick(role.id, { ...done, end: caret }, value);
        return;
      }
    }
    onText(value);
    track(value, caret);
  };

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
  const listId = "composer-mentions";

  return (
    <div>
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
          onAddFiles([...e.dataTransfer.files]);
        }}
        className={`relative rounded-2xl border bg-raised shadow-lg shadow-black/10 transition-colors focus-within:border-line-strong ${
          dragging ? "border-accent ring-2 ring-accent/30" : "border-line"
        } ${canSend ? "" : "opacity-60"}`}
      >
        {strips && <div className="overflow-hidden rounded-t-2xl">{strips}</div>}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3" aria-label="Lampiran">
            {attachments.map((item) =>
              item.state === "ready" ? (
                <span
                  key={item.key}
                  data-attachment-chip={item.key}
                  className="group relative flex items-center gap-2 rounded-[10px] border border-line bg-panel py-1 pl-1 pr-7 text-xs text-ink"
                >
                  {item.image && item.preview ? (
                    <img src={item.preview} alt="" className="h-9 w-9 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-9 w-9 items-center justify-center rounded-md bg-hover text-muted">
                      <PaperclipIcon />
                    </span>
                  )}
                  <span className="max-w-[160px] truncate">{item.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(item.key)}
                    aria-label={`Hapus lampiran ${item.name}`}
                    title="Hapus lampiran"
                    className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-faint hover:bg-hover hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <span
                  key={item.key}
                  data-attachment-upload={item.state === "error" ? "error" : "pending"}
                  className={`relative flex items-center gap-2 rounded-[10px] border py-1 pl-2 pr-7 text-xs ${
                    item.state === "error" ? "border-line bg-tag-red text-tag-red-ink" : "border-line bg-panel text-muted"
                  }`}
                >
                  <span className="max-w-[160px] truncate">{item.name}</span>
                  <span>{item.state === "error" ? `gagal: ${item.error}` : "mengunggah…"}</span>
                  {item.state === "error" && (
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(item.key)}
                      aria-label="Tutup"
                      className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full hover:bg-hover"
                    >
                      ×
                    </button>
                  )}
                </span>
              ),
            )}
          </div>
        )}

        {listOpen && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Sebut bot"
            className="absolute bottom-full left-3 z-30 mb-2 w-[360px] max-w-[calc(100%-1.5rem)] rounded-xl border border-line-strong bg-raised p-1.5 shadow-2xl"
          >
            <li role="presentation" className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
              Sebut bot
            </li>
            {matches.map((role, index) => (
              <li
                key={role.id}
                id={`${listId}-${role.id}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(e) => {
                  // Jangan sampai kotak ketik kehilangan fokus sebelum bot terpilih.
                  e.preventDefault();
                  if (mention) pick(role.id, mention);
                }}
                onMouseEnter={() => setActive(index)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 ${index === active ? "bg-hover" : ""}`}
              >
                <RoleAvatar role={role.id} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{role.title}</span>
                  {role.blurb && <span className="block truncate text-[11px] text-muted">{role.blurb}</span>}
                </span>
                <span className="shrink-0 text-[11px] text-faint">@{role.id}</span>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={input}
          value={text}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (el.selectionStart === el.selectionEnd) track(el.value, el.selectionStart);
            else setMention(undefined);
          }}
          onBlur={() => setMention(undefined)}
          onKeyDown={(e) => {
            if (listOpen && mention) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive((index) => (index + step + matches.length) % matches.length);
                return;
              }
              if ((e.key === "Enter" && !e.nativeEvent.isComposing) || e.key === "Tab") {
                e.preventDefault();
                pick(matches[Math.min(active, matches.length - 1)]!.id, mention);
                return;
              }
              if (e.key === "Escape") {
                // Esc hanya menutup daftar bot, bukan panel atau dialog di belakangnya.
                e.preventDefault();
                e.stopPropagation();
                setMention(undefined);
                return;
              }
            }
            // Enter saat IME masih merangkai kata hanya memilih kata, bukan mengirim.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          onPaste={(e) => {
            // Screenshot atau berkas dari clipboard jadi lampiran; teks biasa ditempel seperti biasa.
            if (e.clipboardData.files.length === 0) return;
            e.preventDefault();
            onAddFiles([...e.clipboardData.files]);
          }}
          rows={1}
          disabled={!canSend}
          aria-label="Arahan untuk agen"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen ? `${listId}-${matches[active]?.id}` : undefined}
          aria-autocomplete="list"
          placeholder={placeholder}
          className="block min-h-[56px] w-full resize-none bg-transparent px-[18px] pb-2 pt-4 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
        />

        <div data-composer-toolbar className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) onAddFiles([...e.target.files]);
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
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink disabled:text-faint disabled:hover:bg-transparent"
            >
              <PaperclipIcon />
            </button>
            {toolbarLeft}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {toolbarRight}
            <button
              onClick={onSend}
              disabled={!canSubmit}
              aria-label={sendLabel}
              title={sendTitle ?? sendLabel}
              className={`flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hover disabled:bg-hover disabled:text-faint ${
                sendText ? "pl-3.5 pr-3 text-[13px] font-semibold" : "w-8"
              }`}
            >
              {sendText ? (
                <>
                  {sendText}
                  <ArrowRightIcon className="h-4 w-4" />
                </>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4">
                  <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      <p className="mt-1.5 truncate px-2 text-center text-[11px] text-faint">
        {hint ?? (canSend ? "Enter kirim · Shift+Enter baris baru · @ sebut bot · tempel atau seret berkas" : "")}
      </p>
    </div>
  );
}
