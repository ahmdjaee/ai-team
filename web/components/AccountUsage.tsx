import type { AgentUsage, ProviderId, UsageWindow } from "../api.ts";

/** Nama agen sebelum data pertama datang ("membaca dari …"). */
const SOURCE: Record<ProviderId, string> = { claude: "Claude Code", gemini: "agy" };
const ENGINE_NAME: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini" };

type Tone = 0 | 1 | 2;

/**
 * Warna jendela: kuning mulai 70% dan merah mulai 90%, atau lebih tinggi kalau agen bilang begitu
 * (`severity` "warn…" kuning; "crit…", "exceed…", "block…", "reject…", "error…" merah). Severity lain,
 * mis. "normal" atau "info", tidak mengubah warna.
 */
export function usageTone(window: Pick<UsageWindow, "usedPercent" | "severity">): Tone {
  const severity = window.severity?.toLowerCase() ?? "";
  const fromAgent: Tone = /warn/.test(severity) ? 1 : /crit|exceed|block|reject|error/.test(severity) ? 2 : 0;
  const used = window.usedPercent ?? 0;
  const fromPercent: Tone = used >= 90 ? 2 : used >= 70 ? 1 : 0;
  return Math.max(fromAgent, fromPercent) as Tone;
}

const BAR: Record<Tone, string> = { 0: "bg-accent", 1: "bg-tag-yellow-ink", 2: "bg-tag-red-ink" };
const TEXT: Record<Tone, string> = { 0: "text-ink", 1: "text-tag-yellow-ink", 2: "text-tag-red-ink" };

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "pukul 15.59" (hari ini), "besok, 22.00", atau "Sen, 30 Nov". Waktu yang sudah lewat tidak ditampilkan. */
export function resetPhrase(iso: string | undefined, now = new Date()): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) return undefined;
  const time = date.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((dayStart(date) - dayStart(now)) / 86_400_000);
  if (days <= 0) return `pukul ${time}`;
  if (days === 1) return `besok, ${time}`;
  return date.toLocaleDateString("id-ID", { weekday: "short", day: "numeric", month: "short" });
}

function WindowRow({ window }: { window: UsageWindow }) {
  const tone = usageTone(window);
  const used = window.usedPercent;
  const reset = resetPhrase(window.resetsAt);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[10rem_minmax(0,1fr)_6.5rem_9rem]">
      <span className="truncate text-xs text-ink" title={window.label}>
        {window.label}
      </span>
      <span className={`text-right text-xs tabular-nums md:order-3 ${TEXT[tone]}`}>
        {used === null ? "—" : `${used}%`}
        <span className="hidden md:inline"> terpakai</span>
      </span>
      <div
        className="col-span-2 h-1.5 overflow-hidden rounded-full bg-hover md:order-2 md:col-span-1"
        role="progressbar"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
      >
        {used !== null && used > 0 && <div className={`h-full rounded-full ${BAR[tone]}`} style={{ width: `${used}%` }} />}
      </div>
      <span className="col-span-2 text-[11px] text-faint md:order-4 md:col-span-1 md:text-xs">{reset ? `reset ${reset}` : ""}</span>
    </div>
  );
}

/**
 * Blok "Pemakaian langganan" di kartu akun: jendela kuota seperti dilaporkan agennya (`/usage`),
 * ditampilkan ulang apa adanya. Desain: design/ai-team.figcraft, halaman "Pengaturan · pemakaian agen".
 */
export function AccountUsage({
  provider,
  usage,
  loading,
  failure,
  ago,
}: {
  provider: ProviderId;
  usage?: AgentUsage;
  loading: boolean;
  /** Permintaan terakhir ke server untuk agen ini gagal (bukan agennya). */
  failure?: string;
  ago: (iso: string | undefined) => string | undefined;
}) {
  if (!usage && !loading && !failure) return null;

  const status = loading
    ? usage
      ? "memperbarui…"
      : `membaca dari ${SOURCE[provider]}…`
    : usage
      ? `dari ${usage.source} · ${ago(usage.checkedAt)}`
      : undefined;
  const windows = usage?.windows ?? [];
  const hot = windows.find((window) => usageTone(window) === 2);
  const hotReset = resetPhrase(hot?.resetsAt);

  return (
    <div className="mt-3 space-y-2 rounded-md bg-sunken px-3 py-2.5" aria-busy={loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[11px] font-semibold text-muted">Pemakaian langganan</span>
        {status && <span className="text-[11px] text-faint">{status}</span>}
      </div>

      {!usage && loading && (
        <div className="space-y-2" aria-hidden>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <div className="h-2.5 w-28 rounded bg-hover" />
              <div className="h-1.5 flex-1 rounded-full bg-hover opacity-60" />
            </div>
          ))}
        </div>
      )}

      {!loading && failure && (
        <p className="text-xs text-tag-yellow-ink">
          {usage ? "Gagal memperbarui" : "Gagal membaca pemakaian"}: {failure.replace(/[.\s]*$/, "")}.
        </p>
      )}

      {usage && windows.length === 0 && (
        <p className={`text-xs ${usage.error ? "text-tag-yellow-ink" : "text-faint"}`}>
          {usage.error ? `${usage.error.replace(/[.\s]*$/, ".")} Tekan Periksa untuk mencoba lagi.` : usage.note}
        </p>
      )}

      {windows.map((window, index) => (
        <div key={window.id}>
          {window.group && window.group !== windows[index - 1]?.group && (
            <p className={`text-[10px] font-semibold uppercase tracking-wide text-faint ${index > 0 ? "pt-1.5" : ""} pb-1.5`}>{window.group}</p>
          )}
          <WindowRow window={window} />
        </div>
      ))}

      {hot && (
        <p className="text-[11px] text-tag-red-ink">
          Kuota {hot.group ? `${hot.group} ` : ""}
          {hot.label.toLowerCase()} {(hot.usedPercent ?? 0) >= 100 ? "habis" : "hampir habis"} — bot yang memakai {ENGINE_NAME[provider]} bisa
          berhenti{hotReset ? ` sampai ${hotReset}` : ""}.
        </p>
      )}
    </div>
  );
}
