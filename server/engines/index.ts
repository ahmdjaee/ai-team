import { Router } from "express";
import { accountViews, checkAccount, engineUsable } from "../accounts/index.ts";
import { scheduler } from "../agent/scheduler.ts";
import { PROVIDER_IDS, type EngineId } from "../types.ts";
import { AcpTaskRunner } from "./antigravity/runner.ts";

export { engineUsable } from "../accounts/index.ts";

/**
 * Mesin agen di luar Claude didaftarkan di sini, supaya scheduler tidak perlu mengimpor kodenya.
 * Dipanggil sekali dari main.ts.
 */
export function registerEngines(): void {
  scheduler.registerEngine(
    "antigravity",
    ({ taskId, role, hooks, sessionId, mode, model }) => new AcpTaskRunner(taskId, role, hooks, sessionId, mode, model),
  );
}

export const ENGINE_LABEL: Record<EngineId, string> = { claude: "Claude", antigravity: "Gemini (Antigravity)" };

export const enginesRouter = Router();

/** Mesin mengikuti akun di app: tersedia hanya kalau akun penyedianya siap. */
enginesRouter.get("/engines", async (req, res) => {
  if (req.query.refresh === "1") await Promise.all(PROVIDER_IDS.map((provider) => checkAccount(provider, true)));
  res.json({
    engines: accountViews().map((account) => {
      const usable = engineUsable(account.engine);
      return {
        id: account.engine,
        label: ENGINE_LABEL[account.engine],
        available: usable.ok,
        reason: usable.reason,
        models: account.models,
        defaultModel: account.defaultModel,
        checkedAt: account.checkedAt,
      };
    }),
  });
});
