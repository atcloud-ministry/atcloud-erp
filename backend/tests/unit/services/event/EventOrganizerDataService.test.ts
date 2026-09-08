import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/UserAssignmentSnapshotService", () => ({
  UserAssignmentSnapshotService: {
    resolveEventOrganizers: vi.fn(),
  },
}));

import { EventOrganizerDataService } from "../../../../src/services/event/EventOrganizerDataService";
import { UserAssignmentSnapshotService } from "../../../../src/services/UserAssignmentSnapshotService";

describe("EventOrganizerDataService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses an empty authoritative assignment set when details are absent", async () => {
    vi.mocked(
      UserAssignmentSnapshotService.resolveEventOrganizers,
    ).mockResolvedValue([]);
    await expect(
      EventOrganizerDataService.processOrganizerDetails(undefined),
    ).resolves.toEqual([]);
    expect(
      UserAssignmentSnapshotService.resolveEventOrganizers,
    ).toHaveBeenCalledWith([]);
  });

  it("delegates supplied IDs to authoritative snapshot resolution", async () => {
    const input = [
      {
        userId: "507f191e810c19729de860ea",
        name: "Client-supplied name",
      },
    ];
    const resolved = [
      {
        userId: input[0].userId,
        name: "Canonical Name",
        email: "placeholder@example.com",
        phone: "Phone not provided",
      },
    ];
    vi.mocked(
      UserAssignmentSnapshotService.resolveEventOrganizers,
    ).mockResolvedValue(resolved);

    await expect(
      EventOrganizerDataService.processOrganizerDetails(input),
    ).resolves.toEqual(resolved);
    expect(
      UserAssignmentSnapshotService.resolveEventOrganizers,
    ).toHaveBeenCalledWith(input);
  });
});
