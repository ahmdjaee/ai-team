/**
 * Membangun aplikasi desktop (jendela tipis di `src-tauri/`) di dalam Docker, supaya Rust dan pustaka dev
 * Tauri tidak perlu dipasang di mesin ini. Hanya proses build yang berjalan di kontainer; aplikasinya
 * dijalankan langsung di desktop dan membuka layanan AI Team yang sudah berjalan (bawaan port 4320).
 *
 *   bun run desktop:docker:check   cargo check + clippy
 *   bun run desktop:docker:dev     build debug, lalu buka jendelanya di sini (AI_TEAM_URL ikut diteruskan)
 *   bun run desktop:docker:build   paket .deb di src-tauri/target/release/bundle/deb/
 *   bun scripts/desktop-docker.ts debug   build debug saja (src-tauri/target/debug/ai-team)
 *   bun scripts/desktop-docker.ts shell   bash di dalam lingkungan build
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "ai-team-desktop-build";
const TAURI = "bun node_modules/@tauri-apps/cli/tauri.js";

const COMMANDS: Record<string, string> = {
  check: "cd src-tauri && cargo check && cargo clippy -- -D warnings",
  debug: `${TAURI} build --debug --no-bundle`,
  build: `${TAURI} build`,
  shell: "bash",
};

const mode = process.argv[2] ?? "";
const command = COMMANDS[mode === "dev" ? "debug" : mode];
if (!command) {
  console.error("pakai: bun scripts/desktop-docker.ts <check|dev|debug|build|shell>");
  process.exit(2);
}
if (!existsSync(join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"))) {
  console.error("CLI Tauri belum terpasang: jalankan `bun install` dulu.");
  process.exit(1);
}

function fail(label: string, status: number | null): never {
  console.error(`\nGAGAL: ${label} (keluar ${status ?? "karena sinyal"})`);
  process.exit(status && status > 0 ? status : 1);
}

// Image dibangun ulang hanya kalau Dockerfile berubah. Label dipakai, bukan cache layer Docker,
// karena cache itu bisa terpangkas kapan saja dan membangun ulang butuh beberapa menit.
const dockerfile = readFileSync(join(root, "src-tauri", "Dockerfile"));
const fingerprint = createHash("sha256").update(dockerfile).digest("hex").slice(0, 16);
const LABEL = "ai-team.dockerfile";
const existing = spawnSync("docker", ["image", "inspect", "--format", `{{ index .Config.Labels "${LABEL}" }}`, IMAGE], {
  encoding: "utf8",
});
if (existing.error) {
  console.error(`Docker tidak bisa dijalankan: ${existing.error.message}`);
  process.exit(1);
}
if (existing.status === 0 && existing.stdout.trim() === fingerprint) {
  console.log(`▸ image ${IMAGE} sudah ada`);
} else {
  console.log(`▸ membangun image ${IMAGE} (sekali per perubahan Dockerfile, beberapa menit)`);
  // Konteks build hanya Dockerfile (lewat stdin): isi repo tidak perlu dikirim ke daemon.
  const image = spawnSync("docker", ["build", "--tag", IMAGE, "--label", `${LABEL}=${fingerprint}`, "-"], {
    input: dockerfile,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (image.status !== 0) fail("membangun image", image.status);
}

// HOME kontainer ada di dalam target/ (di-gitignore): cache cargo bertahan antar-build dan dimiliki
// pengguna ini, bukan root.
const home = join(root, "src-tauri", "target", "docker-home");
mkdirSync(home, { recursive: true });

const interactive = mode === "shell" && process.stdin.isTTY;
console.log(`\n▸ ${command}`);
const run = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    ...(interactive ? ["--interactive", "--tty"] : []),
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    // Path yang sama dengan host: build debug menanam lokasi repo ke dalam biner.
    "--volume",
    `${root}:${root}`,
    "--workdir",
    root,
    "--env",
    `HOME=${home}`,
    "--env",
    `CARGO_HOME=${join(home, ".cargo")}`,
    "--env",
    "CARGO_TERM_COLOR=always",
    IMAGE,
    "bash",
    "-c",
    command,
  ],
  { stdio: "inherit" },
);
if (run.status !== 0) fail(command, run.status);

if (mode === "dev") {
  const binary = join(root, "src-tauri", "target", "debug", "ai-team");
  if (!existsSync(binary)) {
    console.error(`\nGAGAL: biner tidak ditemukan di ${binary}`);
    process.exit(1);
  }
  console.log(`\n▸ menjalankan ${binary}\n  (membuka ${process.env.AI_TEAM_URL || "http://127.0.0.1:4320"}; keluar lewat menu tray)`);
  const app = spawnSync(binary, [], { stdio: "inherit", cwd: root });
  process.exit(app.status ?? 0);
}
