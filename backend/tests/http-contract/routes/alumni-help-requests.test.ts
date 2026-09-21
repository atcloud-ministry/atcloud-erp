import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  permission: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get("Authorization");
    if (!authorization) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }
    if (authorization !== "Bearer broken-context") {
      req.userId = "507f1f77bcf86cd799439011";
      req.userRole = "Participant";
    }
    req.correlationId = req.get("x-correlation-id") ?? undefined;
    next();
  },
  authorizePermission:
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      authMocks.permission(permission);
      if (req.get("x-deny-permission") === "true") {
        res.status(403).json({ success: false, message: "Access denied." });
        return;
      }
      next();
    },
}));

import type { AlumniNetworkMode } from "../../../src/config/alumniNetworkFeature";
import { ALUMNI_HELP_TERMS } from "../../../src/config/alumniHelpTerms";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import alumniHelpRequestRoutes from "../../../src/routes/alumniHelpRequests";
import { AlumniFlowError } from "../../../src/services/alumni/AlumniFlowErrors";
import { alumniHelpRequestService } from "../../../src/services/alumni/AlumniHelpRequestService";
import { reliabilityFoundationService } from "../../../src/services/reliability/ReliabilityFoundationService";
import { featureControlService } from "../../../src/services/runtime/FeatureControlService";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

const USER_ID = "507f1f77bcf86cd799439011";
const PROVIDER_ID = "507f1f77bcf86cd799439012";
const PROFILE_ID = "507f191e810c19729de860ea";
const REQUEST_ID = "507f191e810c19729de860eb";
const OUTCOME_ID = "507f191e810c19729de860ec";
const EVENT_ID = "507f191e810c19729de860ed";
const IDEMPOTENCY_KEY = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

const SUMMARY = Object.freeze({
  id: REQUEST_ID,
  requester: Object.freeze({
    id: USER_ID,
    displayName: "Jordan Lee",
    avatar: null,
  }),
  provider: Object.freeze({
    id: PROVIDER_ID,
    displayName: "Amy Chen",
    avatar: "/uploads/amy.png",
  }),
  status: "requested" as const,
  requestedHelpType: "career_advice" as const,
  proposedHelpType: null,
  agreedHelpType: null,
  conversationId: null,
  viewerRole: "requester" as const,
  actionRequiredForViewer: false,
  availableActions: Object.freeze(["withdraw"] as const),
  latestOutcome: null,
  revision: 0,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
  closedAt: null,
});

const DETAIL = Object.freeze({
  ...SUMMARY,
  alumniProfileId: PROFILE_ID,
  openingNote: "Could we discuss product management?",
  lifecycleTimeline: Object.freeze([
    Object.freeze({
      id: EVENT_ID,
      sequence: 1,
      action: "create" as const,
      fromStatus: null,
      toStatus: "requested" as const,
      actorRole: "requester" as const,
      note: null,
      helpType: "career_advice" as const,
      occurredAt: "2026-09-12T12:00:00.000Z",
    }),
  ]),
  outcomes: Object.freeze([]),
  availableAlternativeHelpTypes: Object.freeze([]),
  acceptedAt: null,
  declinedAt: null,
  withdrawnAt: null,
  startedAt: null,
  completedAt: null,
  termsAcceptedAt: "2026-09-12T12:00:00.000Z",
  acceptedTerms: Object.freeze({
    consent: Object.freeze({
      version: "alumni-help-consent-v1",
      text: "Archived consent",
      effectiveAt: "2026-09-12T00:00:00.000Z",
    }),
    disclaimer: Object.freeze({
      version: "alumni-help-disclaimer-v1",
      text: "Archived disclaimer",
      effectiveAt: "2026-09-12T00:00:00.000Z",
    }),
  }),
});

const REQUEST_DATA = Object.freeze({
  request: DETAIL,
  helpActionRequiredCount: 2,
});

