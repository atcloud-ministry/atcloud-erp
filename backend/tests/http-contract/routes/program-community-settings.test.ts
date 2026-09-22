import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const middlewareMocks = vi.hoisted(() => ({
  readable: vi.fn(),
  writable: vi.fn(),
  authorizationOptions: [] as unknown[],
  authorizeHandler: vi.fn(),
  membershipSync: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    if (!req.get("Authorization")) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }
    req.userId = "507f1f77bcf86cd799439011";
    req.userRole = "Administrator";
    req.correlationId = req.get("x-correlation-id") ?? undefined;
    next();
  },
  authenticateOptional: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock("../../../src/middleware/alumniNetworkFeatureGate", () => ({
  requireAlumniNetworkReadable: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    middlewareMocks.readable();
    if (req.get("x-feature-off") === "true") {
      res.status(503).json({
        success: false,
        code: "ALUMNI_NETWORK_READ_UNAVAILABLE",
      });
      return;
    }
    next();
  },
  requireAlumniNetworkWritable: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    middlewareMocks.writable();
    if (req.get("x-feature-off") === "true") {
      res.status(503).json({
        success: false,
        code: "ALUMNI_NETWORK_WRITE_UNAVAILABLE",
      });
      return;
    }
    next();
  },
}));

vi.mock("../../../src/middleware/authorization", () => ({
  authorizeHttp: (options: unknown) => {
    middlewareMocks.authorizationOptions.push(options);
    return (req: Request, res: Response, next: NextFunction) => {
      middlewareMocks.authorizeHandler(req.params.id);
      if (req.get("Authorization") === "Bearer denied") {
        res.status(404).json({
          success: false,
          message: "Resource not found.",
          reasonCode: "resource_not_found",
        });
        return;
      }
      next();
    };
  },
}));

vi.mock(
  "../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      communitySettingsChanged: (...args: unknown[]) =>
        middlewareMocks.membershipSync(...args),
    },
  }),
);

import programRoutes from "../../../src/routes/programs";
import {
  ProgramCommunitySettingsError,
  programCommunitySettingsService,
} from "../../../src/services/programs/ProgramCommunitySettingsService";
import { AUTHORIZATION_ACTIONS } from "../../../src/services/authorization/types";

const PROGRAM_ID = "507f191e810c19729de860ea";
const ROOM_ID = "507f191e810c19729de860eb";
const SETTINGS_ID = "507f191e810c19729de860ec";
const IDEMPOTENCY_KEY = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

const SETTINGS = Object.freeze({
  id: SETTINGS_ID,
  programId: PROGRAM_ID,
  primaryConversationId: ROOM_ID,
  enabled: true,
  opensAt: "2026-09-12T15:00:00.000Z",
  closesAt: "2027-01-01T00:00:00.000Z",
  archivedAt: null,
  studentRoleMappings: [
    { studentRoleId: "participant", memberRole: "mentee" as const },
    {
      studentRoleId: "class-rep",
      memberRole: "class_representative" as const,
    },
  ],
  revision: 1,
  createdAt: "2026-09-12T16:00:00.000Z",
  updatedAt: "2026-09-12T16:00:00.000Z",
});

