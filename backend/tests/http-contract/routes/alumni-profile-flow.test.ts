import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gateMocks = vi.hoisted(() => ({
  readable: vi.fn(),
  writable: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    if (!req.get("Authorization")) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }
    req.userId = "507f1f77bcf86cd799439011";
    req.userRole = "Participant";
    req.correlationId = req.get("x-correlation-id") ?? undefined;
    next();
  },
  authorizePermission:
    (_permission: string) =>
    (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

vi.mock("../../../src/middleware/alumniNetworkFeatureGate", () => ({
  requireAlumniNetworkReadable: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    gateMocks.readable();
    next();
  },
  requireAlumniNetworkWritable: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    gateMocks.writable();
    next();
  },
}));

import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../../src/config/alumniProfilePublicationConsent";
import directoryRoutes from "../../../src/routes/directory";
import {
  AlumniProfileNotPublishableError,
} from "../../../src/services/alumni/AlumniFlowErrors";
import { alumniProfileService } from "../../../src/services/alumni/AlumniProfileService";

const USER_ID = "507f1f77bcf86cd799439011";
const PROFILE_ID = "507f191e810c19729de860ea";
const AFFILIATION_ID = "507f191e810c19729de860eb";
const IDEMPOTENCY_KEY = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

const DETAIL = Object.freeze({
  id: PROFILE_ID,
  displayName: "Amy Chen",
  avatar: null,
  professionalHeadline: "Product Manager",
  company: "Example Corp",
  occupation: "Product Manager",
  generalLocation: "Seattle",
  affiliations: [
    { id: AFFILIATION_ID, programName: "EMBA", cohortLabel: "2022" },
  ],
  helpOfferings: {
    careerAdvice: true,
    warmIntroduction: false,
    formalEmployeeReferral: false,
  },
  industry: "Technology",
  skills: ["Product Strategy"],
  bio: "Happy to help.",
});

