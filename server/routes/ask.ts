import { Router } from "express";
import { askDefaults, askHub, resolveAskChoice } from "../agent/ask.ts";
import { getTask } from "../tasks.ts";

/** Aliran jawaban (delta/answer/busy) ada di WebSocket topik `ask:<id>` — lihat server/realtime.ts. */
export const askRouter = Router();

askRouter.get("/tasks/:id/ask", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ...askHub.state(req.params.id), defaults: askDefaults() });
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
  // Mesin dan model dipilih di panel; kosong = bawaan Pengaturan → Bot (baris Panel Tanya).
  const resolved = resolveAskChoice({ engine: req.body?.engine, model: req.body?.model });
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  if (askHub.state(req.params.id).busy) {
    res.status(409).json({ error: "masih menjawab pertanyaan sebelumnya" });
    return;
  }
  try {
    const message = await askHub.ask(req.params.id, text, resolved.choice);
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
