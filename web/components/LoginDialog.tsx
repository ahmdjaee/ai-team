import { useEffect, useRef, useState } from "react";
import { api, type ProviderId } from "../api.ts";
import { putAccount, useAccount } from "../accounts.ts";
import { GeminiRiskNote } from "./EnginePicker.tsx";

const HINT: Record<ProviderId, { page: string; code: string }> = {
  claude: {
    page: "Masuk dengan akun Claude Anda (bisa lewat Google). Pakai akun langganan Pro/Max.",
    code: "Setelah login, halaman Claude menampilkan kode. Salin lalu tempel di sini.",
  },
  gemini: {
    page: "Masuk dengan akun Google yang ingin dipakai bot Gemini.",
    code: "Setelah login, Google membuka halaman Antigravity. Tempel kode yang tampil di sana, atau alamat lengkap halaman itu.",
  },
};

function remaining(expiresAt: string | undefined, now: number): string | undefined {
  if (!expiresAt) return undefined;
  const left = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/**
 * Hubungkan akun lewat alur login resmi CLI-nya, dijalankan server sebagai proses milik app:
 * buka halaman login di tab baru, lalu tempel kode yang ditampilkan halaman itu. Statusnya hidup di
 * server, jadi dialog ini bisa ditutup dan dibuka lagi tanpa kehilangan login yang sedang berjalan.
 */
export function LoginDialog({ provider, onClose }: { provider: ProviderId; onClose: () => void }) {
  const account = useAccount(provider);
  const login = account?.login;
  const phase = login?.phase;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);

  const start = async () => {
    setError(undefined);
    setCode("");
    setBusy(true);
    try {
      putAccount((await api.startLogin(provider)).account);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Dibuka tanpa login yang berjalan → mulai satu. Login yang masih berjalan dilanjutkan.
  useEffect(() => {
    if (!account || started.current) return;
    started.current = true;
    if (!login || login.phase === "cancelled" || login.phase === "failed" || login.phase === "done") void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      putAccount((await api.submitLoginCode(provider, code.trim())).account);
      setCode("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = async (cancel: boolean) => {
    // Batal menghentikan proses login; Selesai/Tutup cukup melupakan hasilnya.
    if (cancel || (phase && phase !== "starting" && phase !== "awaiting_code" && phase !== "verifying")) {
      await api.closeLogin(provider).then((data) => putAccount(data.account), () => undefined);
    }
    onClose();
  };

  const copy = async () => {
    if (!login?.url) return;
    try {
      await navigator.clipboard.writeText(login.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const label = account?.label ?? (provider === "claude" ? "Claude" : "Gemini");
  const active = phase === "starting" || phase === "awaiting_code" || phase === "verifying";
  const left = active ? remaining(login?.expiresAt, now) : undefined;

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-scrim p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        className="w-full max-w-lg rounded-xl border border-line bg-raised p-5 shadow-2xl"
      >
        <h3 id="login-title" className="text-sm font-semibold text-ink">
          Hubungkan akun {label}
        </h3>
        <p className="mt-1 text-xs text-faint">
          Login ini milik app AI Team, terpisah dari {provider === "claude" ? "`claude`" : "`agy`"} yang Anda pakai di terminal.
        </p>

        {phase === "done" ? (
          <div className="mt-4 rounded-lg border border-line bg-panel p-3">
            <p className="text-sm text-tag-green-ink">✓ Terhubung{account?.email ? ` sebagai ${account.email}` : ""}{account?.plan ? ` (${account.plan})` : ""}</p>
            <p className="mt-1 text-xs text-faint">Bot yang memakai {label} sekarang bisa dijalankan.</p>
          </div>
        ) : phase === "failed" || (!active && error) ? (
          <div className="mt-4 rounded-lg border border-line bg-panel p-3">
            <p className="text-sm text-tag-red-ink">Login belum berhasil.</p>
            <p className="mt-1 text-xs text-muted">{login?.error ?? error}</p>
          </div>
        ) : (
          <ol className="mt-4 space-y-4">
            <li className="flex gap-3">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] text-accent-ink">1</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">Masuk di halaman login</p>
                <p className="mt-0.5 text-xs text-faint">{HINT[provider].page}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {login?.url ? (
                    <>
                      <a
                        href={login.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
                      >
                        Buka halaman login ↗
                      </a>
                      <button onClick={() => void copy()} className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:border-line-strong">
                        {copied ? "Tersalin" : "Salin tautan"}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-faint">◌ Menyiapkan halaman login…</span>
                  )}
                </div>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] text-accent-ink">2</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">Tempel kode dari halaman itu</p>
                <p className="mt-0.5 text-xs text-faint">{HINT[provider].code}</p>
                <div className="mt-2 flex gap-2">
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submit();
                    }}
                    disabled={phase !== "awaiting_code" || busy}
                    placeholder={phase === "verifying" ? "Memeriksa…" : "Tempel kode di sini"}
                    aria-label="Kode login"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-page px-3 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
                  />
                  <button
                    onClick={() => void submit()}
                    disabled={phase !== "awaiting_code" || busy || !code.trim()}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:border-line-strong disabled:opacity-40"
                  >
                    Kirim kode
                  </button>
                </div>
                {error && active && <p className="mt-1 text-xs text-tag-red-ink">{error}</p>}
              </div>
            </li>
          </ol>
        )}

        {provider === "gemini" && <GeminiRiskNote className="mt-4" />}

        <div className="mt-5 flex items-center gap-2">
          <span className="mr-auto text-[11px] text-faint">
            {phase === "verifying" ? "◌ Memeriksa login…" : phase === "awaiting_code" ? "◌ Menunggu login…" : ""}
            {left ? ` sisa ${left}` : ""}
          </span>
          {active ? (
            <button onClick={() => void close(true)} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
              Batal
            </button>
          ) : phase === "done" ? (
            <button
              onClick={() => void close(false)}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              Selesai
            </button>
          ) : (
            <>
              <button onClick={() => void close(false)} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
                Tutup
              </button>
              <button
                onClick={() => void start()}
                disabled={busy}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
              >
                Coba lagi
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
