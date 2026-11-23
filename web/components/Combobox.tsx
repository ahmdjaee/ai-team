import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ComboOption = {
  value: string;
  label: string;
  /** Baris kedua kecil di bawah label (mis. folder workspace); ikut dicari. */
  hint?: string;
  badge?: string;
  /** Pilihan dengan `group` yang sama dikelompokkan di bawah satu judul (`renderGroup`). */
  group?: string;
  /** Teks kecil redup di samping label, mis. nama model bawaan. */
  meta?: string;
  /** Tampil redup dan dilewati saat memilih; `hint` menjelaskan alasannya. */
  disabled?: boolean;
  /** Kata tambahan untuk pencarian yang tidak tampil, mis. nama mesin. */
  keywords?: string;
};

/**
 * Combobox yang bisa dicari — pola yang sama dengan combobox shadcn
 * (tombol pemicu → panel → kotak cari → daftar dengan tanda ✓), tapi tanpa
 * dependensi baru: panel, pencarian, dan navigasi papan ketik ditulis di sini.
 */
export function Combobox({
  value,
  options,
  onChange,
  placeholder = "Pilih…",
  searchPlaceholder = "Cari…",
  emptyText = "Tidak ada yang cocok.",
  action,
  title,
  ariaLabel,
  className = "",
  compact = false,
  variant = "field",
  trigger: triggerContent,
  placement = "below",
  align = "start",
  renderGroup,
  disabled = false,
}: {
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Baris terakhir yang bukan pilihan, mis. "+ Project baru…". */
  action?: { label: string; onSelect: () => void };
  title?: string;
  ariaLabel?: string;
  className?: string;
  compact?: boolean;
  /** chip = pil tanpa garis selebar isinya (toolbar kotak chat); panelnya selebar 18rem. */
  variant?: "field" | "chip";
  /** Isi tombol pemicu sendiri; bawaannya label pilihan + lencana. */
  trigger?: ReactNode;
  /** above = panel membuka ke atas, untuk pemicu di dekat kaki layar. */
  placement?: "below" | "above";
  /** end = panel chip rata kanan dengan pemicunya (pemicu di sisi kanan layar). */
  align?: "start" | "end";
  /** Judul grup di daftar (lihat `ComboOption.group`). */
  renderGroup?: (group: string) => ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.hint ?? ""} ${option.meta ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  // Jumlah baris yang bisa disorot: hasil filter + baris aksi (kalau ada dan pencarian kosong).
  const showAction = Boolean(action) && !query.trim();
  const rowCount = filtered.length + (showAction ? 1 : 0);
  const enabled = (index: number) => index >= filtered.length || !filtered[index]?.disabled;
  /** Baris aktif berikutnya ke arah `direction`, berputar; -1 kalau semua nonaktif. */
  const step = (from: number, direction: 1 | -1) => {
    for (let i = 1; i <= rowCount; i += 1) {
      const index = (((from + direction * i) % rowCount) + rowCount) % rowCount;
      if (enabled(index)) return index;
    }
    return -1;
  };

  // Pilihan & daftar dibaca lewat ref: `options` dibuat ulang tiap render induk
  // (daftar tugas di-poll 3 detik sekali), dan kalau efek ini ikut bergantung
  // padanya, kotak cari yang sedang Anda isi akan terhapus sendiri.
  const latest = useRef({ options, value });
  latest.current = { options, value };
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const list = latest.current.options;
    const index = list.findIndex((option) => option.value === latest.current.value && !option.disabled);
    setActive(index >= 0 ? index : Math.max(0, list.findIndex((option) => !option.disabled)));
  }, [open]);

  // Klik di luar menutup panel — sama seperti popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open && disabled) setOpen(false);
  }, [open, disabled]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) button.current?.focus();
  };

  const pick = (index: number) => {
    if (showAction && index === filtered.length) {
      setOpen(false);
      action?.onSelect();
      return;
    }
    const option = filtered[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "Tab") {
      // Esc hanya menutup daftar ini, bukan panel atau dialog di belakangnya.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rowCount === 0) return;
      const next = step(active, event.key === "ArrowDown" ? 1 : -1);
      if (next >= 0) setActive(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!event.nativeEvent.isComposing) pick(active);
    }
  };

  const pad = compact ? "px-2 py-1" : "px-3 py-2";
  const chip = variant === "chip";

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        title={title ?? selected?.hint}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={
          chip
            ? `inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1.5 text-left text-[13px] text-muted outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:hover:bg-transparent ${
                open ? "bg-hover text-ink" : ""
              }`
            : `flex w-full items-center gap-1.5 rounded-lg border border-line bg-page ${pad} text-left ${
                compact ? "text-xs" : "text-sm"
              } text-ink hover:border-line-strong disabled:opacity-40`
        }
      >
        {triggerContent ?? (
          <>
            <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : "text-muted"}`}>
              {selected?.label ?? placeholder}
            </span>
            {selected?.badge && (
              <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">{selected.badge}</span>
            )}
          </>
        )}
        {chip ? (
          <svg viewBox="0 0 12 12" aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="shrink-0 text-muted">▾</span>
        )}
      </button>

      {open && (
        <div
          className={`absolute z-30 overflow-hidden rounded-xl border bg-raised shadow-2xl ${
            chip ? `w-72 max-w-[calc(100vw-1rem)] border-line-strong ${align === "end" ? "right-0" : "left-0"}` : "left-0 right-0 border-line"
          } ${placement === "above" ? "bottom-full mb-1.5" : "mt-1"}`}
        >
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              // Sorot hasil pertama yang bisa dipilih.
              const needle = next.trim().toLowerCase();
              const first = options
                .filter((option) => !needle || `${option.label} ${option.hint ?? ""} ${option.meta ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(needle))
                .findIndex((option) => !option.disabled);
              setActive(Math.max(0, first));
            }}
            onKeyDown={onKeyDown}
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            className={`w-full border-b border-line bg-transparent text-ink outline-none placeholder:text-faint ${
              chip ? "px-3.5 py-2.5 text-[13px]" : "px-3 py-2 text-xs"
            }`}
          />
          <div ref={listRef} role="listbox" aria-label={ariaLabel} className={`max-h-64 overflow-y-auto ${chip ? "p-1.5" : "py-1"}`}>
            {filtered.length === 0 && !showAction && <p className="px-3 py-2 text-xs text-faint">{emptyText}</p>}
            {filtered.map((option, index) => {
              const isSelected = option.value === value;
              const header =
                option.group !== undefined && option.group !== filtered[index - 1]?.group ? (
                  <div
                    role="presentation"
                    className={`flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint ${
                      index > 0 ? "mt-1 border-t border-line pt-2" : ""
                    }`}
                  >
                    {renderGroup ? renderGroup(option.group) : option.group}
                  </div>
                ) : null;
              return (
                <Fragment key={option.value}>
                  {header}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    data-active={index === active}
                    title={option.disabled ? option.hint : undefined}
                    onMouseEnter={() => option.disabled || setActive(index)}
                    onClick={() => pick(index)}
                    className={
                      chip
                        ? `flex w-full cursor-default items-center gap-2 rounded-lg py-1.5 pr-2.5 text-left ${option.group !== undefined ? "pl-7" : "pl-2.5"} ${
                            option.disabled ? "opacity-40" : index === active ? "bg-hover" : ""
                          }`
                        : `flex w-full items-start gap-2 px-3 py-1.5 text-left ${
                            option.disabled ? "opacity-40" : index === active ? "bg-hover" : ""
                          }`
                    }
                  >
                    {chip ? (
                      <>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className={`truncate text-[13px] text-ink ${isSelected ? "font-semibold" : ""}`}>{option.label}</span>
                            {option.meta && <span className="shrink-0 truncate text-xs text-faint">{option.meta}</span>}
                          </span>
                          {option.hint && <span className="block truncate text-[11px] text-muted">{option.hint}</span>}
                        </span>
                        {option.badge && <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">{option.badge}</span>}
                        <span className={`w-3 shrink-0 text-xs ${isSelected ? "text-accent-ink" : "text-transparent"}`}>✓</span>
                      </>
                    ) : (
                      <>
                        <span className={`w-3 shrink-0 text-xs ${isSelected ? "text-accent-ink" : "text-transparent"}`}>✓</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-ink">{option.label}</span>
                          {option.hint && <span className="block truncate font-mono text-[10px] text-faint">{option.hint}</span>}
                        </span>
                        {option.badge && (
                          <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">{option.badge}</span>
                        )}
                      </>
                    )}
                  </button>
                </Fragment>
              );
            })}
            {showAction && action && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-active={active === filtered.length}
                onMouseEnter={() => setActive(filtered.length)}
                onClick={() => pick(filtered.length)}
                className={`mt-1 flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-xs text-accent-ink ${
                  active === filtered.length ? "bg-hover" : ""
                }`}
              >
                {action.label}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
