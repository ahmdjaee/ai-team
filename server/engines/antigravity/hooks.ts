import { randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { bearerToken } from "../../mcp-http.ts";

/**
 * Jembatan hook PreToolUse `agy` → runner. agy menjalankan `hook-client.ts` di setiap tool call; klien
 * itu meneruskan payload ke sini dengan token runner (dari env proses agy), lalu menunggu keputusan.
 *
 * Keputusan yang butuh owner bisa menunggu berjam-jam, jadi satu request HTTP hanya ditahan sebentar:
 * kalau belum ada keputusan, jawabannya `{pending: id}` dan klien bertanya lagi ke `/wait`.
 */

export type HookPayload = {
  hookEventName?: string;
  conversationId?: string;
  cwd?: string;
  toolCall?: { id?: string; name?: string; args?: Record<string, unknown> };
};

export type HookAnswer = { decision: "allow" | "deny"; reason?: string };

type Handler = (payload: HookPayload) => Promise<HookAnswer>;
type Waiting = { token: string; promise: Promise<HookAnswer>; answer?: HookAnswer };

const handlers = new Map<string, Handler>();
const waiting = new Map<string, Waiting>();

/** Satu request HTTP ditahan paling lama ini sebelum klien diminta bertanya lagi. */
const HOLD_MS = 8_000;

export const HOOK_PATH = "/api/internal/agy-hook";

export function registerHookHandler(handler: Handler): { token: string; revoke: () => void } {
  const token = randomBytes(32).toString("hex");
  handlers.set(token, handler);
  return {
    token,
    revoke: () => {
      handlers.delete(token);
      for (const [id, entry] of waiting) if (entry.token === token) waiting.delete(id);
    },
  };
}

/** Ambil keputusan sampai `holdMs`; undefined = belum ada, tanya lagi. */
async function settle(id: string, entry: Waiting, holdMs: number): Promise<HookAnswer | undefined> {
  if (entry.answer) {
    waiting.delete(id);
    return entry.answer;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), holdMs);
  });
  const answer = await Promise.race([entry.promise, timeout]);
  clearTimeout(timer);
  if (answer) waiting.delete(id);
  return answer;
}

export async function startHook(
  token: string,
  payload: HookPayload,
  holdMs = HOLD_MS,
): Promise<HookAnswer | { pending: string } | undefined> {
  const handler = handlers.get(token);
  if (!handler) return undefined;
  const id = randomUUID();
  const entry: Waiting = {
    token,
    promise: handler(payload).catch(
      (error: unknown): HookAnswer => ({ decision: "deny", reason: `pagar AI Team gagal menilai tool: ${(error as Error).message}` }),
    ),
  };
  void entry.promise.then((answer) => {
    entry.answer = answer;
  });
  waiting.set(id, entry);
  const answer = await settle(id, entry, holdMs);
  return answer ?? { pending: id };
}

export async function waitHook(
  token: string,
  id: string,
  holdMs = HOLD_MS,
): Promise<HookAnswer | { pending: string } | undefined> {
  const entry = waiting.get(id);
  // Runner sudah ditutup atau id tidak dikenal: tolak, jangan biarkan tool lolos.
  if (!entry || entry.token !== token || !handlers.has(token)) return undefined;
  const answer = await settle(id, entry, holdMs);
  return answer ?? { pending: id };
}

export const agyHookRouter = Router();

agyHookRouter.post(["/internal/agy-hook", "/internal/agy-hook/wait"], async (req, res) => {
  if (req.headers.origin !== undefined) {
    res.status(403).json({ decision: "deny", reason: "hook tidak menerima permintaan dari browser" });
    return;
  }
  const token = bearerToken(req);
  if (!token || !handlers.has(token)) {
    res.status(401).json({ decision: "deny", reason: "sesi agy ini tidak dikenal AI Team (sudah ditutup?)" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const answer = req.path.endsWith("/wait")
    ? await waitHook(token, typeof body.id === "string" ? body.id : "")
    : await startHook(token, body as HookPayload);
  res.json(answer ?? { decision: "deny", reason: "keputusan hook tidak ditemukan — tool ditolak" });
});
