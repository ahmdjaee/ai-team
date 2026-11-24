import { isConnected, onConnection } from "./realtime.ts";

/**
 * Deteksi rilis UI baru. Layanan melayani `dist/` apa adanya, jadi halaman yang sudah terbuka tetap menjalankan
 * bundle lama sampai dimuat ulang. Ini berlaku untuk tab browser dan juga jendela aplikasi desktop, yang
 * disembunyikan ke tray dan dibuka lagi tanpa pernah dimuat ulang.
 *
 * Cara memeriksanya: ambil ulang `index.html`, lalu bandingkan skrip utamanya (nama berkas Vite berisi hash)
 * dengan yang sedang berjalan. Pemeriksaan jalan saat WebSocket tersambung lagi (server di-restart setelah rilis)
 * dan saat halaman terlihat lagi (rilis `bun run build` tanpa restart). Kalau ada versi baru:
 * - halaman yang tidak terlihat langsung dimuat ulang;
 * - halaman yang sedang dipakai menampilkan tombol Muat ulang, supaya ketikan tidak terpotong. Begitu halaman
 *   itu disembunyikan, ia dimuat ulang sendiri.
 *
 * Draf chat tugas dan catatan disimpan ke server saat halaman disembunyikan (juga saat dimuat ulang), jadi reload
 * tidak menghilangkannya.
 */

const ENTRY = /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/;
/** Batas pemeriksaan saat halaman terlihat lagi; pemeriksaan setelah tersambung ulang selalu jalan. */
const RECHECK_MS = 60_000;
/** Beri penyimpan draf (yang juga mendengar `visibilitychange`) waktu mengirim sebelum halaman dimuat ulang. */
const RELOAD_DELAY_MS = 1_000;

/** Skrip utama halaman ini, mis. `/assets/index-C7IMzyxC.js`. Kosong di server dev Vite: fitur ini mati di sana. */
function loadedEntry(): string | undefined {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const src = script.getAttribute("src") ?? "";
    if (src.startsWith("/assets/")) return src;
  }
  return undefined;
}

async function latestEntry(): Promise<string | undefined> {
  const response = await fetch("/", { cache: "no-store" });
  if (!response.ok) return undefined;
  return ENTRY.exec(await response.text())?.[1];
}

/** `onAvailable` dipanggil sekali, saat versi baru ditemukan dan halamannya sedang terlihat. */
export function watchForUpdate(onAvailable: () => void): () => void {
  const loaded = loadedEntry();
  if (!loaded) return () => undefined;

  let found = false;
  let checking = false;
  let reloading = false;
  let lastCheck = Date.now();
  let wasConnected = isConnected();

  const reloadSoon = () => {
    if (reloading) return;
    reloading = true;
    setTimeout(() => location.reload(), RELOAD_DELAY_MS);
  };

  const check = async () => {
    if (found || checking) return;
    checking = true;
    lastCheck = Date.now();
    try {
      const latest = await latestEntry();
      if (latest && latest !== loaded) {
        found = true;
        if (document.visibilityState === "hidden") reloadSoon();
        else onAvailable();
      }
    } catch {
      // Server sedang tidak bisa dihubungi: diperiksa lagi saat sambungan pulih.
    } finally {
      checking = false;
    }
  };

  const offConnection = onConnection((connected) => {
    if (connected && !wasConnected) void check();
    wasConnected = connected;
  });
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (found) reloadSoon();
    } else if (Date.now() - lastCheck >= RECHECK_MS) {
      void check();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    offConnection();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
