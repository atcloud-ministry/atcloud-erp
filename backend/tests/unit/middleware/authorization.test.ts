import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("../../../src/services/authorization/AuthorizationService", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/services/authorization/AuthorizationService")
  >("../../../src/services/authorization/AuthorizationService");
  return {
    ...actual,
    authorizationService: { authorize: vi.fn() },
  };
});

vi.mock("../../../src/services/authorization/AuthorizationAuditService", () => ({
  recordAuthorizationDenial: vi.fn(),
}));

import { authorizeHttp } from "../../../src/middleware/authorization";
import { recordAuthorizationDenial } from "../../../src/services/authorization/AuthorizationAuditService";
import { authorizationService } from "../../../src/services/authorization/AuthorizationService";
import { AUTHORIZATION_ACTIONS } from "../../../src/services/authorization/types";

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

describe("authorizeHttp", () => {
  const next = vi.fn() as unknown as NextFunction;

  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without a user principal", async () => {
    const res = response();
    await authorizeHttp({ action: AUTHORIZATION_ACTIONS.EVENT_MANAGE })(
      { } as Request,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "authentication_required" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy req.user omits account-state fields", async () => {
    const res = response();
    await authorizeHttp({ action: AUTHORIZATION_ACTIONS.EVENT_MANAGE })(
      {
        user: {
          _id: "507f1f77bcf86cd799439011",
          role: "Leader",
        },
      } as Request,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(authorizationService.authorize).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a minimal principal and resource to the shared service", async () => {
    vi.mocked(authorizationService.authorize).mockResolvedValue({
      allowed: true,
      reasonCode: "allowed",
      concealExistence: false,
    });
    const res = response();
    const req = {
      authPrincipal: {
        kind: "user",
        userId: "user-1",
        role: "Leader",
        isActive: true,
        isVerified: true,
      },
      params: { eventId: "event-1" },
    } as unknown as Request;

    await authorizeHttp({
      action: AUTHORIZATION_ACTIONS.EVENT_MANAGE,
      resource: (request) => ({
        type: "event",
        id: request.params.eventId,
      }),
    })(req, res, next);

    expect(authorizationService.authorize).toHaveBeenCalledWith({
      source: "http",
      principal: req.authPrincipal,
      action: AUTHORIZATION_ACTIONS.EVENT_MANAGE,
      resource: { type: "event", id: "event-1" },
      context: undefined,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it("conceals a denied private resource as 404", async () => {
    vi.mocked(authorizationService.authorize).mockResolvedValue({
      allowed: false,
      reasonCode: "not_resource_member",
      concealExistence: false,
    });
    const res = response();
    const req = {
      authPrincipal: {
        kind: "user",
        userId: "user-1",
        role: "Participant",
        isActive: true,
        isVerified: true,
      },
    } as Request;

    await authorizeHttp({
      action: AUTHORIZATION_ACTIONS.EVENT_MANAGE,
      concealDeniedResource: true,
    })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "resource_not_found" }),
    );
  });

  it("returns 500 for an authorization engine failure even when concealed", async () => {
    vi.mocked(authorizationService.authorize).mockResolvedValue({
      allowed: false,
      reasonCode: "authorization_error",
      concealExistence: true,
    });
    const res = response();
    const req = {
      authPrincipal: {
        kind: "user",
        userId: "user-1",
        role: "Participant",
        isActive: true,
        isVerified: true,
      },
    } as Request;

    await authorizeHttp({
      action: AUTHORIZATION_ACTIONS.EVENT_MANAGE,
      concealDeniedResource: true,
    })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "authorization_error" }),
    );
  });

  it("fails closed when a request extractor throws", async () => {
    const res = response();
    const req = {
      correlationId: "request-extractor-failure",
      authPrincipal: {
        kind: "user",
        userId: "user-1",
        role: "Participant",
        isActive: true,
        isVerified: true,
      },
    } as Request;

    await authorizeHttp({
      action: AUTHORIZATION_ACTIONS.EVENT_MANAGE,
      resource: () => {
        throw new Error("malformed route state");
      },
    })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "authorization_error" }),
    );
    expect(recordAuthorizationDenial).toHaveBeenCalledWith(
      expect.objectContaining({ source: "http" }),
      expect.objectContaining({ reasonCode: "authorization_error" }),
      "request-extractor-failure",
    );
    expect(
      vi.mocked(recordAuthorizationDenial).mock.calls[0][0],
    ).not.toHaveProperty("resource");
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when the authorization service rejects", async () => {
    vi.mocked(authorizationService.authorize).mockRejectedValue(
      new Error("authorization unavailable"),
    );
    const res = response();
    const req = {
      authPrincipal: {
        kind: "user",
        userId: "user-1",
        role: "Participant",
        isActive: true,
        isVerified: true,
      },
    } as Request;

    await authorizeHttp({ action: AUTHORIZATION_ACTIONS.EVENT_MANAGE })(
      req,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "authorization_error" }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
