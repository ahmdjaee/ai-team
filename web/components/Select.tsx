import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label: string;
  /** Baris kedua kecil di bawah label, mis. keterangan model dari akun. */
  description?: string;
  disabled?: boolean;
  /** Pilihan dengan `group` yang sama dikelompokkan di bawah satu judul (`renderGroup`). */
  group?: string;
  /** Avatar atau ikon di depan label, menggantikan tanda ✓ (pilihan terpilih ditandai ✓ di kanan). */
  leading?: ReactNode;
  /** Teks kecil redup di kanan label, mis. `@qa` atau nama model bawaan. */
  meta?: string;
};

const GAP = 4;
const EDGE = 8;
const MAX_HEIGHT = 288;
const MAX_WIDTH = 320;
/** Huruf yang diketik berdekatan digabung jadi satu pencarian ("op" → Opus). */
const TYPEAHEAD_MS = 600;

type Position = { left: number; top?: number; bottom?: number; minWidth: number; maxHeight: number };

/**
 * Pengganti `<select>` bawaan browser di seluruh app (aturan di CLAUDE.md). Tanpa kotak cari — untuk daftar
 * panjang yang perlu dicari ada `Combobox`. Tombol
 * pemicu → daftar pilihan dengan tanda ✓. Daftar dirender di `body` dengan posisi tetap, jadi tidak
 * terpotong panel atau dialog, dan membuka ke atas kalau ruang di bawah tidak cukup (mis. di kaki panel Tanya).
 *
 * Papan ketik: ↓/↑/Enter/Spasi membuka; ↓/↑/Home/End memindah sorotan; Enter/Spasi memilih; Esc/Tab menutup;
 * mengetik huruf melompat ke pilihan yang diawali huruf itu.
 */
