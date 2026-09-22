import { describe, expect, it, vi } from "vitest";
import AlumniHelpRequest from "../../../../src/models/AlumniHelpRequest";
import {
  AlumniHelpNotificationCountService,
  buildAlumniHelpNotificationFilter,
  hasUnreadHelpUpdate,
  helpUpdateMarkers,
} from "../../../../src/services/alumni/AlumniHelpNotificationCountService";

const USER_ID = "64f100000000000000000001";

describe("Alumni Help notification tracking", () => {
  it("tracks only the other party's update while acknowledging the actor's observed state", () => {
    expect(helpUpdateMarkers(0, "requester")).toEqual({ providerUpdateSequence: 1, requesterReadSequence: 1 });
    expect(helpUpdateMarkers(12, "provider")).toEqual({ requesterUpdateSequence: 13, providerReadSequence: 13 });
    expect(helpUpdateMarkers(13, null)).toEqual({ requesterUpdateSequence: 14, providerUpdateSequence: 14 });
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => helpUpdateMarkers(revision, "requester")).toThrow(TypeError);
    }
  });

  it("treats legacy missing markers as read, and separates participant receipts", () => {
    expect(hasUnreadHelpUpdate({} as never, "requester")).toBe(false);
    const markers = { requesterUpdateSequence: 4, requesterReadSequence: 2, providerUpdateSequence: 3, providerReadSequence: 3 };
    expect(hasUnreadHelpUpdate(markers, "requester")).toBe(true);
    expect(hasUnreadHelpUpdate(markers, "provider")).toBe(false);
  });

  it("rejects invalid query context and never returns invalid counts", async () => {
    expect(() => buildAlumniHelpNotificationFilter("invalid")).toThrow(TypeError);
    expect(() => buildAlumniHelpNotificationFilter(USER_ID, new Date(NaN))).toThrow(TypeError);
    const query = { option: vi.fn(), exec: vi.fn().mockResolvedValue([{ notifications: [{ count: -1 }], actions: [] }]) };
    const spy = vi.spyOn(AlumniHelpRequest, "aggregate").mockReturnValue(query as never);
    try {
      const service = new AlumniHelpNotificationCountService();
      await expect(service.countForUser(USER_ID)).rejects.toThrow("invalid value");
      query.exec.mockResolvedValue([{ notifications: [{ count: 4 }], actions: [] }]);
      const signal = new AbortController().signal;
      await expect(service.countForUser(USER_ID, signal)).resolves.toBe(4);
      expect(query.option).toHaveBeenCalledWith({ signal });
    } finally {
      spy.mockRestore();
    }
  });
});
