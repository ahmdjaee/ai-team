import { Router } from "express";
import { handleAuthRequest } from "ai-agent-auth/http";
import { accountView, auth, checkGateway, hasGateway, removeGateway, saveClaudeGateway, setClaudeSource, withEngine } from "../accounts/index.ts";
import { agentUsage } from "../accounts/usage.ts";
import { isProviderId, PROVIDER_IDS } from "../types.ts";

/**
 * Rute akun dari ai-agent-auth: `GET /accounts`, lalu `POST login`, `POST login/code`,
 * `DELETE login` (batal/tutup), `POST check`, `POST logout` di `/accounts/:provider/…`.
 * URL login muncul di `login.url` lewat event `accounts_changed`.
 */
export const accountsRouter = Router();

/**
 * `GET /accounts/usage`: pemakaian langganan tiap agen, dibaca dari agennya (`/usage` Claude Code,
 * `agy -p /usage`). Akun yang belum ditambahkan atau perlu login ulang dilewati.
 * - `?provider=claude` hanya membaca agen itu, jadi kartu Claude tidak menunggu agy yang lambat.
 * - `?force=1` membaca ulang tanpa cache semenit; `?force=claude` hanya agen itu.
 * Harus sebelum rute ai-agent-auth, yang memegang `/accounts/:provider`.
 */
accountsRouter.get("/accounts/usage", async (req, res) => {
  const { provider: only, force } = req.query;
  if (only !== undefined && !isProviderId(only)) {
    res.status(400).json({ error: `penyedia tidak dikenal: ${String(only)}` });
    return;
  }
  const providers = only === undefined ? PROVIDER_IDS : [only];
  const usage = await Promise.all(providers.map((provider) => agentUsage(provider, force === "1" || force === provider)));
  res.json({ usage: usage.filter((item) => item !== undefined) });
});

/**
 * Gateway Claude (base URL + token, seperti `claude-gw`), akun tambahan di samping login claude.ai.
 * Semua membalas `{ account }` view Claude lengkap dengan `gateway` dan `claudeSource`; tokennya tidak
 * pernah ikut dibalas.
 * - `PUT …/gateway` `{ baseUrl, token?, activate? }`: simpan setelah `/v1/models` menjawab. Saat
 *   mengubah, token kosong berarti token lama tetap dipakai.
 * - `POST …/gateway/check`, `DELETE …/gateway`.
 * - `POST /accounts/claude/source` `{ source: "oauth" | "gateway" }`: akun yang dipakai bot Claude.
 * Harus sebelum rute ai-agent-auth, yang memegang `/accounts/:provider/…`.
 */
accountsRouter.put("/accounts/claude/gateway", async (req, res) => {
  const body = (req.body ?? {}) as { baseUrl?: unknown; token?: unknown; activate?: unknown };
  const result = await saveClaudeGateway({ baseUrl: body.baseUrl, token: body.token, activate: body.activate });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ account: accountView("claude") });
});

accountsRouter.post("/accounts/claude/gateway/check", async (_req, res) => {
  if (!hasGateway()) {
    res.status(404).json({ error: "gateway Claude belum ditambahkan" });
    return;
  }
  await checkGateway(true);
  res.json({ account: accountView("claude") });
});

accountsRouter.delete("/accounts/claude/gateway", (_req, res) => {
  removeGateway();
  res.json({ account: accountView("claude") });
});

accountsRouter.post("/accounts/claude/source", (req, res) => {
  const source = (req.body as { source?: unknown } | undefined)?.source;
  if (source !== "oauth" && source !== "gateway") {
    res.status(400).json({ error: "source harus oauth atau gateway" });
    return;
  }
  if (!setClaudeSource(source)) {
    res.status(409).json({ error: "gateway Claude belum ditambahkan" });
    return;
  }
  res.json({ account: accountView("claude") });
});

accountsRouter.use(async (req, res, next) => {
  const result = await handleAuthRequest(auth, { method: req.method, path: req.path, body: req.body }, { view: withEngine });
  if (!result) return next();
  res.status(result.status).json(result.body);
});
