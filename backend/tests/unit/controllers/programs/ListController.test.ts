import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { Types } from "mongoose";

vi.mock("../../../../src/models", () => ({
  Program: { find: vi.fn(), countDocuments: vi.fn() },
}));

import ListController from "../../../../src/controllers/programs/ListController";
import { Program } from "../../../../src/models";

describe("program ListController", () => {
  let query: {
    select: ReturnType<typeof vi.fn>;
    sort: ReturnType<typeof vi.fn>;
    skip: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    lean: ReturnType<typeof vi.fn>;
  };
  let response: Response;
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    query = {
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(Program.find).mockReturnValue(query as any);
    vi.mocked(Program.countDocuments).mockResolvedValue(0);
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    response = { status, json } as unknown as Response;
  });

  async function list(queryParams: Record<string, unknown> = {}) {
    await ListController.list(
      { query: queryParams } as unknown as Request,
      response,
    );
  }

  it("returns a projected, stable first page with pagination metadata", async () => {
    await list();

    expect(Program.find).toHaveBeenCalledWith({});
    expect(query.select).toHaveBeenCalledOnce();
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(query.skip).toHaveBeenCalledWith(0);
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [],
        pagination: expect.objectContaining({ currentPage: 1, limit: 20 }),
      }),
    );
  });

  it("applies type and escaped literal title filters", async () => {
    await list({ type: "Webinar", q: "React (advanced).*" });

    expect(Program.find).toHaveBeenCalledWith({
      programType: "Webinar",
      title: { $regex: "React \\(advanced\\)\\.\\*", $options: "i" },
    });
  });

  it("caps page size and computes the page offset", async () => {
    await list({ page: "3", limit: "1000" });

    expect(query.skip).toHaveBeenCalledWith(200);
    expect(query.limit).toHaveBeenCalledWith(100);
  });

  it("returns stable totals and transforms Mongo ids", async () => {
    const id = new Types.ObjectId();
    query.lean.mockResolvedValue([
      { _id: id, title: "Program", programType: "Webinar" },
    ]);
    vi.mocked(Program.countDocuments).mockResolvedValue(41);

    await list({ page: "2", limit: "20" });

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ id: id.toString() })],
        pagination: expect.objectContaining({
          currentPage: 2,
          totalPrograms: 41,
          totalPages: 3,
          hasNext: true,
          hasPrev: true,
        }),
      }),
    );
  });

  it("never exposes stored mentor email in the public list", async () => {
    const id = new Types.ObjectId();
    const mentorId = new Types.ObjectId();
    query.lean.mockResolvedValue([
      {
        _id: id,
        title: "Program",
        mentors: [
          {
            userId: mentorId,
            firstName: "Amy",
            email: "private@example.com",
          },
        ],
      },
    ]);

    await list();

    const projection = query.select.mock.calls[0][0] as string;
    expect(projection).not.toContain("mentors.email");
    const responseBody = json.mock.calls[0][0];
    expect(responseBody.data[0].mentors[0]).toEqual(
      expect.objectContaining({ userId: mentorId.toString(), firstName: "Amy" }),
    );
    expect(responseBody.data[0].mentors[0]).not.toHaveProperty("email");
  });

  it("returns a controlled error when either page query fails", async () => {
    query.lean.mockRejectedValue(new Error("database unavailable"));

    await list();

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Failed to list programs.",
    });
  });
});