const LIST_DATA = Object.freeze({
  requests: Object.freeze([SUMMARY]),
  pagination: Object.freeze({
    currentPage: 2,
    totalPages: 3,
    totalCount: 5,
    hasNext: true,
    hasPrev: true,
  }),
  helpActionRequiredCount: 2,
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/alumni-help-requests", alumniHelpRequestRoutes);
  return app;
}

function member(builder: request.Test): request.Test {
  return builder.set("Authorization", "Bearer member");
}

function mutation(builder: request.Test): request.Test {
  return member(builder)
    .set("Idempotency-Key", IDEMPOTENCY_KEY)
    .set("x-correlation-id", "alumni-help-http");
}

function setRuntimeMode(mode: AlumniNetworkMode): void {
  vi.mocked(featureControlService.getRuntimeConfig).mockResolvedValue(
    createRuntimeConfigDTO(mode, 7),
  );
}

describe("alumni help request HTTP contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authMocks.permission.mockClear();
    vi.spyOn(featureControlService, "getRuntimeConfig");
    setRuntimeMode("on");
  });

  it("requires authentication and profile-view permission", async () => {
    const list = vi.spyOn(alumniHelpRequestService, "list").mockResolvedValue({
      requests: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalCount: 0,
        hasNext: false,
        hasPrev: false,
      },
      helpActionRequiredCount: 0,
    });
    const app = buildApp();

    await request(app).get("/api/alumni-help-requests").expect(401);
    await member(request(app).get("/api/alumni-help-requests"))
      .set("x-deny-permission", "true")
      .expect(403);
    await member(request(app).get("/api/alumni-help-requests")).expect(200);

    expect(authMocks.permission).toHaveBeenCalledWith(
      PERMISSIONS.VIEW_USER_PROFILES,
    );
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(USER_ID, {
      view: "action_required",
      page: 1,
      limit: 20,
    });
  });

  it("enforces off, read-only, and on runtime modes at the route boundary", async () => {
    const list = vi
      .spyOn(alumniHelpRequestService, "list")
      .mockResolvedValue(LIST_DATA);
    const create = vi
      .spyOn(alumniHelpRequestService, "create")
      .mockResolvedValue(REQUEST_DATA);
    const app = buildApp();
    const body = {
      alumniProfileId: PROFILE_ID,
      requestedHelpType: "career_advice",
      consentVersion: ALUMNI_HELP_TERMS.consent.version,
      consentAccepted: true,
      disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
      disclaimerAccepted: true,
    };

    setRuntimeMode("off");
    const disabledRead = await member(
      request(app).get("/api/alumni-help-requests"),
    ).expect(503);
    expect(disabledRead.body.code).toBe("ALUMNI_NETWORK_READ_UNAVAILABLE");
    expect(disabledRead.headers["cache-control"]).toBe("no-store");
    expect(list).not.toHaveBeenCalled();

    setRuntimeMode("read_only");
    await member(request(app).get("/api/alumni-help-requests")).expect(200);
    const disabledWrite = await mutation(
      request(app).post("/api/alumni-help-requests"),
    )
      .send(body)
      .expect(503);
    expect(disabledWrite.body.code).toBe("ALUMNI_NETWORK_WRITE_UNAVAILABLE");
    expect(create).not.toHaveBeenCalled();

    setRuntimeMode("on");
    await mutation(request(app).post("/api/alumni-help-requests"))
      .send(body)
      .expect(201);
    expect(create).toHaveBeenCalledOnce();
  });

  it("serves terms, paged lists, counts, and exact participant detail DTOs", async () => {
    const list = vi
      .spyOn(alumniHelpRequestService, "list")
      .mockResolvedValue(LIST_DATA);
    const count = vi
      .spyOn(alumniHelpRequestService, "actionRequiredCount")
      .mockResolvedValue({ helpActionRequiredCount: 2 });
    const get = vi
      .spyOn(alumniHelpRequestService, "get")
      .mockResolvedValue(REQUEST_DATA);
    const app = buildApp();

    const terms = await member(
      request(app).get("/api/alumni-help-requests/terms"),
    ).expect(200);
    const listed = await member(
      request(app).get(
        "/api/alumni-help-requests?view=received&page=2&limit=2",
      ),
    ).expect(200);
    const counted = await member(
      request(app).get("/api/alumni-help-requests/action-required-count"),
    ).expect(200);
    const detail = await member(
      request(app).get(`/api/alumni-help-requests/${REQUEST_ID}`),
    ).expect(200);

    expect(terms.body).toEqual({
      success: true,
      data: {
        terms: {
          consent: {
            version: ALUMNI_HELP_TERMS.consent.version,
            text: ALUMNI_HELP_TERMS.consent.text,
            effectiveAt: ALUMNI_HELP_TERMS.consent.effectiveAt,
          },
          disclaimer: {
            version: ALUMNI_HELP_TERMS.disclaimer.version,
            text: ALUMNI_HELP_TERMS.disclaimer.text,
            effectiveAt: ALUMNI_HELP_TERMS.disclaimer.effectiveAt,
          },
        },
      },
    });
    expect(terms.text).not.toContain("documentHash");
    expect(list).toHaveBeenCalledWith(USER_ID, {
      view: "received",
      page: 2,
      limit: 2,
    });
    expect(listed.body).toEqual({ success: true, data: LIST_DATA });
    expect(count).toHaveBeenCalledWith(USER_ID);
    expect(counted.body).toEqual({
      success: true,
      data: { helpActionRequiredCount: 2 },
    });
    expect(get).toHaveBeenCalledWith(USER_ID, REQUEST_ID);
    expect(detail.body).toEqual({ success: true, data: REQUEST_DATA });
    expect(detail.headers["cache-control"]).toBe("no-store");
  });

  it("strictly rejects malformed queries, bodies, request context, and keys", async () => {
    const list = vi.spyOn(alumniHelpRequestService, "list");
    const create = vi.spyOn(alumniHelpRequestService, "create");
    const app = buildApp();
    const validBody = {
      alumniProfileId: PROFILE_ID,
      requestedHelpType: "career_advice",
      consentVersion: ALUMNI_HELP_TERMS.consent.version,
      consentAccepted: true,
      disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
      disclaimerAccepted: true,
    };

    const unknownQuery = await member(
      request(app).get("/api/alumni-help-requests?requesterId=someone"),
    ).expect(400);
    await member(
      request(app).get("/api/alumni-help-requests?page=1&page=2"),
    ).expect(400);
    expect(unknownQuery.body.code).toBe("ALUMNI_HELP_FLOW_INPUT_INVALID");
    expect(list).not.toHaveBeenCalled();

    await mutation(request(app).post("/api/alumni-help-requests"))
      .send({ ...validBody, requesterId: USER_ID })
      .expect(400);
    const missingKey = await member(
      request(app).post("/api/alumni-help-requests"),
    )
      .send(validBody)
      .expect(400);
    const invalidKey = await member(
      request(app).post("/api/alumni-help-requests"),
    )
      .set("Idempotency-Key", "not-a-uuid")
      .send(validBody)
      .expect(400);
    expect(missingKey.body.code).toBe("ALUMNI_HELP_FLOW_INPUT_INVALID");
    expect(invalidKey.body.code).toBe("ALUMNI_HELP_FLOW_INPUT_INVALID");

    const brokenContext = await request(app)
      .get("/api/alumni-help-requests")
      .set("Authorization", "Bearer broken-context")
      .expect(400);
    expect(brokenContext.body.code).toBe("ALUMNI_HELP_FLOW_INPUT_INVALID");
    expect(create).not.toHaveBeenCalled();
  });

  it("normalizes create input and forwards only authenticated request context", async () => {
    const create = vi
      .spyOn(alumniHelpRequestService, "create")
      .mockResolvedValue(REQUEST_DATA);
    const wake = vi
      .spyOn(reliabilityFoundationService, "wakeNotificationOutbox")
      .mockReturnValue(false);
    const app = buildApp();

    const response = await member(
      request(app).post("/api/alumni-help-requests"),
    )
      .set("Idempotency-Key", IDEMPOTENCY_KEY.toUpperCase())
      .set("x-correlation-id", "alumni-help-http")
      .send({
        alumniProfileId: PROFILE_ID.toUpperCase(),
        requestedHelpType: "career_advice",
        openingNote: "  Could   we discuss product management?  ",
        consentVersion: ALUMNI_HELP_TERMS.consent.version,
        consentAccepted: true,
        disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
        disclaimerAccepted: true,
      })
      .expect(201);

    expect(create).toHaveBeenCalledWith({
      alumniProfileId: PROFILE_ID,
      requestedHelpType: "career_advice",
      openingNote: "Could we discuss product management?",
      consentVersion: ALUMNI_HELP_TERMS.consent.version,
      consentAccepted: true,
      disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
      disclaimerAccepted: true,
      actor: { id: USER_ID, role: "Participant" },
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "alumni-help-http",
    });
    expect(response.body).toEqual({ success: true, data: REQUEST_DATA });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(wake).toHaveBeenCalledOnce();
  });

  it("does not wake the worker before a Help create has committed", async () => {
    let resolveCreate: ((value: typeof REQUEST_DATA) => void) | undefined;
    const committedCreate = new Promise<typeof REQUEST_DATA>((resolve) => {
      resolveCreate = resolve;
    });
    const create = vi
      .spyOn(alumniHelpRequestService, "create")
      .mockReturnValue(committedCreate);
    const wake = vi
      .spyOn(reliabilityFoundationService, "wakeNotificationOutbox")
      .mockReturnValue(false);
    const app = buildApp();
    const response = mutation(
      request(app).post("/api/alumni-help-requests"),
    )
      .send({
        alumniProfileId: PROFILE_ID,
        requestedHelpType: "career_advice",
        consentVersion: ALUMNI_HELP_TERMS.consent.version,
        consentAccepted: true,
        disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
        disclaimerAccepted: true,
      })
      .then((value) => value);

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(wake).not.toHaveBeenCalled();

    resolveCreate?.(REQUEST_DATA);
    await expect(response).resolves.toMatchObject({ status: 201 });
    expect(wake).toHaveBeenCalledOnce();
  });

  it("maps every lifecycle route to its exact action-specific service input", async () => {
    const transition = vi
      .spyOn(alumniHelpRequestService, "transition")
      .mockResolvedValue(REQUEST_DATA);
    const wake = vi
      .spyOn(reliabilityFoundationService, "wakeNotificationOutbox")
      .mockReturnValue(false);
    const app = buildApp();
    const cases = [
      {
        path: "request-information",
        action: "request_information",
        body: { expectedRevision: 1, note: "  Please   add context.  " },
        parsed: { expectedRevision: 1, note: "Please add context." },
      },
      {
        path: "provide-information",
        action: "provide_information",
        body: { expectedRevision: 1, note: "  Here   it is.  " },
        parsed: { expectedRevision: 1, note: "Here it is." },
      },
      {
        path: "propose-alternative",
        action: "propose_alternative",
        body: {
          expectedRevision: 1,
          proposedHelpType: "warm_introduction",
          note: " I can make an introduction. ",
        },
        parsed: {
          expectedRevision: 1,
          proposedHelpType: "warm_introduction",
          note: "I can make an introduction.",
        },
      },
      {
        path: "confirm-alternative",
        action: "confirm_alternative",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
      {
        path: "reject-alternative",
        action: "reject_alternative",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
      {
        path: "accept",
        action: "accept",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
      {
        path: "decline",
        action: "decline",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
      {
        path: "withdraw",
        action: "withdraw",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
      {
        path: "start",
        action: "start",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
      {
        path: "complete",
        action: "complete",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
      {
        path: "close",
        action: "close",
        body: { expectedRevision: 1 },
        parsed: { expectedRevision: 1 },
      },
    ] as const;

    for (const testCase of cases) {
      await mutation(
        request(app).post(
          `/api/alumni-help-requests/${REQUEST_ID}/${testCase.path}`,
        ),
      )
        .send(testCase.body)
        .expect(200);
    }

    expect(transition).toHaveBeenCalledTimes(cases.length);
    cases.forEach((testCase, index) => {
      expect(transition).toHaveBeenNthCalledWith(index + 1, {
        requestId: REQUEST_ID,
        action: testCase.action,
        ...testCase.parsed,
        actor: { id: USER_ID, role: "Participant" },
        idempotencyKey: IDEMPOTENCY_KEY,
        correlationId: "alumni-help-http",
      });
    });
    expect(wake).toHaveBeenCalledTimes(cases.length);
  });

  it("strictly routes outcome submission, confirmation, and denial", async () => {
    const submit = vi
      .spyOn(alumniHelpRequestService, "submitOutcome")
      .mockResolvedValue(REQUEST_DATA);
    const decide = vi
      .spyOn(alumniHelpRequestService, "decideOutcome")
      .mockResolvedValue(REQUEST_DATA);
    const wake = vi
      .spyOn(reliabilityFoundationService, "wakeNotificationOutbox")
      .mockReturnValue(false);
    const app = buildApp();

    await mutation(
      request(app).post(`/api/alumni-help-requests/${REQUEST_ID}/outcomes`),
    )
      .send({ expectedRevision: 7, outcomeCode: "completed" })
      .expect(201);
    await mutation(
      request(app).post(
        `/api/alumni-help-requests/${REQUEST_ID}/outcomes/${OUTCOME_ID}/confirm`,
      ),
    )
      .send({ expectedRevision: 0 })
      .expect(200);
    await mutation(
      request(app).post(
        `/api/alumni-help-requests/${REQUEST_ID}/outcomes/${OUTCOME_ID}/deny`,
      ),
    )
      .send({ expectedRevision: 1 })
      .expect(200);

    expect(submit).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      expectedRevision: 7,
      outcomeCode: "completed",
      actor: { id: USER_ID, role: "Participant" },
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "alumni-help-http",
    });
    expect(decide).toHaveBeenNthCalledWith(1, {
      requestId: REQUEST_ID,
      outcomeId: OUTCOME_ID,
      decision: "confirm",
      expectedRevision: 0,
      actor: { id: USER_ID, role: "Participant" },
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "alumni-help-http",
    });
    expect(decide).toHaveBeenNthCalledWith(2, {
      requestId: REQUEST_ID,
      outcomeId: OUTCOME_ID,
      decision: "deny",
      expectedRevision: 1,
      actor: { id: USER_ID, role: "Participant" },
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "alumni-help-http",
    });
    expect(wake).toHaveBeenCalledTimes(3);

    await mutation(
      request(app).post(`/api/alumni-help-requests/${REQUEST_ID}/outcomes`),
    )
      .send({
        expectedRevision: 8,
        outcomeCode: "completed",
        providerDecision: "confirm",
      })
      .expect(400);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("conceals participant authorization as 404 and safely maps help errors", async () => {
    const get = vi.spyOn(alumniHelpRequestService, "get");
    const app = buildApp();
    const failures = [
      [
        "ALUMNI_HELP_REQUEST_NOT_FOUND",
        404,
        "The alumni help request was not found.",
      ],
      [
        "ALUMNI_HELP_REQUEST_DUPLICATE",
        409,
        "An active request for this help offering already exists.",
      ],
      [
        "ALUMNI_HELP_REQUEST_REVISION_CONFLICT",
        409,
        "The help request changed. Refresh it and try again.",
      ],
      [
        "ALUMNI_HELP_REQUEST_STATE_CONFLICT",
        409,
        "The help request is not in the required state.",
      ],
      [
        "ALUMNI_HELP_OFFERING_UNAVAILABLE",
        409,
        "That help offering is no longer available.",
      ],
      [
        "ALUMNI_HELP_TERMS_VERSION_INVALID",
        409,
        "The help request terms changed. Review them and try again.",
      ],
      [
        "ALUMNI_HELP_OUTCOME_NOT_FOUND",
        404,
        "The reported outcome was not found.",
      ],
      [
        "ALUMNI_HELP_OUTCOME_REVISION_CONFLICT",
        409,
        "The reported outcome changed. Refresh it and try again.",
      ],
      [
        "ALUMNI_HELP_OUTCOME_STATE_CONFLICT",
        409,
        "The reported outcome is not in the required state.",
      ],
      [
        "ALUMNI_HELP_OUTCOME_DEADLINE_PASSED",
        409,
        "The confirmation deadline has passed and is being processed.",
      ],
      [
        "ALUMNI_OPERATION_UNAVAILABLE",
        503,
        "The alumni operation is temporarily unavailable.",
      ],
    ] as const;

    for (const [code, status, message] of failures) {
      get.mockRejectedValueOnce(
        new AlumniFlowError(code, status, "private participant diagnostic"),
      );
      const response = await member(
        request(app).get(`/api/alumni-help-requests/${REQUEST_ID}`),
      ).expect(status);
      expect(response.body).toEqual({ success: false, code, message });
      expect(response.text).not.toContain("private participant diagnostic");
    }

    get.mockRejectedValueOnce(new Error("private database diagnostic"));
    const unexpected = await member(
      request(app).get(`/api/alumni-help-requests/${REQUEST_ID}`),
    ).expect(503);
    expect(unexpected.body).toEqual({
      success: false,
      code: "ALUMNI_OPERATION_UNAVAILABLE",
      message: "The alumni operation is temporarily unavailable.",
    });
    expect(unexpected.text).not.toContain("private database diagnostic");
  });
});
