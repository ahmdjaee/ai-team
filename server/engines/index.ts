import { Router } from "express";
import { scheduler } from "../agent/scheduler.ts";
import type { EngineId } from "../types.ts";
import { antigravityInfo, antigravityUsable } from "./antigravity/availability.ts";
import { AcpTaskRunner } from "./antigravity/runner.ts";

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

/** Mesin yang dipilih untuk penugasan baru bisa dipakai? Untuk validasi route. */
export function engineUsable(engine: EngineId): { ok: boolean; reason?: string } {
  if (engine === "claude") return { ok: true };
  return antigravityUsable();
}

export const enginesRouter = Router();

enginesRouter.get("/engines", async (req, res) => {
  const antigravity = await antigravityInfo(req.query.refresh === "1");
  res.json({
    engines: [
      { id: "claude", label: ENGINE_LABEL.claude, available: true },
      {
        id: "antigravity",
        label: ENGINE_LABEL.antigravity,
        available: antigravity.available,
        reason: antigravity.reason,
        version: antigravity.version,
        models: antigravity.models ?? [],
        defaultModel: antigravity.defaultModel,
        checkedAt: antigravity.checkedAt,
      },
    ],
  });
});
