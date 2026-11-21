import { Router } from "express";
import { accountViews, checkAccount } from "../accounts/index.ts";
import { scheduler } from "../agent/scheduler.ts";
import { PROVIDER_IDS } from "../types.ts";

export const healthRouter = Router();

/**
 * Ringkasan akun AI milik app untuk pemeriksaan cepat dari terminal. Status 200 kalau ada minimal
 * satu akun siap; `?fresh=1` memeriksa ulang semua akun. Detail lengkap ada di `GET /api/accounts`.
 */
healthRouter.get("/health/auth", async (req, res) => {
  if (req.query.fresh === "1") await Promise.all(PROVIDER_IDS.map((provider) => checkAccount(provider, true)));
  const accounts = accountViews().map(({ provider, state, email, plan, reason, checkedAt }) => ({ provider, state, email, plan, reason, checkedAt }));
  const ready = accounts.some((account) => account.state === "ok");
  res.status(ready ? 200 : 503).json({ ready, accounts, slots: scheduler.stats() });
});
