import { Router } from "express";
import { getSettings, updateSettings, type SettingsPatch } from "../settings.ts";

export const settingsRouter = Router();

settingsRouter.get("/settings", (_req, res) => {
  res.json(getSettings());
});

settingsRouter.put("/settings", (req, res) => {
  const body = req.body as SettingsPatch | undefined;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "body tidak valid" });
    return;
  }
  res.json(updateSettings(body));
});