const OWN = Object.freeze({
  ...DETAIL,
  publishStatus: "draft" as const,
  consentVersion: null,
  hasCurrentPublicationConsent: false,
  publicationConsent: {
    version: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
    text: ALUMNI_PROFILE_PUBLICATION_CONSENT.text,
  },
  publishReadiness: { ready: true, issues: [] },
  revision: 2,
  publishedAt: null,
  withdrawnAt: null,
  updatedAt: "2031-09-01T12:00:00.000Z",
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/directory", directoryRoutes);
  return app;
}

function member(requestBuilder: request.Test): request.Test {
  return requestBuilder.set("Authorization", "Bearer member");
}

describe("alumni owner profile HTTP contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    gateMocks.readable.mockClear();
    gateMocks.writable.mockClear();
  });

  it("requires authentication and uses read gates without an idempotency key", async () => {
    const own = vi.spyOn(alumniProfileService, "getOwn").mockResolvedValue(OWN);
    const app = buildApp();

    await request(app).get("/api/directory/me").expect(401);
    const response = await member(request(app).get("/api/directory/me")).expect(
      200,
    );

    expect(gateMocks.readable).toHaveBeenCalledOnce();
    expect(gateMocks.writable).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledWith(USER_ID);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ success: true, data: { profile: OWN } });
  });

  it("routes the static read-only preview endpoint to DirectoryDetailDTO", async () => {
    const preview = vi
      .spyOn(alumniProfileService, "previewOwn")
      .mockResolvedValue(DETAIL);
    const own = vi.spyOn(alumniProfileService, "getOwn");
    const app = buildApp();

    const response = await member(
      request(app).get("/api/directory/me/preview"),
    ).expect(200);

    expect(preview).toHaveBeenCalledWith(USER_ID);
    expect(own).not.toHaveBeenCalled();
    expect(gateMocks.readable).toHaveBeenCalledOnce();
    expect(response.body).toEqual({ success: true, data: { profile: DETAIL } });
  });

  it("strictly parses update and returns only the refreshed Own DTO envelope", async () => {
    const update = vi.spyOn(alumniProfileService, "updateOwn").mockResolvedValue({
      profileId: PROFILE_ID,
      publishStatus: "draft",
      revision: 3,
      replayed: false,
    });
    vi.spyOn(alumniProfileService, "getOwn").mockResolvedValue({
      ...OWN,
      professionalHeadline: "Product Leader",
      revision: 3,
    });
    const app = buildApp();

    await member(request(app).patch("/api/directory/me"))
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ expectedRevision: 2, phone: "+12065550101" })
      .expect(400);
    await member(request(app).patch("/api/directory/me"))
      .send({ expectedRevision: 2, professionalHeadline: "Product Leader" })
      .expect(400);

    const response = await member(request(app).patch("/api/directory/me"))
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .set("x-correlation-id", "profile-http")
      .send({ expectedRevision: 2, professionalHeadline: " Product  Leader " })
      .expect(200);

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      expectedRevision: 2,
      professionalHeadline: "Product Leader",
      actor: { id: USER_ID, role: "Participant" },
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "profile-http",
    });
    expect(gateMocks.writable).toHaveBeenCalledTimes(3);
    expect(Object.keys(response.body.data)).toEqual(["profile"]);
    expect(response.body.data.profile).toMatchObject({
      professionalHeadline: "Product Leader",
      revision: 3,
    });
    expect(response.body.data).not.toHaveProperty("replayed");
  });

  it("parses publish and withdraw as idempotent owner-only mutations", async () => {
    const publish = vi
      .spyOn(alumniProfileService, "publishOwn")
      .mockResolvedValue({
        profileId: PROFILE_ID,
        publishStatus: "published",
        revision: 3,
        replayed: false,
      });
    const withdraw = vi
      .spyOn(alumniProfileService, "withdrawOwn")
      .mockResolvedValue({
        profileId: PROFILE_ID,
        publishStatus: "withdrawn",
        revision: 4,
        replayed: false,
      });
    vi.spyOn(alumniProfileService, "getOwn")
      .mockResolvedValueOnce({
        ...OWN,
        publishStatus: "published",
        hasCurrentPublicationConsent: true,
        revision: 3,
      })
      .mockResolvedValueOnce({
        ...OWN,
        publishStatus: "withdrawn",
        revision: 4,
      });
    const app = buildApp();

    await member(request(app).post("/api/directory/me/publish"))
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({
        expectedRevision: 2,
        consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
        consentAccepted: true,
      })
      .expect(200);
    await member(request(app).post("/api/directory/me/withdraw"))
      .set("Idempotency-Key", "4f00aa31-36f0-4f05-8f4a-a362bf33a112")
      .send({ expectedRevision: 3 })
      .expect(200);

    expect(publish).toHaveBeenCalledOnce();
    expect(withdraw).toHaveBeenCalledOnce();
    expect(gateMocks.writable).toHaveBeenCalledTimes(2);
  });

  it("maps readiness issues safely and never leaks unexpected service errors", async () => {
    vi.spyOn(alumniProfileService, "publishOwn")
      .mockRejectedValueOnce(
        new AlumniProfileNotPublishableError([
          {
            field: "phone",
            code: "required",
            message: "Phone is required.",
          },
        ]),
      )
      .mockRejectedValueOnce(new Error("secret storage diagnostic"));
    const app = buildApp();
    const payload = {
      expectedRevision: 2,
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      consentAccepted: true,
    };

    const readiness = await member(
      request(app).post("/api/directory/me/publish"),
    )
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(payload)
      .expect(422);
    expect(readiness.body).toEqual({
      success: false,
      message: "The alumni profile is not ready to publish.",
      code: "ALUMNI_PROFILE_NOT_PUBLISHABLE",
      issues: [
        { field: "phone", code: "required", message: "Phone is required." },
      ],
    });

    const unavailable = await member(
      request(app).post("/api/directory/me/publish"),
    )
      .set("Idempotency-Key", "5f00aa31-36f0-4f05-8f4a-a362bf33a113")
      .send(payload)
      .expect(503);
    expect(unavailable.text).not.toContain("secret storage diagnostic");
  });
});
