import type { Request, Response } from "express";
import {
  parseInstallationId,
  parseNotificationPreferenceBody,
  parsePushSubscriptionBody,
  PushNotificationValidationError,
} from "../../contracts/pushNotifications";
import {
  PushNotificationError,
} from "../../services/push/PushNotificationErrors";
import {
  pushSubscriptionService,
  type PushSettingsActor,
  type PushSubscriptionService,
} from "../../services/push/PushSubscriptionService";

function actor(req: Request): PushSettingsActor {
  const id = req.userId;
  const role = req.userRole ?? req.user?.role;
  if (!id || !role) {
    throw new PushNotificationValidationError([
      Object.freeze({ path: "actor", msg: "Required request context is missing" }),
    ]);
  }
  return Object.freeze({ id, role });
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PushNotificationValidationError) {
    res.status(400).json({
      success: false,
      message: error.message,
      errors: error.issues,
    });
    return;
  }
  if (error instanceof PushNotificationError) {
    res.status(error.httpStatus).json({
      success: false,
      message: error.message,
      reasonCode: error.code,
    });
    return;
  }
  res.status(500).json({
    success: false,
    message: "Push notification operation failed.",
  });
}

export class PushNotificationController {
  constructor(
    private readonly service: PushSubscriptionService = pushSubscriptionService,
  ) {}

  config = async (_req: Request, res: Response): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: this.service.publicConfig() });
    } catch (error) {
      sendError(res, error);
    }
  };

  list = async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await this.service.list(actor(req).id) });
    } catch (error) {
      sendError(res, error);
    }
  };

  upsert = async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await this.service.upsert({
        actor: actor(req),
        subscription: parsePushSubscriptionBody(req.body),
        correlationId: req.correlationId,
      });
      res.status(201).json({ success: true, data });
    } catch (error) {
      sendError(res, error);
    }
  };

  unsubscribe = async (req: Request, res: Response): Promise<void> => {
    try {
      await this.service.unsubscribe({
        actor: actor(req),
        installationId: parseInstallationId(req.params.installationId),
        correlationId: req.correlationId,
      });
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  };

  getPreferences = async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(200).json({
        success: true,
        data: await this.service.getPreferences(actor(req).id),
      });
    } catch (error) {
      sendError(res, error);
    }
  };

  setPreferences = async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(200).json({
        success: true,
        data: await this.service.setPreferences({
          actor: actor(req),
          changes: parseNotificationPreferenceBody(req.body),
          correlationId: req.correlationId,
        }),
      });
    } catch (error) {
      sendError(res, error);
    }
  };
}

export const pushNotificationController = new PushNotificationController();
