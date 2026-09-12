import { describe, expect, it, vi } from "vitest";
import { AlumniHelpRequestService } from "../../../../src/services/alumni/AlumniHelpRequestService";

const REQUEST_ID = "64f100000000000000000001";
const REQUESTER_ID = "64f100000000000000000002";
const PROFILE_ID = "64f100000000000000000003";

describe("AlumniHelpRequestService idempotency boundaries", () => {
  it("replays a committed create before applying current terms policy", async () => {
    const execute = vi.fn().mockResolvedValue({
      replayed: true,
      httpStatus: 201,
      response: { requestId: REQUEST_ID },
    });
    const service = new AlumniHelpRequestService({
      idempotency: { execute } as never,
    });
    const replayedResult = {
      request: { id: REQUEST_ID },
      helpActionRequiredCount: 0,
    };
    const get = vi
      .spyOn(service, "get")
      .mockResolvedValue(replayedResult as never);

    await expect(
      service.create({
        alumniProfileId: PROFILE_ID,
        requestedHelpType: "career_advice",
        consentVersion: "previous-consent-version",
        disclaimerVersion: "previous-disclaimer-version",
        actor: { id: REQUESTER_ID, role: "Participant" },
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).resolves.toBe(replayedResult);

    expect(execute).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(REQUESTER_ID, REQUEST_ID);
  });
});
