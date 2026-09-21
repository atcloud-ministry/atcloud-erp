import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { CommunitySettingsController } from "../../../../src/controllers/programs/CommunitySettingsController";

vi.mock(
  "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      communitySettingsChanged: vi.fn(),
    },
  }),
);

import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

const PROGRAM_ID = "650000000000000000000001";
const ACTOR_ID = "650000000000000000000002";
const IDEMPOTENCY_KEY = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

function settings() {
  return {
    id: "650000000000000000000004",
    programId: PROGRAM_ID,
    primaryConversationId: "650000000000000000000003",
    enabled: true,
    opensAt: "2026-09-12T15:00:00.000Z",
    closesAt: "2026-12-01T00:00:00.000Z",
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "mentee", memberRole: "mentee" as const },
    ],
    revision: 1,
    createdAt: "2026-09-12T16:00:00.000Z",
    updatedAt: "2026-09-12T16:00:00.000Z",
  };
}

describe("CommunitySettingsController mutation synchronization", () => {
  let service: { update: ReturnType<typeof vi.fn> };
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;
  let response: Response;

  beforeEach(() => {
    vi.clearAllMocks();
    service = {
      update: vi.fn().mockResolvedValue({
        settings: settings(),
        replayed: false,
      }),
    };
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    response = {
      setHeader: vi.fn(),
      status,
      json,
    } as unknown as Response;
  });

  it("emits a post-write scope hint with request attribution", async () => {
    const request = {
      params: { id: PROGRAM_ID },
      body: {
        enabled: true,
        opensAt: "2026-09-12T15:00:00.000Z",
        closesAt: "2026-12-01T00:00:00.000Z",
        studentRoleMappings: [
          { studentRoleId: "mentee", memberRole: "mentee" },
        ],
        expectedRevision: 0,
      },
      userId: ACTOR_ID,
      userRole: "Administrator",
      correlationId: "settings-update-1",
      get: vi.fn((header: string) =>
        header === "Idempotency-Key" ? IDEMPOTENCY_KEY : undefined,
      ),
    } as unknown as Request;
    const controller = new CommunitySettingsController(service as any);

    await controller.update(request, response);

    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({
        programId: PROGRAM_ID,
        actor: { id: ACTOR_ID, role: "Administrator" },
        idempotencyKey: IDEMPOTENCY_KEY,
        correlationId: "settings-update-1",
      }),
    );
    expect(
      programMembershipMutationSyncTrigger.communitySettingsChanged,
    ).toHaveBeenCalledWith(PROGRAM_ID, {
      actor: {
        type: "user",
        id: ACTOR_ID,
        role: "Administrator",
      },
      source: "http",
      correlationId: "settings-update-1",
    });
    expect(service.update.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(
        programMembershipMutationSyncTrigger.communitySettingsChanged,
      ).mock.invocationCallOrder[0],
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: { settings: settings() },
    });
  });
});
