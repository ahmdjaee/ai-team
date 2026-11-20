import { useState } from "react";
import { api, type AccountView, type ProviderId, type TaskListItem } from "../api.ts";
import { putAccount, useAccounts } from "../accounts.ts";
import { LoginDialog } from "./LoginDialog.tsx";

const STATE_BADGE: Record<AccountView["state"], { text: string; className: string }> = {
  ok: { text: "Terhubung", className: "bg-tag-green text-tag-green-ink" },
  error: { text: "Gagal diperiksa", className: "bg-tag-orange text-tag-orange-ink" },
  expired: { text: "Perlu login ulang", className: "bg-tag-yellow text-tag-yellow-ink" },
  none: { text: "Belum ditambahkan", className: "bg-tag-gray text-tag-gray-ink" },
  unavailable: { text: "Belum tersedia", className: "bg-tag-gray text-tag-gray-ink" },
};

const ABOUT: Record<ProviderId, string> = {
  claude: "Login langganan Claude (Pro/Max). Dipakai bot, panel Tanya, dan kurator memori.",
  gemini: "Login Google lewat Antigravity CLI. Dipakai bot yang Anda pasang ke mesin Gemini.",
};

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

function AccountCard({ account, tasks, onLogin }: { account: AccountView; tasks: TaskListItem[]; onLogin: () => void }) {
  const [busy, setBusy] = useState<"check" | "logout">();
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
          `Bot di mesin ${account.label} tidak bisa dijalankan sampai Anda login lagi.` +
          (affected ? ` ${affected} tugas yang belum selesai memakai mesin ini.` : "") +
          `\nRiwayat tugas tetap tersimpan.`,
      );
      if (!ok) return;
    }
    setBusy(kind);
    try {
      const { account: next } = kind === "check" ? await api.checkAccount(account.provider) : await api.logoutAccount(account.provider);
      putAccount(next);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{account.label}</span>
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${badge.className}`}>{badge.text}</span>
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
  );
}

/** Pengaturan → Akun AI: login milik app untuk tiap penyedia, satu akun per penyedia. */
export function AccountsSection({ tasks }: { tasks: TaskListItem[] }) {
  const accounts = useAccounts();
  const [login, setLogin] = useState<ProviderId>();

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
            <AccountCard key={account.provider} account={account} tasks={tasks} onLogin={() => setLogin(account.provider)} />
          ))
        )}
      </div>
      {login && <LoginDialog provider={login} onClose={() => setLogin(undefined)} />}
    </section>
  );
}
