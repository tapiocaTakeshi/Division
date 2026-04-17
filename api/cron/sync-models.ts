import "../../src/env";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { syncModels } from "../../src/services/sync-models";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await syncModels();
    return res.json(result);
  } catch (err) {
    console.error("[cron/sync-models] Failed:", err);
    return res.status(500).json({
      error: "Sync failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
