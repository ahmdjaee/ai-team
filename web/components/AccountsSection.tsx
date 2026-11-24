import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, type AccountView, type AgentUsage, type ClaudeSource, type ProviderId, type TaskListItem } from "../api.ts";
import { putAccount, useAccounts } from "../accounts.ts";
import { AccountUsage } from "./AccountUsage.tsx";
import { GatewayDialog } from "./GatewayDialog.tsx";
import { LoginDialog } from "./LoginDialog.tsx";

const STATE_BADGE: Record<AccountView["state"], { text: string; className: string }> = {
  ok: { text: "Terhubung", className: "bg-tag-green text-tag-green-ink" },
  error: { text: "Gagal diperiksa", className: "bg-tag-orange text-tag-orange-ink" },
  expired: { text: "Perlu login ulang", className: "bg-tag-yellow text-tag-yellow-ink" },
  none: { text: "Belum ditambahkan", className: "bg-tag-gray text-tag-gray-ink" },
  unavailable: { text: "Belum tersedia", className: "bg-tag-gray text-tag-gray-ink" },
};

const ABOUT: Record<ProviderId, string> = {
  claude: "Login langganan Claude (Pro/Max). Dipakai bot, panel Tanya, dan kurator memori yang memakai Claude.",
  gemini: "Login Google lewat Antigravity CLI. Dipakai bot, panel Tanya, dan kurator memori yang memakai Gemini.",
};

const GATEWAY_ABOUT =
  "Base URL + token API yang kompatibel dengan Anthropic, seperti claude-gw di terminal. Akun Claude tambahan: dipakai bot Claude kalau dijadikan akun aktif.";

const GATEWAY_BADGE: Record<NonNullable<AccountView["gateway"]>["state"], { text: string; className: string }> = {
  ok: STATE_BADGE.ok,
  error: STATE_BADGE.error,
  expired: { text: "Token ditolak", className: "bg-tag-yellow text-tag-yellow-ink" },
};

const ACTIVE_BADGE = "rounded px-1.5 py-0.5 text-[11px] bg-accent-soft text-accent-ink";
const SECONDARY_BUTTON = "rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:border-line-strong disabled:opacity-40";

/** Tugas Claude yang prosesnya mungkin masih hidup: mereka tetap memakai akun lama sampai prosesnya dimulai ulang. */
function liveClaudeTasks(tasks: TaskListItem[]): number {
  return tasks.filter((task) => (task.assignments.at(-1)?.engine ?? "claude") === "claude" && ["running", "waiting"].includes(task.status)).length;
}

/** Ganti akun yang dipakai bot Claude: login claude.ai atau gateway. */
async function switchClaudeSource(source: ClaudeSource, tasks: TaskListItem[]): Promise<void> {
  const live = liveClaudeTasks(tasks);
  if (
    live > 0 &&
    !confirm(
      `Bot Claude akan memakai ${source === "gateway" ? "gateway" : "login claude.ai"}.\n\n` +
        `${live} tugas Claude yang sedang berjalan tetap memakai akun lama sampai prosesnya dimulai ulang.`,
    )
  ) {
    return;
  }
  try {
    const { account } = await api.setClaudeSource(source);
    putAccount(account);
  } catch (error) {
    alert((error as Error).message);
  }
}

export function ago(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "baru saja";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}

function loginActive(account: AccountView): boolean {
  const phase = account.login?.phase;
  return phase === "starting" || phase === "awaiting_code" || phase === "verifying";
}

/** Akun yang loginnya masih ada: pemakaiannya bisa dibaca dari agen. */
function usageReadable(account: AccountView): boolean {
  return account.state === "ok" || account.state === "error";
}

type PerProvider<T> = Partial<Record<ProviderId, T>>;

/** Sisakan hanya entri agen di `providers`. */
function keepOnly<T>(state: PerProvider<T>, providers: ProviderId[]): PerProvider<T> {
  return Object.fromEntries(Object.entries(state).filter(([provider]) => providers.includes(provider as ProviderId))) as PerProvider<T>;
}