function updateBody() {
  return {
    enabled: true,
    opensAt: "2026-09-12T15:00:00.000Z",
    closesAt: "2027-01-01T00:00:00.000Z",
    studentRoleMappings: SETTINGS.studentRoleMappings,
    expectedRevision: 0,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/programs", programRoutes);
  return app;
}

function authorized(builder: request.Test): request.Test {
  return builder
    .set("Authorization", "Bearer admin")
    .set("x-correlation-id", "m6-http");
}

describe("Program community settings HTTP contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    middlewareMocks.readable.mockClear();
    middlewareMocks.writable.mockClear();
    middlewareMocks.authorizeHandler.mockClear();
    middlewareMocks.membershipSync.mockClear();
  });

  it("requires authentication, the feature capability, and concealed Program management", async () => {
    vi.spyOn(programCommunitySettingsService, "get").mockResolvedValue(SETTINGS);
    const app = buildApp();

    await request(app)
      .get(`/api/programs/${PROGRAM_ID}/community-settings`)
      .expect(401);
    await authorized(
      request(app).get(`/api/programs/${PROGRAM_ID}/community-settings`),
    )
      .set("x-feature-off", "true")
      .expect(503);
    await request(app)
      .get(`/api/programs/${PROGRAM_ID}/community-settings`)
      .set("Authorization", "Bearer denied")
      .expect(404);

    expect(middlewareMocks.readable).toHaveBeenCalledTimes(2);
    expect(middlewareMocks.authorizationOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
        action: AUTHORIZATION_ACTIONS.PROGRAM_MANAGE,
        concealDeniedResource: true,
        }),
      ]),
    );
  });

  it("conceals malformed Program IDs before authorization or database access", async () => {
    const get = vi.spyOn(programCommunitySettingsService, "get");
    const response = await authorized(
      request(buildApp()).get("/api/programs/not-an-object-id/community-settings"),
    ).expect(404);

    expect(response.body).toEqual({
      success: false,
      message: "Resource not found.",
      reasonCode: "resource_not_found",
    });
    expect(middlewareMocks.authorizeHandler).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the exact no-store management DTO", async () => {
    const get = vi
      .spyOn(programCommunitySettingsService, "get")
      .mockResolvedValue(SETTINGS);
    const response = await authorized(
      request(buildApp()).get(`/api/programs/${PROGRAM_ID}/community-settings`),
    ).expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: { settings: SETTINGS },
    });
    expect(get).toHaveBeenCalledWith(PROGRAM_ID);
  });

  it("updates with parsed UTC dates, CAS revision, request context, and targeted sync", async () => {
    const update = vi
      .spyOn(programCommunitySettingsService, "update")
      .mockResolvedValue({ replayed: false, settings: SETTINGS });
    const response = await authorized(
      request(buildApp())
        .put(`/api/programs/${PROGRAM_ID}/community-settings`)
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send(updateBody()),
    ).expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: { settings: SETTINGS },
    });
    expect(update).toHaveBeenCalledWith({
      ...updateBody(),
      opensAt: new Date(updateBody().opensAt),
      closesAt: new Date(updateBody().closesAt),
      programId: PROGRAM_ID,
      actor: {
        id: "507f1f77bcf86cd799439011",
        role: "Administrator",
      },
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "m6-http",
    });
    expect(middlewareMocks.membershipSync).toHaveBeenCalledWith(PROGRAM_ID, {
      actor: {
        type: "user",
        id: "507f1f77bcf86cd799439011",
        role: "Administrator",
      },
      source: "http",
      correlationId: "m6-http",
    });
  });

  it("rejects lifecycle fields, invalid date invariants, and a missing idempotency key", async () => {
    const update = vi.spyOn(programCommunitySettingsService, "update");
    const app = buildApp();

    await authorized(
      request(app)
        .put(`/api/programs/${PROGRAM_ID}/community-settings`)
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send({ ...updateBody(), archivedAt: null }),
    ).expect(400);
    await authorized(
      request(app)
        .put(`/api/programs/${PROGRAM_ID}/community-settings`)
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send({
          ...updateBody(),
          enabled: false,
          opensAt: null,
        }),
    ).expect(400);
    await authorized(
      request(app)
        .put(`/api/programs/${PROGRAM_ID}/community-settings`)
        .send(updateBody()),
    ).expect(400);

    expect(update).not.toHaveBeenCalled();
    expect(middlewareMocks.membershipSync).not.toHaveBeenCalled();
  });

  it("maps stale revisions without exposing internal errors", async () => {
    vi.spyOn(programCommunitySettingsService, "update").mockRejectedValue(
      new ProgramCommunitySettingsError(
        "PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT",
        409,
      ),
    );
    const response = await authorized(
      request(buildApp())
        .put(`/api/programs/${PROGRAM_ID}/community-settings`)
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send(updateBody()),
    ).expect(409);

    expect(response.body).toEqual({
      success: false,
      message:
        "The Program community settings changed. Refresh them and try again.",
      code: "PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT",
    });
    expect(middlewareMocks.membershipSync).not.toHaveBeenCalled();
  });
});
