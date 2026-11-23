/**
 * Uji alur tugas dari chat utama: judul sementara dari pesan pertama, judul otomatis yang tidak
 * menimpa nama pilihan pemilik, tugas yang ditahan sampai lampiran pesan pertama terunggah, dan oper
 * dari kotak chat dengan URL uji dan lampiran.
 * Deterministik, tanpa model dan tanpa menyentuh data asli: bun run check:chat-tasks
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-chat-tasks-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
process.env.CURATOR = "0";
// Judul otomatis sungguhan memanggil model; di uji ini Titler diberi pembuat judul palsu.
process.env.TITLES = "0";

const { CONFIG, ensureDirs } = await import("../server/config.ts");
if (CONFIG.dataDir !== sandbox) throw new Error(`DATA_DIR tidak terpakai: ${CONFIG.dataDir}`);
ensureDirs();

const express = (await import("express")).default;
const { saveAccount } = await import("../server/accounts/store.ts");
const { createProject } = await import("../server/projects.ts");
const { fallbackTitle, getTask, updateTask } = await import("../server/tasks.ts");
const { scheduler } = await import("../server/agent/scheduler.ts");
const { Titler, cleanTitle } = await import("../server/agent/titler.ts");
const { tasksRouter } = await import("../server/routes/tasks.ts");
const { threads } = await import("../server/store.ts");
type AgentRunner = import("../server/agent/runner-api.ts").AgentRunner;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok   " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// ---------- A. judul sementara ----------
check("A1 baris pertama jadi judul", fallbackTitle("Uji alur login staging\nDetailnya di bawah.") === "Uji alur login staging");
check("A2 sebutan @role dibuang", fallbackTitle("@qa cek halaman bayar") === "cek halaman bayar", fallbackTitle("@qa cek halaman bayar"));
check("A3 baris kosong & spasi dilewati", fallbackTitle("\n\n   tolong   rapikan  footer  ") === "tolong rapikan footer");
const long = fallbackTitle("Periksa semua tombol di halaman checkout termasuk kupon diskon dan pilihan pengiriman ekspres");
check("A4 judul panjang dipotong di batas kata", long.length <= 61 && long.endsWith("…") && !long.includes("ekspres"), long);
check("A5 pesan tanpa teks", fallbackTitle("@engineer") === "Tugas baru", fallbackTitle("@engineer"));
check("A6 jawaban model dirapikan", cleanTitle('Judul: "Uji Login Staging".\nAlasan: …') === "Uji Login Staging", cleanTitle('Judul: "Uji Login Staging".'));
check("A7 jawaban kosong ditolak", cleanTitle("  \n ") === undefined);

// ---------- persiapan: akun Claude palsu, runner palsu, server ----------
saveAccount("claude", { addedAt: new Date().toISOString(), status: "ok" });
const sent: Array<{ taskId: string; role: string; text: string; display?: string; from?: string; attachments?: string[] }> = [];
scheduler.registerEngine("claude", ({ taskId, role, mode }): AgentRunner => ({
  taskId,
  role,
  engine: "claude",
  status: "idle",
  autonomyMode: mode,
  setMode: async () => undefined,
  send: (text, options) => sent.push({ taskId, role, text, ...options }),
  interrupt: async () => undefined,
  close: async () => undefined,
  openRequests: () => [],
  resolveRequest: () => false,
  hasRequest: () => false,
}));

const project = createProject({ name: "Toko", targetUrl: "https://toko.test" });
const app = express();
app.use(express.json());
app.use("/api", tasksRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => undefined) };
}

async function upload(taskId: string, name: string, content: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: content,
  });
  return ((await response.json()) as { file: string }).file;
}

try {
  // ---------- B. tugas baru dari chat utama ----------
  {
    const bad = await call("POST", "/api/tasks", { role: "qa", projectId: project.id, description: "  " });
    check("B1 pesan kosong ditolak", bad.status === 400, bad);

    const created = await call("POST", "/api/tasks", { role: "qa", projectId: project.id, description: "Uji alur login di staging\nPakai akun demo." });
    const task = created.json?.task;
    check("B2 tugas dibuat tanpa judul", created.status === 200 && task?.title === "Uji alur login di staging", created);
    check("B3 URL uji bawaan project untuk QA", task?.targetUrl === "https://toko.test", task?.targetUrl);
    check("B4 langsung dijalankan", sent.some((item) => item.taskId === task?.id && item.from === "owner"), sent);
    check("B5 tidak ditahan", getTask(task.id)?.pendingStart === undefined);
  }

  // ---------- C. ditahan sampai lampiran pesan pertama terunggah ----------
  {
    const before = sent.length;
    const created = await call("POST", "/api/tasks", {
      role: "engineer",
      projectId: project.id,
      description: "Perbaiki tombol bayar sesuai gambar",
      hold: true,
    });
    const id = created.json?.task?.id as string;
    check("C1 tugas ditahan", getTask(id)?.pendingStart === true && sent.length === before, getTask(id));
    check("C2 bot tanpa browser tidak diberi URL", getTask(id)?.targetUrl === undefined, getTask(id)?.targetUrl);
    const file = await upload(id, "tombol.png", "png");
    const missing = await call("POST", `/api/tasks/${id}/start`, { attachments: ["tidak-ada.png"] });
    check("C3 lampiran yang tidak ada ditolak", missing.status === 400 && getTask(id)?.pendingStart === true, missing);
    const started = await call("POST", `/api/tasks/${id}/start`, { attachments: [file] });
    const opening = sent.at(-1);
    check("C4 start menjalankan tugas", started.status === 200 && getTask(id)?.pendingStart === undefined, started);
    check("C5 lampiran ikut di pesan pembuka", opening?.taskId === id && opening.text.includes(file) && opening.attachments?.[0] === file, opening);
    const again = await call("POST", `/api/tasks/${id}/start`, { attachments: [file] });
    check("C6 start kedua tidak mengirim ulang", again.status === 200 && sent.at(-1) === opening);

    // Server mati di tengah unggahan: resumePending menjalankan tugas yang masih ditahan.
    const held = await call("POST", "/api/tasks", { role: "devops", projectId: project.id, description: "Pasang cron backup", hold: true });
    const heldId = held.json?.task?.id as string;
    scheduler.resumePending();
    check("C7 tugas yang tertahan dijalankan setelah restart", getTask(heldId)?.pendingStart === undefined && sent.some((item) => item.taskId === heldId), getTask(heldId));
  }

  // ---------- D. judul otomatis ----------
  {
    const created = await call("POST", "/api/tasks", { role: "qa", projectId: project.id, description: "tolong cek kenapa halaman keranjang lambat banget" });
    const id = created.json?.task?.id as string;
    const fallback = getTask(id)!.title;
    const titler = new Titler(async () => "Halaman Keranjang Lambat");
    check("D1 judul otomatis menggantikan judul sementara", (await titler.suggest(id, fallback)) === "Halaman Keranjang Lambat" && getTask(id)?.title === "Halaman Keranjang Lambat", getTask(id)?.title);

    const second = (await call("POST", "/api/tasks", { role: "qa", projectId: project.id, description: "uji form kontak" })).json.task.id as string;
    const secondFallback = getTask(second)!.title;
    // Pemilik mengganti nama sebelum model menjawab.
    const slow = new Titler(async () => {
      updateTask(second, { title: "Nama dari pemilik" });
      return "Uji Form Kontak";
    });
    await slow.suggest(second, secondFallback);
    check("D2 nama dari pemilik tidak ditimpa", getTask(second)?.title === "Nama dari pemilik", getTask(second)?.title);

    const broken = new Titler(async () => {
      throw new Error("model mati");
    });
    const third = (await call("POST", "/api/tasks", { role: "qa", projectId: project.id, description: "cek footer" })).json.task.id as string;
    check("D3 model gagal: judul sementara tetap", (await broken.suggest(third, "cek footer")) === undefined && getTask(third)?.title === "cek footer");
  }

  // ---------- E. oper dari kotak chat ----------
  {
    const id = (await call("POST", "/api/tasks", { role: "engineer", projectId: project.id, description: "Perbaiki validasi email" })).json.task.id as string;
    const file = await upload(id, "log.txt", "error");
    await call("PUT", `/api/tasks/${id}/draft`, { text: "cek ulang validasinya", attachments: [file] });
    const handed = await call("POST", `/api/tasks/${id}/handoff`, {
      role: "qa",
      note: "cek ulang validasinya",
      targetUrl: "https://staging.toko.test/daftar",
      attachments: [file],
    });
    const task = getTask(id)!;
    const message = sent.at(-1);
    check("E1 dioper ke QA", handed.status === 200 && task.role === "qa" && task.assignments.length === 2, handed);
    check("E2 URL uji dari kotak chat disimpan", task.targetUrl === "https://staging.toko.test/daftar", task.targetUrl);
    check("E3 catatan & lampiran ikut ke bot baru", message?.role === "qa" && message.text.includes("cek ulang validasinya") && message.text.includes(file), message);
    check("E4 baris operan membawa lampiran", message?.from === "system" && message.attachments?.[0] === file, message);
    const draft = await call("GET", `/api/tasks/${id}/draft`);
    check("E5 draf kotak chat dibersihkan", draft.json?.text === "" && draft.json?.attachments?.length === 0, draft.json);
    const handoffEvent = threads.readAfter(id, 0).find((event) => event.type === "handoff");
    check("E6 event operan tercatat", handoffEvent?.type === "handoff" && handoffEvent.to === "qa", handoffEvent);
    const badFile = await call("POST", `/api/tasks/${id}/handoff`, { role: "engineer", attachments: ["hilang.txt"] });
    check("E7 lampiran oper yang tidak ada ditolak", badFile.status === 400 && getTask(id)?.role === "qa", badFile);

    // Pesan biasa ke QA dengan URL baru: disimpan dan disebut ke bot.
    const moved = await call("POST", `/api/tasks/${id}/message`, { text: "ulangi", targetUrl: "https://staging.toko.test/v2" });
    check("E8 URL baru lewat pesan biasa", moved.status === 200 && getTask(id)?.targetUrl === "https://staging.toko.test/v2" && sent.at(-1)!.text.startsWith("URL yang diuji sekarang: https://staging.toko.test/v2"), sent.at(-1));
  }
} finally {
  server.close();
  await scheduler.closeAll();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nSemua kasus sesuai harapan" : `\n${failed} kasus GAGAL`);
process.exit(failed > 0 ? 1 : 0);
