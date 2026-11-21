import { Router } from "express";
import { getSettings, modelDefaults, updateSettings, type SettingsPatch } from "../settings.ts";

export const settingsRouter = Router();

/** `defaults` = nilai `.env` yang berlaku kalau model/penalaran di Pengaturan kosong. */
settingsRouter.get("/settings", (_req, res) => {
  res.json({ ...getSettings(), defaults: modelDefaults() });
});

settingsRouter.put("/settings", (req, res) => {
  const body = req.body as SettingsPatch | undefined;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "body tidak valid" });
    return;
  }
  res.json({ ...updateSettings(body), defaults: modelDefaults() });
});
