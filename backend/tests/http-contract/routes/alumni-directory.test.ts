import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const middlewareMocks = vi.hoisted(() => ({
  readable: vi.fn(),
  permission: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    if (!req.get("Authorization")) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }
    req.userId = "507f1f77bcf86cd799439011";
    req.userRole = "Participant";
    next();
  },
  authorizePermission:
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      middlewareMocks.permission(permission);
      if (req.get("x-deny-permission") === "true") {
        res.status(403).json({ success: false, message: "Forbidden." });
        return;
      }
      next();
    },
}));

vi.mock("../../../src/middleware/alumniNetworkFeatureGate", () => ({
  requireAlumniNetworkReadable: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    middlewareMocks.readable();
    next();
  },
  requireAlumniNetworkWritable: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

import directoryRoutes from "../../../src/routes/directory";
import { AlumniFlowError } from "../../../src/services/alumni/AlumniFlowErrors";
import { alumniDirectoryService } from "../../../src/services/alumni/AlumniDirectoryService";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

const PROFILE_ID = "507f191e810c19729de860ea";
const AFFILIATION_ID = "507f191e810c19729de860eb";
const CARD = Object.freeze({
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
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/directory", directoryRoutes);
  return app;
}

function member(builder: request.Test): request.Test {
  return builder.set("Authorization", "Bearer member");
}

describe("alumni Directory HTTP contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    middlewareMocks.readable.mockClear();
    middlewareMocks.permission.mockClear();
  });

  it("requires authentication and the member profile-view permission", async () => {
    const list = vi.spyOn(alumniDirectoryService, "list").mockResolvedValue({
      profiles: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalProfiles: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
    const app = buildApp();

    await request(app).get("/api/directory").expect(401);
    await member(request(app).get("/api/directory"))
      .set("x-deny-permission", "true")
      .expect(403);
    await member(request(app).get("/api/directory")).expect(200);

    expect(middlewareMocks.permission).toHaveBeenCalledWith(
      PERMISSIONS.VIEW_USER_PROFILES,
    );
    expect(middlewareMocks.readable).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({ page: 1, limit: 24 });
  });

  it("parses all filters and returns only the DirectoryCardDTO envelope", async () => {
    const list = vi.spyOn(alumniDirectoryService, "list").mockResolvedValue({
      profiles: [CARD],
      pagination: {
        currentPage: 2,
        totalPages: 2,
        totalProfiles: 25,
        hasNext: false,
        hasPrev: true,
      },
    });
    const app = buildApp();

    const response = await member(request(app).get("/api/directory"))
      .query({
        page: "2",
        limit: "24",
        q: ".*[]",
        company: "Example Corp",
        industry: "Technology",
        skill: "Product Strategy",
        location: "Seattle",
        cohort: "EMBA 2022",
        offering: "career_advice",
      })
      .expect(200);

    expect(list).toHaveBeenCalledWith({
      page: 2,
      limit: 24,
      q: ".*[]",
      company: "Example Corp",
      industry: "Technology",
      skill: "Product Strategy",
      location: "Seattle",
      cohort: "EMBA 2022",
      offering: "career_advice",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: {
        profiles: [CARD],
        pagination: {
          currentPage: 2,
          totalPages: 2,
          totalProfiles: 25,
          hasNext: false,
          hasPrev: true,
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/email|phone|birthYear/u);
  });

  it("rejects unknown, duplicate, and over-limit query parameters", async () => {
    const list = vi.spyOn(alumniDirectoryService, "list");
    const app = buildApp();

    await member(request(app).get("/api/directory?email=amy@example.org")).expect(
      400,
    );
    await member(request(app).get("/api/directory?page=1&page=2")).expect(400);
    const response = await member(
      request(app).get("/api/directory?limit=101"),
    ).expect(400);

    expect(response.body).toMatchObject({
      success: false,
      code: "ALUMNI_DIRECTORY_QUERY_INVALID",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("serves an exact detail DTO and safely maps an unavailable profile", async () => {
    const get = vi
      .spyOn(alumniDirectoryService, "get")
      .mockResolvedValueOnce({
        ...CARD,
        industry: "Technology",
        skills: ["Product Strategy"],
        bio: "Happy to help.",
      })
      .mockRejectedValueOnce(
        new AlumniFlowError(
          "ALUMNI_PROFILE_NOT_FOUND",
          404,
          "internal profile diagnostic",
        ),
      );
    const app = buildApp();

    const detail = await member(
      request(app).get(`/api/directory/${PROFILE_ID}`),
    ).expect(200);
    const missing = await member(
      request(app).get("/api/directory/not-an-object-id"),
    ).expect(404);

    expect(get).toHaveBeenNthCalledWith(1, PROFILE_ID);
    expect(detail.body.data.profile).toMatchObject({
      id: PROFILE_ID,
      industry: "Technology",
      skills: ["Product Strategy"],
    });
    expect(missing.body).toEqual({
      success: false,
      code: "ALUMNI_PROFILE_NOT_FOUND",
      message: "The alumni profile was not found.",
    });
    expect(missing.text).not.toContain("internal profile diagnostic");
  });
});
