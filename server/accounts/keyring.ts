import { createPrivateKeyring } from "ai-agent-auth/gemini";
import { CONFIG } from "../config.ts";

/**
 * Keyring pribadi akun Gemini app (D-Bus + gnome-keyring-daemon sendiri), dari ai-agent-auth.
 * Folder runtime tetap `<XDG_RUNTIME_DIR>/ai-team-<hash>`.
 */
const keyring = createPrivateKeyring({ dir: CONFIG.antigravity.dir, runtimeName: "ai-team" });

export const keyringMissing = (): string | undefined => keyring.missing();
export const geminiKeyringEnv = (): Promise<Record<string, string>> => keyring.env();
export const stopGeminiKeyring = (): Promise<void> => keyring.stop();
export const wipeGeminiKeyring = (): Promise<void> => keyring.wipe();
