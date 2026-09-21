import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { authenticate, authorizePermission } from "../middleware/auth";
import {
  isRecoveryControlClientError,
  isRecoveryControlCommitUncertain,
  isRecoveryControlConflict,
  recoveryControlService,
} from "../services/operations/RecoveryControlService";
import { CorrelatedLogger } from "../services/CorrelatedLogger";
import { PERMISSIONS } from "../utils/roleUtils";
import { recordRecoveryOperation } from "../services/operations/OperationalMetricsBridge";

const router = Router();

interface RecoveryRequestBody {
  readonly limit?: unknown;
}

function classifyRecoveryFailure(error: unknown): Readonly<{
  name: string;
  code?: string | number;
}> {
  const candidate = error as { name?: unknown; code?: unknown };
  const name =
    typeof candidate?.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(candidate.name)
      ? candidate.name
      : "UnknownError";
  const code = candidate?.code;
  return Object.freeze({
    name,
    ...(typeof code === "number" && Number.isSafeInteger(code)
      ? { code }
      : typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)
        ? { code }
        : {}),
  });
}

function parseRecoveryRequestBody(value: unknown): RecoveryRequestBody | null {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.some((key) => key !== "limit")
  ) {
    return null;
  }
  return Object.freeze({
    ...(Object.prototype.hasOwnProperty.call(value, "limit")
      ? { limit: (value as { limit?: unknown }).limit }
      : {}),
  });
}

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.MANAGE_SYSTEM_SETTINGS));

router.get("/", async (req: Request, res: Response) => {
  try {
    const snapshot = await recoveryControlService.getStatusSnapshot();
    res.status(200).json({ success: true, data: snapshot });
  } catch (error) {
    CorrelatedLogger.fromRequest(req, "RecoveryControls").error(
      "Recovery status read failed",
      new Error("Recovery status unavailable"),
      "RecoveryControlService",
      { failure: classifyRecoveryFailure(error) },
    );
    res.status(503).json({
      success: false,
      message: "Recovery status is temporarily unavailable.",
      code: "RECOVERY_STATUS_UNAVAILABLE",
    });
  }
});

router.post(
  "/notification-outbox/reconcile",
  async (req: Request, res: Response) => {
    const idempotencyKey = req.header("Idempotency-Key");
    const body = parseRecoveryRequestBody(req.body);
    if (!idempotencyKey || !req.userId || !req.user?.role || !body) {
      recordRecoveryOperation("invalid");
      res.status(400).json({
        success: false,
        message: "A valid recovery request is required.",
        code: "RECOVERY_CONTROL_INPUT_INVALID",
      });
      return;
    }

    try {
      const result =
        await recoveryControlService.executeNotificationOutboxReconciliation({
          actor: { id: req.userId, role: req.user.role },
          idempotencyKey,
          limit: body.limit as number | undefined,
          correlationId: req.correlationId,
        });
      recordRecoveryOperation(result.replayed ? "replay" : "success");
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      if (isRecoveryControlClientError(error)) {
        recordRecoveryOperation("invalid");
        res.status(400).json({
          success: false,
          message: "A valid recovery request is required.",
          code: "RECOVERY_CONTROL_INPUT_INVALID",
        });
        return;
      }
      if (isRecoveryControlConflict(error)) {
        recordRecoveryOperation("conflict");
        res.status(409).json({
          success: false,
          message: "The recovery request conflicts with an existing operation.",
          code: "RECOVERY_CONTROL_CONFLICT",
        });
        return;
      }
      if (isRecoveryControlCommitUncertain(error)) {
        CorrelatedLogger.fromRequest(req, "RecoveryControls").warn(
          "Recovery operation outcome uncertain",
          "RecoveryControlService",
          { failure: classifyRecoveryFailure(error) },
        );
        recordRecoveryOperation("uncertain");
        res.status(503).json({
          success: false,
          message:
            "The recovery result is uncertain. Retry with the same Idempotency-Key.",
          code: "RECOVERY_COMMIT_UNCERTAIN",
        });
        return;
      }

      CorrelatedLogger.fromRequest(req, "RecoveryControls").error(
        "Recovery operation failed",
        new Error("Recovery operation unavailable"),
        "RecoveryControlService",
        { failure: classifyRecoveryFailure(error) },
      );
      recordRecoveryOperation("failure");
      res.status(503).json({
        success: false,
        message: "Recovery operation is temporarily unavailable.",
        code: "RECOVERY_OPERATION_UNAVAILABLE",
      });
    }
  },
);

export default router;
