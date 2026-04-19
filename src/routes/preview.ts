import { Router, Request, Response } from "express";
import { prisma } from "../db";

const router = Router();

/**
 * GET /api/preview/:id
 * Serve generated HTML from a TaskLog entry as a viewable page.
 * The :id is the TaskLog ID.
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const taskLog = await prisma.taskLog.findUnique({
      where: { id },
      select: { output: true, status: true },
    });

    if (!taskLog || !taskLog.output) {
      res.status(404).send("<!DOCTYPE html><html><body><h1>Not Found</h1></body></html>");
      return;
    }

    // Extract HTML from the output (might be wrapped in markdown code blocks)
    let html = taskLog.output;

    const htmlMatch = html.match(/```html\s*\n([\s\S]*?)\n```/);
    if (htmlMatch) {
      html = htmlMatch[1];
    } else {
      // Try to find a complete HTML document
      const docMatch = html.match(/(<!DOCTYPE html[\s\S]*<\/html>)/i);
      if (docMatch) {
        html = docMatch[1];
      }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(html);
  } catch (err) {
    console.error("[preview] Error:", err);
    res.status(500).send("<!DOCTYPE html><html><body><h1>Server Error</h1></body></html>");
  }
});

export { router as previewRouter };
