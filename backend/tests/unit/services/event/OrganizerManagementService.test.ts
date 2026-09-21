import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { IEvent } from "../../../../src/models/Event";

vi.mock("../../../../src/services/UserAssignmentSnapshotService", () => ({
  UserAssignmentSnapshotService: {
    resolveEventOrganizers: vi.fn(),
  },
}));

import { OrganizerManagementService } from "../../../../src/services/event/OrganizerManagementService";
import { UserAssignmentSnapshotService } from "../../../../src/services/UserAssignmentSnapshotService";

describe("OrganizerManagementService", () => {
  const service = new OrganizerManagementService();

  beforeEach(() => vi.clearAllMocks());

  it("tracks only persisted organizer user IDs", () => {
    const first = new Types.ObjectId();
    const second = new Types.ObjectId();
    const event = {
      organizerDetails: [
        { userId: first },
        { name: "No ID" },
        { userId: second.toString() },
      ],
    } as unknown as IEvent;
    expect(service.trackOldOrganizers(event)).toEqual([
      first.toString(),
      second.toString(),
    ]);
  });

  it("returns no tracked IDs when organizer details are absent", () => {
    expect(service.trackOldOrganizers({} as IEvent)).toEqual([]);
  });

  it("passes prior IDs so unchanged legacy assignments remain valid", async () => {
    const details = [{ userId: new Types.ObjectId().toString() }];
    const existing = [details[0].userId];
    vi.mocked(
      UserAssignmentSnapshotService.resolveEventOrganizers,
    ).mockResolvedValue([]);

    await service.normalizeOrganizerDetails(details, existing);

    expect(
      UserAssignmentSnapshotService.resolveEventOrganizers,
    ).toHaveBeenCalledWith(details, existing);
  });
});
