import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { CONFIG, agentEnv } from "../config.ts";
import { findAgy } from "../engines/antigravity/availability.ts";
import { spawnAgy } from "../engines/antigravity/process.ts";
import { geminiKeyringEnv, keyringMissing, wipeGeminiKeyring } from "./keyring.ts";
import type { LoginSpec } from "./login.ts";

/** Host yang boleh muncul sebagai URL login Google dari `agy acp --login`. */
export const GEMINI_LOGIN_HOSTS = ["accounts.google.com"];

/** Env untuk setiap proses `agy` milik app: keyring pribadi, bukan keyring desktop pemilik. */
export async function geminiEnv(): Promise<Record<string, string | undefined>> {
  return { ...agentEnv(), ...(await geminiKeyringEnv()) };
}

/** Alasan akun Gemini tidak bisa dipakai di mesin ini, atau undefined kalau programnya lengkap. */
export function geminiMissing(): string | undefined {
  if (!findAgy()) return `perintah \`${CONFIG.antigravity.bin}\` tidak ditemukan — pasang Antigravity CLI dulu`;
  return keyringMissing();
}

/**
 * `agy acp --login`: mencetak URL login Google lalu menunggu kode (atau URL halaman akhir) di
 * stdin, tanpa terminal (spike 20 Nov 2026). Token disimpan ke keyring pribadi app.
 */
export async function geminiLoginSpec(): Promise<LoginSpec> {
  mkdirSync(CONFIG.antigravity.dir, { recursive: true, mode: 0o700 });
  return {
    command: findAgy() ?? CONFIG.antigravity.bin,
    args: ["acp", "--login", "--gemini-dir", CONFIG.antigravity.dir, "--disable-telemetry"],
    env: { ...(await geminiEnv()), BROWSER: "/bin/true", DISPLAY: undefined, WAYLAND_DISPLAY: undefined } as NodeJS.ProcessEnv,
    cwd: CONFIG.antigravity.dir,
    urlHosts: GEMINI_LOGIN_HOSTS,
  };
}

/** Email akun dari output login, kalau agy menyebutkannya. */
export function emailFromOutput(output: string): string | undefined {
  return /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(output)?.[0];
}

/**
 * Keluar: minta agy mencabut sesinya (ACP `logout`), lalu buang keyring pribadi seluruhnya.
 * Keyring desktop dan `agy` di terminal tidak tersentuh.
 */
export async function geminiLogout(): Promise<void> {
  if (findAgy()) {
    const cwd = join(CONFIG.antigravity.dir, "probe");
    mkdirSync(cwd, { recursive: true });
    const app = acp
      .client({ name: "ai-team-logout" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" as const } }))
      .onNotification(acp.methods.client.session.update, () => undefined);
    try {
      const proc = spawnAgy({ cwd, env: await geminiEnv(), app });
      try {
        const agent = proc.connection.agent;
        await Promise.race([
          (async () => {
            await agent.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
              clientInfo: { name: "ai-team", version: "0.1.0" },
            });
            await agent.request(acp.methods.agent.logout, {});
          })(),
          new Promise((resolve) => setTimeout(resolve, 15_000)),
        ]);
      } catch {
        // logout jarak jauh opsional; keyring tetap dibuang di bawah
      } finally {
        await proc.kill();
      }
    } catch {
      // keyring pribadi tidak bisa dimulai: tetap dibuang
    }
  }
  await wipeGeminiKeyring();
}
