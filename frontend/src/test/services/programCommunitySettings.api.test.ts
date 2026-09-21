import { afterEach, describe, expect, it, vi } from "vitest";
import { programService } from "../../services/api/programs.api";
import { decodeProgramCommunitySettings } from "../../services/api/programCommunitySettings.contracts";

const PROGRAM_ID = "507f191e810c19729de860ea";
const ROOM_ID = "507f191e810c19729de860eb";
const SETTINGS_ID = "507f191e810c19729de860ec";
const IDEMPOTENCY_KEY = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

function settings() {
  return {
    id: SETTINGS_ID,
    programId: PROGRAM_ID,
    primaryConversationId: ROOM_ID,
    enabled: true,
    opensAt: "2026-09-12T15:00:00.000Z",
    closesAt: "2027-01-01T00:00:00.000Z",
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" },
      { studentRoleId: "class-rep", memberRole: "class_representative" },
    ],
    revision: 1,
    createdAt: "2026-09-12T16:00:00.000Z",
    updatedAt: "2026-09-12T16:00:00.000Z",
  };
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Program community settings API", () => {
  it("decodes the exact management DTO and rejects incomplete lifecycle state", () => {
    expect(decodeProgramCommunitySettings({ settings: settings() })).toEqual(
      settings(),
    );
    expect(() =>
      decodeProgramCommunitySettings({
        settings: { ...settings(), primaryConversationId: null },
      }),
    ).toThrow(/incomplete/u);
    expect(() =>
      decodeProgramCommunitySettings({
        settings: {
          ...settings(),
          enabled: false,
          opensAt: null,
          closesAt: "2027-01-01T00:00:00.000Z",
        },
      }),
    ).toThrow(/date range/u);
    expect(() =>
      decodeProgramCommunitySettings({
        settings: { ...settings(), rawUser: { email: "private@example.org" } },
      }),
    ).toThrow(/invalid response shape/u);
    for (const opensAt of [
      "2026-02-30T12:00:00.000Z",
      "2026-04-31T12:00:00.000Z",
      "2026-09-12T24:00:00.000Z",
    ]) {
      expect(() =>
        decodeProgramCommunitySettings({
          settings: { ...settings(), opensAt },
        }),
      ).toThrow(/canonical UTC instant/u);
    }
    expect(
      decodeProgramCommunitySettings({
        settings: {
          ...settings(),
          opensAt: "2028-02-29T12:00:00.000Z",
          closesAt: null,
        },
      }).opensAt,
    ).toBe("2028-02-29T12:00:00.000Z");
  });

  it("rejects response DTOs with more than 100 role mappings", () => {
    expect(() =>
      decodeProgramCommunitySettings({
        settings: {
          ...settings(),
          studentRoleMappings: Array.from({ length: 101 }, (_, index) => ({
            studentRoleId: `role-${index}`,
            memberRole: "mentee",
          })),
        },
      }),
    ).toThrow(/at most 100/u);
  });

  it("uses the protected Program endpoint and preserves abort signals", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ settings: settings() }));
    const controller = new AbortController();

    await expect(
      programService.getCommunitySettings(PROGRAM_ID, controller.signal),
    ).resolves.toEqual(settings());

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      `/api/programs/${PROGRAM_ID}/community-settings`,
    );
    expect(options?.signal).toBe(controller.signal);
  });

  it("sends exact replacement input with its stable idempotency key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ settings: settings() }));
    const input = {
      enabled: true,
      opensAt: "2026-09-12T15:00:00.000Z",
      closesAt: "2027-01-01T00:00:00.000Z",
      studentRoleMappings: settings().studentRoleMappings as Array<{
        studentRoleId: string;
        memberRole: "mentee" | "class_representative";
      }>,
      expectedRevision: 0,
    };

    await expect(
      programService.updateCommunitySettings(
        PROGRAM_ID,
        input,
        IDEMPOTENCY_KEY,
      ),
    ).resolves.toEqual(settings());

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      `/api/programs/${PROGRAM_ID}/community-settings`,
    );
    expect(options?.method).toBe("PUT");
    expect((options?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      IDEMPOTENCY_KEY,
    );
    expect(JSON.parse(String(options?.body))).toEqual(input);
    expect(String(options?.body)).not.toContain("archivedAt");
  });
});