export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  placeholder = "Pilih…",
  disabled,
  size = "md",
  muted = false,
  className = "",
  variant = "field",
  trigger: triggerContent,
  renderGroup,
  listWidth,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Wajib: tombol pemicu tidak punya teks label sendiri. */
  ariaLabel: string;
  title?: string;
  /** Ditampilkan redup kalau `value` tidak ada di `options` (mis. "pindah ke…"). */
  placeholder?: string;
  disabled?: boolean;
  /** sm = baris padat (panel, tabel kecil), md = form/pengaturan, lg = pemilih utama selebar konten. */
  size?: "sm" | "md" | "lg";
  /** Teks pilihan redup, untuk kontrol sekunder di header. */
  muted?: boolean;
  /** Lebar dan jarak tombol pemicu, mis. `w-full`, `flex-1`, `ml-1`. */
  className?: string;
  /** chip = pil tanpa garis untuk toolbar kotak chat; warnanya dari `className`. */
  variant?: "field" | "chip";
  /** Isi tombol pemicu sendiri (mis. avatar + nama); bawaannya label pilihan terpilih. */
  trigger?: ReactNode;
  /** Judul grup di daftar (lihat `SelectOption.group`). */
  renderGroup?: (group: string) => ReactNode;
  /** Lebar daftar (px) kalau isinya butuh lebih dari bawaan. */
  listWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<Position>();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  const enabled = useCallback((index: number) => index >= 0 && index < options.length && !options[index]?.disabled, [options]);
  /** Pilihan aktif berikutnya ke arah `step`, berputar; -1 kalau semua nonaktif. */
  const step = useCallback(
    (from: number, direction: 1 | -1) => {
      for (let i = 1; i <= options.length; i += 1) {
        const index = (((from + direction * i) % options.length) + options.length) % options.length;
        if (enabled(index)) return index;
      }
      return -1;
    },
    [options.length, enabled],
  );

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    setPosition(undefined);
    if (focusTrigger) trigger.current?.focus();
  };

  const show = (start?: number) => {
    if (disabled || options.length === 0) return;
    setActive(start ?? (enabled(selectedIndex) ? selectedIndex : step(-1, 1)));
    setOpen(true);
  };

  const pick = (index: number) => {
    if (!enabled(index)) return;
    const option = options[index]!;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  // Posisi dihitung dari tombol pemicu dan lebar daftar sendiri, sebelum digambar (tanpa kedip).
  const reposition = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    const popup = list.current;
    if (!anchor || !popup) return;
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const wanted = Math.min(MAX_HEIGHT, popup.scrollHeight);
    const up = below < wanted && above > below;
    const maxHeight = Math.max(96, Math.min(MAX_HEIGHT, up ? above : below));
    const width = Math.max(anchor.width, Math.min(popup.offsetWidth, listWidth ?? MAX_WIDTH));
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - width - EDGE));
    setPosition({
      left,
      minWidth: anchor.width,
      maxHeight,
      ...(up ? { bottom: window.innerHeight - anchor.top + GAP } : { top: anchor.bottom + GAP }),
    });
  }, [listWidth]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  // Fokus baru bisa dipindah setelah daftar terlihat (elemen `visibility: hidden` tidak bisa difokus).
  const placed = position !== undefined;
  useLayoutEffect(() => {
    if (open && placed) list.current?.focus({ preventScroll: true });
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    // Klik di luar menutup daftar; gulir/ubah ukuran memindahkannya ikut tombol pemicu.
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !list.current?.contains(target)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (open && disabled) close(false);
  }, [open, disabled]);

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, position]);

  const typeahead = (key: string): boolean => {
    if (key.length !== 1 || key === " ") return false;
    const now = Date.now();
    typed.current = { text: now - typed.current.at > TYPEAHEAD_MS ? key : typed.current.text + key, at: now };
    const needle = typed.current.text.toLowerCase();
    const start = needle.length === 1 ? active + 1 : Math.max(active, 0);
    for (let i = 0; i < options.length; i += 1) {
      const index = (start + i) % options.length;
      if (enabled(index) && options[index]!.label.toLowerCase().startsWith(needle)) {
        setActive(index);
        break;
      }
    }
    return true;
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      show();
    }
  };

  const onListKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (key === "Escape" || key === "Tab") {
      // Esc hanya menutup daftar ini, bukan dialog atau panel di belakangnya.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const next = step(active, key === "ArrowDown" ? 1 : -1);
      if (next >= 0) setActive(next);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      const next = key === "Home" ? step(-1, 1) : step(options.length, -1);
      if (next >= 0) setActive(next);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      pick(active);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && typeahead(key)) event.preventDefault();
  };

  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : size === "lg" ? "px-3 py-2 text-[13px] font-medium" : "px-2 py-1 text-xs";
  const itemText = size === "lg" ? "text-[13px]" : "text-xs";
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        title={title ?? selected?.description}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKeyDown}
        className={
          variant === "chip"
            ? `inline-flex min-w-0 items-center gap-1.5 rounded-full text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${
                open ? "bg-hover" : ""
              } ${className}`
            : `inline-flex min-w-0 items-center gap-1.5 rounded-lg border bg-page text-left outline-none disabled:opacity-40 ${
                muted ? "text-muted" : "text-ink"
              } ${pad} ${open ? "border-accent" : "border-line hover:border-line-strong focus-visible:border-accent"} ${className}`
        }
      >
        {triggerContent ?? (
          <span className={`min-w-0 flex-1 truncate ${selected ? "" : "text-muted"}`}>{selected?.label ?? placeholder}</span>
        )}
        <svg viewBox="0 0 12 12" aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            onKeyDown={onListKeyDown}
            style={{
              position: "fixed",
              left: position?.left ?? 0,
              top: position?.top,
              bottom: position?.bottom,
              minWidth: position?.minWidth,
              maxWidth: Math.min(listWidth ?? MAX_WIDTH, window.innerWidth - EDGE * 2),
              width: listWidth,
              maxHeight: position?.maxHeight ?? MAX_HEIGHT,
              visibility: position ? "visible" : "hidden",
            }}
            className={`z-50 overflow-y-auto rounded-xl border border-line bg-raised shadow-2xl outline-none ${
              variant === "chip" ? "p-1.5" : "w-max py-1"
            }`}
          >
            {options.map((option, index) => {
              const isSelected = index === selectedIndex;
              const header =
                option.group !== undefined && option.group !== options[index - 1]?.group ? (
                  <div
                    role="presentation"
                    className={`flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint ${
                      index > 0 ? "mt-1 border-t border-line pt-2" : ""
                    }`}
                  >
                    {renderGroup ? renderGroup(option.group) : option.group}
                  </div>
                ) : null;
              if (option.leading !== undefined || variant === "chip") {
                return (
                  <Fragment key={`${option.value}-${index}`}>
                    {header}
                    <div
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={option.disabled || undefined}
                      data-index={index}
                      title={option.description}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => option.disabled || active === index || setActive(index)}
                      onClick={() => pick(index)}
                      className={`flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${
                        option.disabled ? "opacity-40" : index === active ? "bg-hover" : ""
                      } ${option.leading === undefined ? "pl-7" : ""}`}
                    >
                      {option.leading}
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className={`truncate text-[13px] text-ink ${isSelected ? "font-semibold" : ""}`}>{option.label}</span>
                          {option.meta && option.leading === undefined && (
                            <span className="shrink-0 truncate text-xs text-faint">{option.meta}</span>
                          )}
                        </span>
                        {option.description && <span className="block truncate text-[11px] text-muted">{option.description}</span>}
                      </span>
                      {option.meta && option.leading !== undefined && <span className="shrink-0 text-[11px] text-faint">{option.meta}</span>}
                      <span className={`w-3 shrink-0 text-xs ${isSelected ? "text-accent-ink" : "text-transparent"}`}>✓</span>
                    </div>
                  </Fragment>
                );
              }
              return (
                <div
                  key={`${option.value}-${index}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  data-index={index}
                  title={option.description}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => option.disabled || active === index || setActive(index)}
                  onClick={() => pick(index)}
                  className={`flex cursor-default items-start gap-2 px-3 py-1.5 ${
                    option.disabled ? "opacity-40" : index === active ? "bg-hover" : ""
                  }`}
                >
                  <span className={`w-3 shrink-0 text-xs ${isSelected ? "text-accent-ink" : "text-transparent"}`}>✓</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${itemText} text-ink ${isSelected ? "font-medium" : ""}`}>{option.label}</span>
                    {option.description && <span className="line-clamp-2 block text-[10px] text-faint">{option.description}</span>}
                  </span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
