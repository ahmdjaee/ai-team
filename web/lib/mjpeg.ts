/**
 * Pemutar aliran MJPEG lewat fetch, untuk webview aplikasi desktop.
 *
 * Di browser biasa aliran `multipart/x-mixed-replace` cukup dipasang di `<img src>`. WebKitGTK juga
 * menampilkannya, tetapi tidak pernah menutup sambungannya — tidak saat `src` dikosongkan, tidak saat
 * elemennya dilepas — sehingga server terus menganggap ada penonton dan screencast bot tidak pernah
 * berhenti. fetch bisa dibatalkan dengan pasti, jadi di sana bagian-bagiannya dipisah sendiri dan
 * tiap frame dipasang ke `<img>` yang sama sebagai blob.
 *
 * WebKit memutus fetch ke respons bertipe multipart, jadi alirannya diminta dengan `?raw=1`: isi yang
 * sama, bertipe `application/octet-stream`, dengan batas bagian tetap di parameter `boundary`.
 */

function indexOf(buffer: Uint8Array, pattern: Uint8Array, from: number): number {
  const last = buffer.length - pattern.length;
  outer: for (let i = Math.max(0, from); i <= last; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (buffer[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const HEADER_END = new Uint8Array([13, 10, 13, 10]);

/**
 * Memisahkan aliran multipart menjadi badan tiap bagian. Sebuah bagian dianggap selesai begitu
 * batas berikutnya terlihat; server menulis batas itu tepat di belakang setiap frame.
 */
export function createPartSplitter(boundary: string, onPart: (body: Uint8Array) => void): (chunk: Uint8Array) => void {
  const open = new TextEncoder().encode(`--${boundary}`);
  const next = new TextEncoder().encode(`\r\n--${boundary}`);
  let buffer = new Uint8Array(0);
  // -1 = belum berada di dalam badan bagian; selain itu indeks awal badan di `buffer`.
  let body = -1;
  let scanned = 0;

  return (chunk) => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;

    for (;;) {
      if (body < 0) {
        const start = indexOf(buffer, open, 0);
        if (start < 0) {
          // Sisakan ekor yang mungkin awal batas yang terpotong di antara dua chunk.
          buffer = buffer.slice(Math.max(0, buffer.length - open.length));
          return;
        }
        const end = indexOf(buffer, HEADER_END, start + open.length);
        if (end < 0) {
          buffer = buffer.slice(start);
          return;
        }
        body = end + HEADER_END.length;
        scanned = body;
      }
      const stop = indexOf(buffer, next, scanned);
      if (stop < 0) {
        // Jangan memindai ulang byte yang sudah diperiksa pada chunk berikutnya.
        scanned = Math.max(body, buffer.length - next.length + 1);
        return;
      }
      if (stop > body) onPart(buffer.slice(body, stop));
      // Batas itu sekaligus pembuka bagian berikutnya (lewati CRLF di depannya).
      buffer = buffer.slice(stop + 2);
      body = -1;
    }
  };
}

/**
 * Memutar aliran ke `image` sampai `signal` dibatalkan atau server menutupnya. Frame terakhir
 * tetap tampil. Frame yang datang saat frame sebelumnya masih didekode dilewati, kecuali yang
 * terbaru — tampilan tidak pernah tertinggal dari aliran.
 */
export async function playMjpeg(url: string, image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  let shown: string | undefined;
  let loading: string | undefined;
  let queued: Uint8Array | undefined;
  // Blob frame yang sedang tampil baru dilepas saat pemutaran dibatalkan (elemen diganti atau
  // dilepas). Kalau aliran berakhir sendiri, frame terakhir harus tetap bisa digambar ulang.
  signal.addEventListener(
    "abort",
    () => {
      if (shown) URL.revokeObjectURL(shown);
    },
    { once: true },
  );

  const paint = (frame: Uint8Array) => {
    const next = URL.createObjectURL(new Blob([frame as BlobPart], { type: "image/jpeg" }));
    loading = next;
    const settle = () => {
      if (loading !== next) return;
      loading = undefined;
      if (shown) URL.revokeObjectURL(shown);
      shown = next;
      if (queued && !signal.aborted) {
        const frame = queued;
        queued = undefined;
        paint(frame);
      }
    };
    image.onload = settle;
    image.onerror = settle;
    image.src = next;
  };

  try {
    const response = await fetch(url, { signal, cache: "no-store" });
    const boundary = /boundary=("?)([^";]+)\1/i.exec(response.headers.get("content-type") ?? "")?.[2];
    if (!response.ok || !response.body || !boundary) return;

    const feed = createPartSplitter(boundary, (frame) => {
      if (loading) queued = frame;
      else paint(frame);
    });
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) feed(value);
    }
  } catch {
    // Dibatalkan atau sambungan putus: frame terakhir dibiarkan tampil.
  } finally {
    image.onload = null;
    image.onerror = null;
    queued = undefined;
    if (loading) URL.revokeObjectURL(loading);
  }
}
