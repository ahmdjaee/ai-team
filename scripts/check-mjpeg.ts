/**
 * Uji pemisah bagian MJPEG untuk aplikasi desktop (web/lib/mjpeg.ts).
 * Deterministik, tanpa browser dan tanpa biaya model: bun run check:mjpeg
 */
import { createPartSplitter } from "../web/lib/mjpeg.ts";

// Framing yang sama dengan server/browser/live.ts: header pembuka, lalu tiap frame diikuti
// CRLF dan header bagian berikutnya.
const BOUNDARY = "frame";
const encode = (text: string) => new TextEncoder().encode(text);
const HEADER = encode(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`);
const TAIL = encode(`\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Pembangkit acak tetap supaya hasil uji selalu sama.
let seed = 0x2f6e2b1;
function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

const frames: Uint8Array[] = [
  bytes(1),
  bytes(300),
  // Isi yang mirip batas tetapi bukan batas: tidak boleh memotong frame.
  concat([bytes(40), encode("\r\n--fram"), bytes(40), encode("\r\n-\r\n--fra-me"), bytes(5)]),
  concat([encode("\r\n"), bytes(64), encode("\r\n")]),
  bytes(70_000),
  bytes(2),
];

const stream = concat([encode("pembuka yang diabaikan\r\n"), HEADER, ...frames.flatMap((frame) => [frame, TAIL])]);

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

let failures = 0;
function check(name: string, chunkSizes: (remaining: number) => number): void {
  const got: Uint8Array[] = [];
  const feed = createPartSplitter(BOUNDARY, (body) => got.push(body));
  for (let offset = 0; offset < stream.length; ) {
    const size = Math.max(1, Math.min(stream.length - offset, chunkSizes(stream.length - offset)));
    feed(stream.subarray(offset, offset + size));
    offset += size;
  }
  const ok = got.length === frames.length && got.every((body, index) => equal(body, frames[index]!));
  if (!ok) failures += 1;
  const detail = ok ? "" : ` — ${got.length}/${frames.length} frame, panjang: ${got.map((body) => body.length).join(",")}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail}`);
}

check("satu chunk utuh", (remaining) => remaining);
for (const size of [1, 2, 3, 7, 13, 64, 1000, 16_384]) check(`chunk ${size} byte`, () => size);
check("chunk acak 1–5000 byte", () => 1 + Math.floor(random() * 5000));

// Frame terakhir tanpa batas penutup belum boleh keluar: batasnya belum terlihat.
{
  const got: number[] = [];
  const feed = createPartSplitter(BOUNDARY, (body) => got.push(body.length));
  feed(concat([HEADER, bytes(10), TAIL, bytes(20)]));
  const ok = got.length === 1 && got[0] === 10;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} frame yang belum ditutup batas ditahan`);
}

if (failures > 0) {
  console.error(`\n${failures} uji gagal`);
  process.exit(1);
}
console.log("\nsemua uji lolos");
