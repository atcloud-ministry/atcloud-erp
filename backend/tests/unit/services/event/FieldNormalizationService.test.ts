import { describe, it, expect, vi, beforeEach } from "vitest";

import { FieldNormalizationService } from "../../../../src/services/event/FieldNormalizationService";

vi.mock("../../../../src/utils/event/timezoneUtils", () => ({
  toInstantFromWallClock: (date: string, time: string) =>
    new Date(`${date}T${time}:00.000Z`),
}));

const makeRes = () => {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
};

const baseEvent = {
  id: "e1",
  date: "2024-01-01",
  endDate: "2024-01-01",
  time: "10:00",
  endTime: "11:00",
  timeZone: "UTC",
  format: "Online",
  zoomLink: "https://zoom.example.com/meeting",
  location: "Online",
} as any;

describe("FieldNormalizationService.normalizeAndValidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined and 400 when end is before start", async () => {
    const res = makeRes();
    const updateData = {
      date: "2024-01-01",
      time: "12:00",
      endDate: "2024-01-01",
      endTime: "11:00",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      { ...updateData },
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
      }),
    );
  });

  it("keeps normalized update data when overlapping events exist", async () => {
    const res = makeRes();
    const updateData = {
      date: "2024-01-02",
      time: "10:00",
      endDate: "2024-01-02",
      endTime: "11:00",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      { ...updateData },
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toEqual(expect.objectContaining(updateData));
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  it("clears virtual fields when switching to In-person and normalizes location + flyer URLs", async () => {
    const res = makeRes();
    const updateData: any = {
      format: "In-person",
      zoomLink: " should-be-cleared ",
      meetingId: " will-be-cleared ",
      passcode: " will-be-cleared ",
      location: "  New Venue  ",
      flyerUrl: "  https://example.com/flyer  ",
      secondaryFlyerUrl: "   ",
      timeZone: "  America/New_York  ",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    expect(result?.zoomLink).toBeUndefined();
    expect(result?.meetingId).toBeUndefined();
    expect(result?.passcode).toBeUndefined();
    expect(result?.location).toBe("New Venue");
    expect(result?.flyerUrl).toBe("https://example.com/flyer");
    // secondaryFlyerUrl with only spaces becomes undefined
    expect(result?.secondaryFlyerUrl).toBeUndefined();
    expect(result?.timeZone).toBe("America/New_York");
  });

  it("normalizes Online format location and trims virtual fields", async () => {
    const res = makeRes();
    const updateData: any = {
      format: "Online",
      zoomLink: "  https://zoom.example.com/abc  ",
      meetingId: " 12345 ",
      passcode: "  pass  ",
      location: " should-be-overwritten ",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      { ...baseEvent, format: "Hybrid" } as any,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    expect(result?.zoomLink).toBe("https://zoom.example.com/abc");
    expect(result?.meetingId).toBe("12345");
    expect(result?.passcode).toBe("pass");
    // Online format forces location to "Online"
    expect(result?.location).toBe("Online");
  });

  it("treats explicit null flyer URLs as removal", async () => {
    const res = makeRes();
    const updateData: any = {
      flyerUrl: null,
      secondaryFlyerUrl: null,
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    expect(result?.flyerUrl).toBeUndefined();
    expect(result?.secondaryFlyerUrl).toBeUndefined();
  });

  it("applies final Date-based check and errors if effEnd < effStart", async () => {
    const res = makeRes();
    const updateData: any = {
      date: "2024-01-02",
      endDate: "2024-01-01",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("FieldNormalizationService.extractSuppressionFlags", () => {
  it("returns false by default", () => {
    const result = FieldNormalizationService.extractSuppressionFlags({});
    expect(result.suppressNotifications).toBe(false);
  });

  it("returns provided boolean value", () => {
    const result = FieldNormalizationService.extractSuppressionFlags({
      suppressNotifications: true,
    });
    expect(result.suppressNotifications).toBe(true);
  });
});

describe("FieldNormalizationService.prepareUpdateData", () => {
  it("removes control and server-owned fields from update data", () => {
    const body = {
      title: "Event",
      suppressNotifications: true,
      _id: "replacement-id",
      id: "replacement-id",
      createdBy: "replacement-owner",
      createdAt: "2000-01-01",
      updatedAt: "2000-01-01",
      __v: 100,
    };
    const updateData = FieldNormalizationService.prepareUpdateData(body);

    expect(updateData).toEqual({ title: "Event" });
  });
});

describe("FieldNormalizationService - edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes endDate string by trimming whitespace", async () => {
    const res = makeRes();
    const updateData: any = {
      endDate: "  2024-01-01  ",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    expect(result?.endDate).toBe("2024-01-01");
  });

  it("handles empty string virtual fields for Online/Hybrid format", async () => {
    const res = makeRes();
    const updateData: any = {
      format: "Hybrid",
      zoomLink: "   ",
      meetingId: "",
      passcode: "  ",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    // Empty strings after trim become undefined
    expect(result?.zoomLink).toBeUndefined();
    expect(result?.meetingId).toBeUndefined();
    expect(result?.passcode).toBeUndefined();
  });

  it("handles empty location string for non-Online format", async () => {
    const res = makeRes();
    const updateData: any = {
      format: "Hybrid",
      location: "   ",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    // Empty location after trim becomes undefined
    expect(result?.location).toBeUndefined();
  });

  it("handles empty timeZone string", async () => {
    const res = makeRes();
    const updateData: any = {
      timeZone: "   ",
    };

    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    expect(result?.timeZone).toBeUndefined();
  });

  it("uses existing event format if format not in updateData", async () => {
    const res = makeRes();
    const updateData: any = {
      // No format provided
      location: "Test Venue",
    };

    // Event is Online format
    const result = await FieldNormalizationService.normalizeAndValidate(
      updateData,
      baseEvent,
      "e1",
      res as any,
    );

    expect(result).toBeDefined();
    // Should use event.format (Online) so location becomes "Online"
    expect(result?.location).toBe("Online");
  });
});
