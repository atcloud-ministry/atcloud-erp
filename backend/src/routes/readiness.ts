import { Router, type Request, type Response } from "express";
import { applicationReadinessService } from "../services/operations/ApplicationReadinessService";

const router = Router();

function setProbeHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

router.get("/", async (_req: Request, res: Response) => {
  setProbeHeaders(res);
  try {
    const snapshot = await applicationReadinessService.getSnapshot();
    const status = snapshot.ready ? "ready" : "not_ready";
    res.status(snapshot.ready ? 200 : 503).json({
      success: snapshot.ready,
      status,
      version: 1,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      success: false,
      status: "not_ready",
      version: 1,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get("/live", (_req: Request, res: Response) => {
  setProbeHeaders(res);
  res.status(200).json({
    success: true,
    status: "alive",
    version: 1,
    timestamp: new Date().toISOString(),
  });
});

export default router;
