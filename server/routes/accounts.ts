import { Router, type Response } from "express";
import {
  accountView,
  accountViews,
  checkAccount,
  dismissLogin,
  logoutAccount,
  startLogin,
  submitLoginCode,
} from "../accounts/index.ts";
import { isProviderId, type ProviderId } from "../types.ts";

export const accountsRouter = Router();

function provider(raw: string, res: Response): ProviderId | undefined {
  if (isProviderId(raw)) return raw;
  res.status(404).json({ error: "penyedia akun tidak dikenal" });
  return undefined;
}

accountsRouter.get("/accounts", (_req, res) => {
  res.json({ accounts: accountViews() });
});

/** Mulai login; URL login muncul di `login.url` lewat event `accounts_changed`. */
accountsRouter.post("/accounts/:provider/login", async (req, res) => {
  const id = provider(req.params.provider, res);
  if (!id) return;
  try {
    await startLogin(id);
    res.json({ account: accountView(id) });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  }
});

accountsRouter.post("/accounts/:provider/login/code", (req, res) => {
  const id = provider(req.params.provider, res);
  if (!id) return;
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  try {
    submitLoginCode(id, code);
    res.json({ account: accountView(id) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/** Batalkan login yang berjalan, atau tutup hasil login yang sudah selesai. */
accountsRouter.delete("/accounts/:provider/login", (req, res) => {
  const id = provider(req.params.provider, res);
  if (!id) return;
  dismissLogin(id);
  res.json({ account: accountView(id) });
});

accountsRouter.post("/accounts/:provider/check", async (req, res) => {
  const id = provider(req.params.provider, res);
  if (!id) return;
  await checkAccount(id, true);
  res.json({ account: accountView(id) });
});

accountsRouter.post("/accounts/:provider/logout", async (req, res) => {
  const id = provider(req.params.provider, res);
  if (!id) return;
  try {
    await logoutAccount(id);
    res.json({ account: accountView(id) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
