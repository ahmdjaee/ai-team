/** Uji pembacaan pemakaian agen (Pengaturan → Akun AI). Deterministik, tanpa model/jaringan: bun run check:usage */
import { mapClaudeUsage, parseAgyUsage, runInGroup, usageQueryOptions, withDeadline } from "../server/accounts/usage.ts";
import { ARTIFACT_TOOLS, DENY_ALWAYS } from "../server/roles.ts";
import { resetPhrase, usageTone } from "../web/components/AccountUsage.tsx";

let failed = 0;
function expect(name: string, actual: unknown, wanted: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${ok ? "" : ` — dapat ${JSON.stringify(actual)}, harusnya ${JSON.stringify(wanted)}`}`);
}

// ---------- agy -p /usage (contoh keluaran nyata) ----------
const AGY = [
  "Gemini Models\tWeekly Limit Remaining\t88%\t2026-11-29T06:54:26Z",
  "Gemini Models\tFive Hour Limit Remaining\t73%\t2026-11-23T08:59:51Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-30T06:23:33Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-23T11:23:33Z",
  "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-30T06:23:33Z",
  "",
].join("\n");
const agy = parseAgyUsage(AGY);
expect("agy: lima jendela, urutan dipertahankan", agy.length, 5);
expect("agy: sisa 88% → terpakai 12%", agy[0]?.usedPercent, 12);
expect("agy: sisa 73% → terpakai 27%", agy[1]?.usedPercent, 27);
expect("agy: label dari jenis jendela", agy.map((window) => window.label), ["Mingguan", "Sesi 5 jam", "Mingguan", "Sesi 5 jam", "Mingguan"]);
expect("agy: grup dari agen apa adanya", agy[2]?.group, "Claude and GPT models");
expect("agy: waktu reset", agy[1]?.resetsAt, "2026-11-23T08:59:51Z");
expect("agy: jendela tanpa kata Remaining tetap dibaca sebagai sisa", agy[4]?.usedPercent, 0);
expect("agy: keluaran bukan tabel → kosong", parseAgyUsage("Not logged in\n"), []);
const edge = parseAgyUsage("Gemini Models\tWeekly Limit Remaining\t0.4%\t\nGemini Models\tFive Hour Limit Remaining\t0%\t\n");
expect("agy: sisa 0,4% → 99% terpakai, bukan habis", edge[0]?.usedPercent, 99);
expect("agy: sisa 0% → 100% terpakai", edge[1]?.usedPercent, 100);

// ---------- /usage Claude Code ----------
const CLAUDE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 68, resets_at: "2026-11-24T15:00:00Z" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 68, resets_at: "2026-11-24T15:00:00Z", severity: "normal", is_active: true, scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 5,
        resets_at: "2026-11-24T15:00:00Z",
        severity: "normal",
        is_active: false,
        scope: { model: { display_name: "Fable", id: null }, surface: null },
      },
    ],
    model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: "2026-11-24T15:00:00Z" }],
  },
};
const claude = mapClaudeUsage(CLAUDE);
expect(
  "claude: hanya jendela dari limits[] (tanpa 5 jam/Opus/Sonnet yang null)",
  claude.windows.map((window) => [window.label, window.usedPercent]),
  [
    ["Mingguan · semua model", 68],
    ["Mingguan · Fable", 5],
  ],
);
expect("claude: severity agen ikut", claude.windows[0]?.severity, "normal");

const { limits: _limits, ...withoutLimits } = CLAUDE.rate_limits;
expect(
  "claude: tanpa limits[] → jendela bernama yang bukan null + model_scoped",
  mapClaudeUsage({ ...CLAUDE, rate_limits: withoutLimits }).windows.map((window) => [window.label, window.usedPercent]),
  [
    ["Mingguan · semua model", 68],
    ["Mingguan · Fable", 5],
  ],
);
expect(
  "claude: limits[] kosong → jendela bernama",
  mapClaudeUsage({ rate_limits_available: true, rate_limits: { limits: [], five_hour: { utilization: 42 }, seven_day: { utilization: 68 } } }).windows.map(
    (window) => [window.label, window.usedPercent],
  ),
  [
    ["Sesi 5 jam", 42],
    ["Mingguan · semua model", 68],
  ],
);
expect("claude: 99,6% tidak dibulatkan jadi habis", mapClaudeUsage({ rate_limits: { limits: [{ kind: "weekly_all", percent: 99.6 }] } }).windows[0]?.usedPercent, 99);
expect("claude: login tanpa kuota langganan → keterangan, bukan galat", Boolean(mapClaudeUsage({ rate_limits_available: false, rate_limits: null }).note), true);

// ---------- sesi Claude pembaca /usage: aturan Artifact (CLAUDE.md) ----------
const options = usageQueryOptions(new AbortController());
expect("sesi /usage: Artifact disembunyikan", ARTIFACT_TOOLS.every((tool) => options.disallowedTools?.includes(tool)), true);
const deny = (options.settings as { permissions?: { deny?: string[] } } | undefined)?.permissions?.deny ?? [];
expect("sesi /usage: DENY_ALWAYS ditolak", DENY_ALWAYS.every((rule) => deny.includes(rule)), true);
expect("sesi /usage: tanpa tool", options.tools, []);
expect("sesi /usage: tidak menyimpan sesi", options.persistSession, false);

// ---------- warna & waktu reset di UI ----------
expect("warna: 69% normal", usageTone({ usedPercent: 69 }), 0);
expect("warna: 70% kuning", usageTone({ usedPercent: 70 }), 1);
expect("warna: 90% merah", usageTone({ usedPercent: 90 }), 2);
expect("warna: severity agen menang", usageTone({ usedPercent: 10, severity: "warning" }), 1);
expect("warna: severity normal tidak menurunkan ambang", usageTone({ usedPercent: 95, severity: "normal" }), 2);
expect("warna: severity tak dikenal tidak membuat merah", usageTone({ usedPercent: 10, severity: "info" }), 0);
expect("warna: severity critical merah", usageTone({ usedPercent: 10, severity: "critical" }), 2);

const now = new Date(2026, 10, 23, 13, 0);
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
expect("reset hari ini", resetPhrase(at(23, 15), now), "pukul 15.00");
expect("reset besok", resetPhrase(at(24, 22), now), "besok, 22.00");
expect("reset lebih jauh", resetPhrase(at(30, 13), now), "Sen, 30 Nov");
expect("reset yang sudah lewat hari ini tidak ditampilkan", resetPhrase(at(23, 9), now), undefined);
expect("reset kemarin tidak ditampilkan", resetPhrase(at(22, 22), now), undefined);

// ---------- process group & batas waktu (agy -p /usage tidak boleh menggantung) ----------
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

let started = Date.now();
const leftover = await runInGroup("sh", ["-c", "sleep 30 & echo $!"], { timeoutMs: 10_000 });
expect(
  "group: proses anak yang memegang stdout tidak membuat hasil menggantung",
  [leftover.timedOut, Date.now() - started < 3_000],
  [false, true],
);
const sleeper = Number(leftover.stdout.trim());
expect("group: proses anak yang tertinggal ikut dihentikan", Number.isInteger(sleeper) && sleeper > 0 && (await until(() => !pidAlive(sleeper), 2_000)), true);

started = Date.now();
const stubborn = await runInGroup("sh", ["-c", "trap '' TERM; sleep 30"], { timeoutMs: 200 });
expect("group: timeout mematikan group yang mengabaikan SIGTERM", [stubborn.timedOut, Date.now() - started < 5_000], [true, true]);

const missing = await runInGroup("/nonexistent/agy", ["-p", "/usage"], { timeoutMs: 1_000 });
expect("group: program tidak ada → selesai dengan galat, tidak melempar", [missing.code, missing.timedOut, missing.stderr.length > 0], [null, false, true]);

const never = new Promise<never>(() => {});
expect("deadline: promise yang tidak pernah selesai ditolak", await withDeadline(never, 50, "habis waktu").then(() => "selesai", (error: Error) => error.message), "habis waktu");
expect("deadline: hasil cepat diteruskan", await withDeadline(Promise.resolve(7), 1_000, "habis waktu"), 7);

if (failed) {
  console.error(`\n${failed} uji gagal`);
  process.exit(1);
}
console.log("\nsemua uji lolos");
