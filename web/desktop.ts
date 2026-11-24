/**
 * Jembatan ke aplikasi desktop (Tauri, `src-tauri/`). Aplikasi itu jendela tipis yang membuka layanan
 * yang sama dengan browser, jadi UI ini tidak berubah; `isDesktop` hanya benar di dalam jendelanya.
 * Di browser biasa semua fungsi di bawah tidak melakukan apa-apa.
 * Perintahnya didefinisikan di `src-tauri/src/commands.rs`.
 */
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function invoker(): Invoke | undefined {
  if (typeof window === "undefined") return undefined;
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return tauri?.core?.invoke;
}

export const isDesktop = invoker() !== undefined;

async function call(command: string, args?: Record<string, unknown>): Promise<boolean> {
  const invoke = invoker();
  if (!invoke) return false;
  try {
    await invoke(command, args);
    return true;
  } catch (error) {
    console.warn(`desktop: ${command} gagal`, error);
    return false;
  }
}

/** Notifikasi desktop (libnotify), pengganti Notification API yang tidak ada di webview. */
export function notifyNative(title: string, body: string): void {
  void call("notify", { title, body });
}

/** Buka URL http(s) di browser bawaan sistem. */
export function openExternal(url: string): Promise<boolean> {
  return call("browse", { url });
}

/**
 * Webview hanya punya satu halaman: tautan `target="_blank"` dan tautan ke situs lain dibuka di
 * browser sistem supaya jendela aplikasi tidak berpindah halaman.
 */
export function installExternalLinks(): void {
  if (!isDesktop) return;
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, location.href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (anchor.target !== "_blank" && url.origin === location.origin) return;
      event.preventDefault();
      void openExternal(url.href);
    },
    true,
  );
}