function AccountCard({
  account,
  tasks,
  onLogin,
  usage,
  usageLoading,
  usageFailure,
  onChecked,
}: {
  account: AccountView;
  tasks: TaskListItem[];
  onLogin: () => void;
  usage?: AgentUsage;
  usageLoading: boolean;
  usageFailure?: string;
  /** Setelah Periksa berhasil: baca ulang pemakaian agen ini. */
  onChecked: () => void;
}) {
  const [busy, setBusy] = useState<"check" | "logout" | "source">();
  // Hanya relevan kalau ada gateway: dua akun Claude, satu yang dipakai bot.
  const twoClaude = account.provider === "claude" && account.gateway !== undefined;
  const inUse = twoClaude && account.claudeSource !== "gateway";
  const badge = loginActive(account) ? { text: "Menunggu login…", className: "bg-tag-blue text-tag-blue-ink" } : STATE_BADGE[account.state];
  const has = account.state === "ok" || account.state === "error" || account.state === "expired";

  const run = async (kind: "check" | "logout") => {
    if (kind === "logout") {
      const affected = tasks.filter(
        (task) =>
          (task.assignments.at(-1)?.engine ?? "claude") === account.engine &&
          ["queued", "running", "waiting", "needs_review"].includes(task.status),
      ).length;
      const ok = confirm(
        `Keluar dari akun ${account.label}${account.email ? ` (${account.email})` : ""}?\n\n` +
          (account.claudeSource === "gateway"
            ? "Bot Claude tetap berjalan lewat gateway."
            : `Bot di mesin ${account.label} tidak bisa dijalankan sampai Anda login lagi.` +
              (affected ? ` ${affected} tugas yang belum selesai memakai mesin ini.` : "")) +
          `\nRiwayat tugas tetap tersimpan.`,
      );
      if (!ok) return;
    }
    setBusy(kind);
    try {
      const { account: next } = kind === "check" ? await api.checkAccount(account.provider) : await api.logoutAccount(account.provider);
      putAccount(next);
      if (kind === "check") onChecked();
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{twoClaude ? `${account.label} · claude.ai` : account.label}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${badge.className}`}>{badge.text}</span>
            {inUse && <span className={ACTIVE_BADGE}>Dipakai bot</span>}
            {account.email && <span className="truncate text-xs text-muted">{account.email}</span>}
            {account.plan && <span className="text-xs text-faint">· {account.plan}</span>}
          </div>
          <p className="mt-1 text-xs text-faint">
            {account.state === "none" || account.state === "unavailable"
              ? ABOUT[account.provider]
              : [
                  account.checkedAt ? `Diperiksa ${ago(account.checkedAt)}` : undefined,
                  account.models.length ? `${account.models.length} model` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </p>
          {account.reason && account.state !== "ok" && <p className="mt-1 text-xs text-tag-yellow-ink">{account.reason}</p>}
          {account.reason && account.state === "ok" && <p className="mt-1 text-xs text-faint">{account.reason}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {loginActive(account) ? (
            <button onClick={onLogin} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover">
              Lanjutkan login
            </button>
          ) : account.state === "none" ? (
            <button onClick={onLogin} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover">
              Tambah akun
            </button>
          ) : account.state === "unavailable" ? null : (
            <>
              {twoClaude && !inUse && (account.state === "ok" || account.state === "error") && (
                <button
                  onClick={async () => {
                    setBusy("source");
                    await switchClaudeSource("oauth", tasks);
                    setBusy(undefined);
                  }}
                  disabled={busy !== undefined}
                  className={SECONDARY_BUTTON}
                >
                  Pakai untuk bot
                </button>
              )}
              {account.state !== "ok" && (
                <button onClick={onLogin} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover">
                  Login ulang
                </button>
              )}
              <button
                onClick={() => void run("check")}
                disabled={busy !== undefined}
                className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:border-line-strong disabled:opacity-40"
              >
                {busy === "check" ? "Memeriksa…" : "Periksa"}
              </button>
              {has && (
                <button
                  onClick={() => void run("logout")}
                  disabled={busy !== undefined}
                  className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:border-line-strong disabled:opacity-40"
                >
                  {busy === "logout" ? "Keluar…" : "Keluar"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {usageReadable(account) && !loginActive(account) && (
        <AccountUsage provider={account.provider} usage={usage} loading={usageLoading} failure={usageFailure} ago={(iso) => ago(iso)} />
      )}
    </div>
  );
}

/** Kartu gateway Claude (base URL + token), di bawah kartu login claude.ai. */
function GatewayCard({ account, tasks, onEdit }: { account: AccountView; tasks: TaskListItem[]; onEdit: () => void }) {
  const [busy, setBusy] = useState<"check" | "remove" | "source">();
  const gateway = account.gateway;
  const active = account.claudeSource === "gateway";

  const run = async (kind: "check" | "remove" | "source") => {
    if (kind === "remove") {
      const ok = confirm(
        `Hapus gateway ${gateway?.host ?? ""}?\n\n` +
          (active ? "Bot Claude kembali memakai login claude.ai. " : "") +
          "Token yang tersimpan di app ikut dihapus. Riwayat tugas tetap tersimpan.",
      );
      if (!ok) return;
    }
    setBusy(kind);
    try {
      if (kind === "source") {
        await switchClaudeSource("gateway", tasks);
      } else {
        const { account: next } = kind === "check" ? await api.checkGateway() : await api.removeGateway();
        putAccount(next);
      }
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const badge = gateway ? GATEWAY_BADGE[gateway.state] : STATE_BADGE.none;
  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{account.label} · Gateway</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${badge.className}`}>{badge.text}</span>
            {active && <span className={ACTIVE_BADGE}>Dipakai bot</span>}
            {gateway && (
              <span className="truncate font-mono text-xs text-muted">
                {gateway.host} · token {gateway.tokenHint}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-faint">
            {!gateway
              ? GATEWAY_ABOUT
              : [
                  gateway.checkedAt ? `Diperiksa ${ago(gateway.checkedAt)}` : undefined,
                  gateway.models.length ? `${gateway.models.length} model` : undefined,
                  "kuota tidak dilaporkan gateway",
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </p>
          {gateway?.reason && <p className="mt-1 text-xs text-tag-yellow-ink">{gateway.reason}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!gateway ? (
            <button onClick={onEdit} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover">
              Tambah gateway
            </button>
          ) : (
            <>
              {!active && (
                <button onClick={() => void run("source")} disabled={busy !== undefined} className={SECONDARY_BUTTON}>
                  Pakai untuk bot
                </button>
              )}
              {gateway.state === "expired" ? (
                <button onClick={onEdit} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover">
                  Perbarui token
                </button>
              ) : (
                <button onClick={onEdit} disabled={busy !== undefined} className={SECONDARY_BUTTON}>
                  Ubah
                </button>
              )}
              <button onClick={() => void run("check")} disabled={busy !== undefined} className={SECONDARY_BUTTON}>
                {busy === "check" ? "Memeriksa…" : "Periksa"}
              </button>
              <button onClick={() => void run("remove")} disabled={busy !== undefined} className={SECONDARY_BUTTON}>
                {busy === "remove" ? "Menghapus…" : "Hapus"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Pengaturan → Akun AI: login milik app untuk tiap penyedia, satu akun per penyedia (Claude bisa ditambah gateway). */
export function AccountsSection({ tasks }: { tasks: TaskListItem[] }) {
  const accounts = useAccounts();
  const [login, setLogin] = useState<ProviderId>();
  const [gatewayDialog, setGatewayDialog] = useState(false);
  const [usage, setUsage] = useState<PerProvider<AgentUsage>>({});
  const [usageLoading, setUsageLoading] = useState<PerProvider<boolean>>({});
  const [usageFailure, setUsageFailure] = useState<PerProvider<string>>({});
  /** Nomor permintaan terakhir tiap agen: jawaban permintaan yang sudah tersusul dibuang. */
  const latest = useRef<PerProvider<number>>({});

  /**
   * Baca pemakaian satu agen; `force` = baca ulang tanpa cache server. Tiap agen dimuat sendiri, jadi
   * kartu Claude tidak menunggu agy yang lambat, dan hanya permintaan terakhir yang mengisi kartunya.
   */
  const loadUsage = useCallback(async (provider: ProviderId, force = false) => {
    const id = (latest.current[provider] ?? 0) + 1;
    latest.current[provider] = id;
    const current = () => latest.current[provider] === id;
    setUsageLoading((state) => ({ ...state, [provider]: true }));
    try {
      const { usage: list } = await api.accountsUsage(provider, force);
      if (!current()) return;
      setUsage((state) => ({ ...state, [provider]: list.find((item) => item.provider === provider) }));
      setUsageFailure((state) => ({ ...state, [provider]: undefined }));
    } catch (error) {
      if (current()) setUsageFailure((state) => ({ ...state, [provider]: (error as Error).message }));
    } finally {
      if (current()) setUsageLoading((state) => ({ ...state, [provider]: false }));
    }
  }, []);

  // Muat saat Pengaturan dibuka dan setiap kali status login berubah (login baru, keluar, kedaluwarsa).
  const readable = (accounts ?? []).filter(usageReadable).map((account) => account.provider);
  const readableKey = readable.join(",");
  useEffect(() => {
    const providers = readableKey ? (readableKey.split(",") as ProviderId[]) : [];
    // Agen yang loginnya hilang: buang angka, galat, dan jawaban yang masih di jalan, supaya login
    // berikutnya (mungkin akun lain) tidak menampilkan kuota akun lama.
    for (const provider of Object.keys(latest.current) as ProviderId[]) {
      if (!providers.includes(provider)) latest.current[provider] = (latest.current[provider] ?? 0) + 1;
    }
    setUsage((state) => keepOnly(state, providers));
    setUsageFailure((state) => keepOnly(state, providers));
    setUsageLoading((state) => keepOnly(state, providers));
    for (const provider of providers) void loadUsage(provider);
  }, [readableKey, loadUsage]);

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-muted">Akun AI</h3>
      <p className="mt-1 text-xs text-faint">
        Login milik app ini, terpisah dari <code>claude</code> dan <code>agy</code> di terminal. Bot hanya bisa memakai mesin
        yang akunnya ada di sini. Hanya untuk dipakai sendiri di mesin ini — jangan bagikan app dengan login Anda.
      </p>
      <div className="mt-3 divide-y divide-line rounded-lg border border-line bg-panel">
        {!accounts ? (
          <p className="px-3 py-3 text-xs text-faint">Memuat akun…</p>
        ) : (
          accounts.map((account) => (
            <Fragment key={account.provider}>
              <AccountCard
                account={account}
                tasks={tasks}
                onLogin={() => setLogin(account.provider)}
                usage={readable.includes(account.provider) ? usage[account.provider] : undefined}
                usageLoading={usageLoading[account.provider] ?? false}
                usageFailure={usageFailure[account.provider]}
                onChecked={() => void loadUsage(account.provider, true)}
              />
              {account.provider === "claude" && <GatewayCard account={account} tasks={tasks} onEdit={() => setGatewayDialog(true)} />}
            </Fragment>
          ))
        )}
      </div>
      {login && <LoginDialog provider={login} onClose={() => setLogin(undefined)} />}
      {gatewayDialog && (
        <GatewayDialog
          gateway={accounts?.find((account) => account.provider === "claude")?.gateway}
          onClose={() => setGatewayDialog(false)}
        />
      )}
    </section>
  );
}
