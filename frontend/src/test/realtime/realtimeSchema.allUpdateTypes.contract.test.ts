import { describe, it, expect } from "vitest";
import type { EventUpdate } from "../../types/realtime";

// Contract test: ensure our discriminated union accepts all defined updateTypes
// with their minimal payload shapes. This is primarily a compile-time check; we
// include a couple of runtime assertions to keep the test visible in reports.

describe("Realtime schema: all updateTypes compile against union", () => {
  it("accepts minimal shapes for each updateType", () => {
    const samples: EventUpdate[] = [
      // Guest updates
      {
        eventId: "e1",
        updateType: "guest_registration",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "guest_cancellation",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "guest_updated",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "guest_moved",
        data: null,
        timestamp: new Date().toISOString(),
      },

      // User updates
      {
        eventId: "e1",
        updateType: "user_signed_up",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "user_cancelled",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "user_removed",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "user_moved",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "user_assigned",
        data: null,
        timestamp: new Date().toISOString(),
      },

      // Workshop topic update
      {
        eventId: "e1",
        updateType: "workshop_topic_updated",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "attendance_updated",
        data: null,
        timestamp: new Date().toISOString(),
      },

      // Role capacity updates
      {
        eventId: "e1",
        updateType: "role_full",
        data: null,
        timestamp: new Date().toISOString(),
      },
      {
        eventId: "e1",
        updateType: "role_available",
        data: null,
        timestamp: new Date().toISOString(),
      },
    ];

    expect(Array.isArray(samples)).toBe(true);
    expect(samples).toHaveLength(13);

    // Order-agnostic assertion: ensure we cover exactly the expected update types
    const updateTypes = samples.map((s) => s.updateType).sort();
    const expected = [
      "guest_registration",
      "guest_cancellation",
      "guest_updated",
      "guest_moved",
      "user_signed_up",
      "user_cancelled",
      "user_removed",
      "user_moved",
      "user_assigned",
      "workshop_topic_updated",
      "attendance_updated",
      "role_full",
      "role_available",
    ].sort();

    expect(updateTypes).toEqual(expected);
  });
});
