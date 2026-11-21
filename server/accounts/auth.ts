import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentAuth } from "ai-agent-auth";
import { claudeProvider, sdkModels } from "ai-agent-auth/claude";
import { geminiProvider } from "ai-agent-auth/gemini";
import { CONFIG, agentEnv } from "../config.ts";
import { launchAgyProcess } from "../engines/antigravity/process.ts";
import type { ProviderId } from "../types.ts";
import { migrateClaudeOnce } from "./claude.ts";

/**
 * Akun AI milik app (ai-agent-auth). Folder dan format `accounts.json` sama seperti sebelum
 * library: `data/accounts.json`, `data/accounts/claude` (`CLAUDE_CONFIG_DIR`), dan folder agy
 * (`AGY_DIR`, bawaan `data/accounts/gemini`) dengan keyring pribadinya.
 */
export const auth = createAgentAuth<ProviderId>({
  dataDir: CONFIG.dataDir,
  accountsDir: CONFIG.accountsDir,
  runtimeName: "ai-team",
  baseEnv: agentEnv,
  providers: [
    claudeProvider({ dir: CONFIG.claudeDir, bin: "claude", listModels: sdkModels(query) }),
    // Probe dan logout memakai peluncur yang sama dengan sesi bot: hooks.json pagar ditulis dulu.
    geminiProvider({ dir: CONFIG.antigravity.dir, bin: CONFIG.antigravity.bin, launch: launchAgyProcess }),
  ],
  onLogin: (provider) => {
    if (provider === "claude") migrateClaudeOnce(auth.store);
  },
  log: (message) => console.log(message),
});
