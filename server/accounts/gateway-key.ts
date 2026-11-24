/**
 * `apiKeyHelper` untuk sesi Claude yang memakai gateway: cetak token dari berkas gateway (argumen
 * pertama) tanpa newline. Dijalankan oleh CLI Claude, bukan oleh server, jadi sengaja tidak mengimpor
 * kode app. Berkas hilang, rusak, atau tanpa token = keluar dengan kode 1, dan CLI melaporkan galat login.
 * Pesan galatnya tidak pernah mengutip isi berkas, karena bisa ikut tampil di transkrip bot.
 */
import { readFileSync } from "node:fs";

function fail(reason: string): never {
  process.stderr.write(`gateway-key: ${reason}\n`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) fail("path berkas gateway tidak diberikan");

let raw: string;
try {
  raw = readFileSync(file, "utf8");
} catch {
  fail("berkas gateway tidak bisa dibaca");
}

let token: unknown;
try {
  token = (JSON.parse(raw) as { token?: unknown }).token;
} catch {
  fail("berkas gateway rusak");
}

if (typeof token !== "string" || !token) fail("token gateway kosong");
process.stdout.write(token);
