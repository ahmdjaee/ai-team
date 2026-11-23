/**
 * Gate: kotak "Usul agen" di atas kotak chat harus setinggi SATU BARIS,
 * bisa dibentang saat diklik, tidak pernah merebut layar, dan "Oper" mengisi kotak chat.
 *
 * Jalankan dengan server yang sedang hidup:  bun run gate:suggest
 * (Tidak memanggil agen sama sekali — murni pemeriksaan tampilan.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { CONFIG } from "../../server/config.ts";

const BASE = process.env.GATE_BASE ?? `http://127.0.0.1:${CONFIG.port}`;
/** Tugas dengan usul agen yang panjang (yang bikin keluhan), tugas lain dengan usul, dan tugas tanpa usul. */
const WITH_SUGGESTION = process.env.GATE_TASK ?? "T-015";
const OTHER_SUGGESTION = process.env.GATE_TASK_OTHER ?? "T-032";
const WITHOUT_SUGGESTION = process.env.GATE_TASK_PLAIN ?? "T-033";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  GAGAL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function taskJson(taskId: string): { role: string; assignments: unknown[]; suggestedNext?: { role: string; note: string } } {
  return JSON.parse(readFileSync(join(CONFIG.tasksDir, taskId, "task.json"), "utf8"));
}

const assignmentCount = (taskId: string): number => taskJson(taskId).assignments.length;
const TITLES: Record<string, string> = { qa: "QA Engineer", engineer: "Software Engineer", devops: "DevOps Engineer", uiux: "UI/UX Designer" };
const suggestedTitle = (taskId: string): string => TITLES[taskJson(taskId).suggestedNext?.role ?? ""] ?? "";

function noteOf(taskId: string): string {
  const task = JSON.parse(readFileSync(join(CONFIG.tasksDir, taskId, "task.json"), "utf8")) as {
    suggestedNext?: { note: string };
  };
  if (!task.suggestedNext) throw new Error(`${taskId} tidak punya suggestedNext — gate butuh tugas yang punya usul`);
  return task.suggestedNext.note;
}

const trigger = (page: Page): Locator => page.locator("[data-suggestion] button[aria-expanded]");
/** Kotak oranye tepat di atas kotak chat. */
const box = (page: Page): Locator => page.locator("[data-suggestion]");

async function height(target: Locator): Promise<number> {
  return (await target.boundingBox())?.height ?? -1;
}

async function main(): Promise<void> {
  const note = noteOf(WITH_SUGGESTION);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    console.log(`\n${WITH_SUGGESTION} — usul agen ${note.length} karakter`);
    await page.goto(`${BASE}/tasks/${WITH_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await trigger(page).waitFor({ state: "visible", timeout: 15_000 });

    // 1. Satu baris.
    const collapsed = await height(box(page));
    check("kotak usul setinggi satu baris (< 48px)", collapsed > 0 && collapsed < 48, `${collapsed.toFixed(1)}px`);

    // 2. Teksnya memang terpotong, bukan kebetulan pendek.
    const label = trigger(page).locator("span.truncate");
    const clipped = await label.evaluate((el) => el.scrollWidth - el.clientWidth);
    check("teks usul terpotong dengan elipsis", clipped > 0, `selisih ${clipped}px`);

    // 3. Header tetap ringkas; usulnya sekarang di atas kotak chat.
    const headerHeight = await height(page.locator("header").first());
    check("header tetap ringkas (< 200px)", headerHeight > 0 && headerHeight < 200, `${headerHeight.toFixed(1)}px`);
    const tabBox = await page.getByRole("button", { name: "Kerja", exact: true }).boundingBox();
    check("tab Kerja masih terlihat tanpa scroll", (tabBox?.y ?? 1e9) < 400, `y=${tabBox?.y?.toFixed(0) ?? "?"}`);

    // 4. Diklik → membentang, isinya utuh, tapi tingginya tetap berpagar.
    await trigger(page).click();
    check("aria-expanded jadi true", (await trigger(page).getAttribute("aria-expanded")) === "true");
    const full = box(page).locator("p");
    const shown = ((await full.textContent()) ?? "").trim();
    check("catatan penuh terbaca", shown.startsWith(note.slice(0, 60).trim()), `"${shown.slice(0, 40)}…"`);
    check("catatan penuh sama persis dengan task.json", shown === note.trim());
    const expanded = await height(box(page));
    check("terbentang pun tetap berpagar (≤ 260px)", expanded <= 260, `${expanded.toFixed(1)}px`);
    check("terbentang lebih tinggi dari tertutup", expanded > collapsed, `${collapsed.toFixed(1)} → ${expanded.toFixed(1)}`);

    // 5. Diklik lagi → kembali satu baris.
    await trigger(page).click();
    check("klik kedua menutup lagi", (await height(box(page))) < 48);

    // 6. Jalur keyboard.
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    check("Enter membentang", (await trigger(page).getAttribute("aria-expanded")) === "true");
    await page.keyboard.press("Enter");
    check("Enter menutup", (await trigger(page).getAttribute("aria-expanded")) === "false");

    // 7. "Terapkan di chat" dari baris yang tertutup mengisi kotak chat, tanpa mengoper apa pun.
    const assignmentsBefore = assignmentCount(WITH_SUGGESTION);
    const draftBefore = await page.getByRole("textbox", { name: "Arahan untuk agen" }).inputValue();
    await box(page).getByRole("button", { name: "Terapkan di chat" }).click();
    const role = page.getByRole("combobox", { name: "Bot tujuan" });
    check("bot tujuan pindah ke bot usulan", ((await role.textContent()) ?? "").includes(suggestedTitle(WITH_SUGGESTION)), (await role.textContent()) ?? "");
    const prefilled = await page.getByRole("textbox", { name: "Arahan untuk agen" }).inputValue();
    check("catatan usul masuk ke kotak chat", prefilled.includes(note.trim()), `${prefilled.length} karakter`);
    check("strip oper tampil", (await page.locator("[data-handoff-hint]").count()) === 1);
    check("tombol kirim berubah jadi Oper", (await page.getByRole("button", { name: /^Oper ke / }).count()) === 1);
    check("belum ada yang dioper", assignmentCount(WITH_SUGGESTION) === assignmentsBefore);
    // Kembalikan kotak chat seperti semula supaya draf pemilik tidak berubah karena gate ini.
    await page.getByRole("textbox", { name: "Arahan untuk agen" }).fill(draftBefore);
    await page.waitForTimeout(900);

    // 8. Pindah tugas lalu kembali → tertutup lagi.
    await trigger(page).click();
    await page.goto(`${BASE}/tasks/${OTHER_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await trigger(page).waitFor({ state: "visible", timeout: 15_000 });
    check(`${OTHER_SUGGESTION} juga tertutup saat dibuka`, (await height(box(page))) < 48);
    await page.goto(`${BASE}/tasks/${WITH_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await trigger(page).waitFor({ state: "visible", timeout: 15_000 });
    check("kembali ke tugas semula: tertutup lagi", (await trigger(page).getAttribute("aria-expanded")) === "false");

    // 9. Tugas tanpa usul tidak menumbuhkan kotak apa pun.
    await page.goto(`${BASE}/tasks/${WITHOUT_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Kerja", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    check(`${WITHOUT_SUGGESTION} tanpa usul: tidak ada kotak`, (await trigger(page).count()) === 0);
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} hijau, ${failures.length} merah`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
