import { Router } from "express";
import { engineUsable } from "../accounts/index.ts";
import { askHub, askModels } from "../agent/ask.ts";
import { getTask } from "../tasks.ts";

/** Aliran jawaban (delta/answer/busy) ada di WebSocket topik `ask:<id>` — lihat server/realtime.ts. */
export const askRouter = Router();

askRouter.get("/tasks/:id/ask", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ...askHub.state(req.params.id), models: askModels() });
});

askRouter.post("/tasks/:id/ask", async (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text wajib diisi" });
    return;
  }
  // Panel Tanya berjalan di Claude; tanpa akun Claude yang siap, pertanyaan ditolak dengan alasannya.
  const usable = engineUsable("claude");
  if (!usable.ok) {
    res.status(409).json({ error: `Tanya butuh akun Claude: ${usable.reason}` });
    return;
  }
  const models = askModels();
  const requested = typeof req.body?.model === "string" ? req.body.model : "";
  const model = models.some((item) => item.id === requested) ? requested : models[0]!.id;

  if (askHub.state(req.params.id).busy) {
    res.status(409).json({ error: "masih menjawab pertanyaan sebelumnya" });
    return;
  }
  try {
    const message = await askHub.ask(req.params.id, text, model);
    res.json({ message, state: askHub.state(req.params.id) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

askRouter.delete("/tasks/:id/ask", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  askHub.clear(req.params.id);
  res.json({ ok: true });
});
