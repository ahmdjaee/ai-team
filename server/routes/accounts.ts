import { Router } from "express";
import { handleAuthRequest } from "ai-agent-auth/http";
import { auth, withEngine } from "../accounts/index.ts";

/**
 * Rute akun dari ai-agent-auth: `GET /accounts`, lalu `POST login`, `POST login/code`,
 * `DELETE login` (batal/tutup), `POST check`, `POST logout` di `/accounts/:provider/…`.
 * URL login muncul di `login.url` lewat event `accounts_changed`.
 */
export const accountsRouter = Router();

accountsRouter.use(async (req, res, next) => {
  const result = await handleAuthRequest(auth, { method: req.method, path: req.path, body: req.body }, { view: withEngine });
  if (!result) return next();
  res.status(result.status).json(result.body);
});
