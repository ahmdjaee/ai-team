import { useEffect, useState } from "react";
import { api, type GatewayView } from "../api.ts";
import { putAccount } from "../accounts.ts";

/**
 * Tambah atau ubah gateway Claude: base URL + token API yang kompatibel dengan Anthropic, sama dengan
 * `ANTHROPIC_BASE_URL` dan `ANTHROPIC_AUTH_TOKEN` di terminal. Server mengujinya ke `/v1/models`
 * (tanpa kuota) sebelum menyimpan. Token tidak pernah dikirim balik ke halaman ini.
 */
export function GatewayDialog({ gateway, onClose }: { gateway?: GatewayView; onClose: () => void }) {
  const editing = gateway !== undefined;
  const [baseUrl, setBaseUrl] = useState(gateway?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const ready = baseUrl.trim() !== "" && (editing || token.trim() !== "");

  const submit = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { account } = await api.saveGateway({
        baseUrl: baseUrl.trim(),
        token: token.trim() || undefined,
        activate: editing ? undefined : activate,
      });
      putAccount(account);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter") void submit();
  };

  const input =
    "w-full rounded-lg border border-line bg-page px-3 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-scrim p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-title"
        className="w-full max-w-lg rounded-xl border border-line bg-raised p-5 shadow-2xl"
      >
        <h3 id="gateway-title" className="text-sm font-semibold text-ink">
          {editing ? "Ubah gateway Claude" : "Tambah gateway Claude"}
        </h3>
        <p className="mt-1 text-xs text-faint">
          Isinya sama dengan <code>ANTHROPIC_BASE_URL</code> dan <code>ANTHROPIC_AUTH_TOKEN</code> yang Anda pakai di terminal.
          Token disimpan di folder akun app, yang tertutup untuk bot.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs text-muted">Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              onKeyDown={onEnter}
              disabled={busy}
              placeholder="http://host:port"
              autoComplete="off"
              spellCheck={false}
              autoFocus={!editing}
              className={`mt-1 ${input}`}
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={onEnter}
              disabled={busy}
              placeholder={editing ? `Kosongkan untuk tetap memakai token ${gateway.tokenHint}` : "Tempel token di sini"}
              autoComplete="new-password"
              spellCheck={false}
              autoFocus={editing}
              className={`mt-1 ${input}`}
            />
          </label>
          {!editing && (
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={activate} onChange={(event) => setActivate(event.target.checked)} disabled={busy} />
              Langsung pakai untuk bot Claude
            </label>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-tag-red-ink">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          <span className="mr-auto text-[11px] text-faint">{busy ? "◌ Menguji gateway…" : "Diuji lewat /v1/models, tanpa memakai kuota."}</span>
          <button onClick={onClose} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink disabled:opacity-40">
            Batal
          </button>
          <button
            onClick={() => void submit()}
            disabled={!ready || busy}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            Simpan & uji
          </button>
        </div>
      </div>
    </div>
  );
}
