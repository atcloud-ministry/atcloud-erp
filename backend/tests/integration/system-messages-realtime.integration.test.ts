import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/app";
import { socketService } from "../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../src/services/infrastructure/CacheService";
import User from "../../src/models/User";
import Message from "../../src/models/Message";

const FORBIDDEN_REALTIME_KEYS = new Set([
  "_id",
  "__v",
  "createdBy",
  "userStates",
  "targetRoles",
  "recipients",
  "recipientIds",
  "targetUserIds",
]);

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  Object.entries(value).forEach(([key, entry]) => {
    keys.add(key);
    collectKeys(entry, keys);
  });
  return keys;
}

describe("System Messages realtime emission", () => {
  const emitSpy = vi.spyOn(socketService, "emitSystemMessageUpdate");
  const invalidateUserCacheSpy = vi.spyOn(
    CachePatterns,
    "invalidateUserCache",
  );

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Message.deleteMany({})]);
    emitSpy.mockClear();
    invalidateUserCacheSpy.mockClear();
  });

  afterEach(() => {
    emitSpy.mockClear();
    invalidateUserCacheSpy.mockClear();
  });

  it.each(["Participant", "Guest Expert", "Leader"] as const)(
    "denies %s before storing, caching, or emitting a system message",
    async (role) => {
      const slug = role.toLowerCase().replace(/\s+/g, "_");
      const username =
        role === "Participant"
          ? "rt_denied_part"
          : role === "Guest Expert"
            ? "rt_denied_guest"
            : "rt_denied_leader";
      const user = await User.create({
        email: `rt_denied_${slug}@example.com`,
        username,
        firstName: "Denied",
        lastName: role,
        password: "Password123!",
        role,
        isActive: true,
        isVerified: true,
        gender: "male",
      } as any);

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: user.email, password: "Password123!" });
      expect(loginRes.status).toBe(200);
      const token = loginRes.body?.data?.accessToken as string;
      emitSpy.mockClear();
      invalidateUserCacheSpy.mockClear();

      const response = await request(app)
        .post("/api/notifications/system")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: `Denied ${role} message`,
          content: "This message must not create any business side effects.",
          type: "announcement",
          priority: "medium",
        });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(
        await Message.countDocuments({ title: `Denied ${role} message` }),
      ).toBe(0);
      expect(invalidateUserCacheSpy).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
    },
  );

  it("emits system_message_update when admin creates a broadcast system message", async () => {
    const admin = await User.create({
      email: "rt_admin@example.com",
      username: "rt_admin",
      firstName: "Admin",
      lastName: "User",
      password: "Password123!",
      role: "Administrator",
      isActive: true,
      isVerified: true,
      gender: "male",
    } as any);

    await User.create({
      email: "rt_user@example.com",
      username: "rt_user",
      firstName: "Real",
      lastName: "Time",
      password: "Password123!",
      role: "Participant",
      isActive: true,
      isVerified: true,
      gender: "male",
    } as any);

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: admin.email, password: "Password123!" });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body?.data?.accessToken as string;

    const res = await request(app)
      .post("/api/notifications/system")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "RT Test",
        content: "Realtime check",
        type: "announcement",
        priority: "medium",
        hideCreator: true,
      });

    expect(res.status).toBe(201);
    expect(emitSpy).toHaveBeenCalled();
    emitSpy.mock.calls.forEach(([, event, payload]) => {
      expect(event).toBe("message_created");
      expect(payload.message).not.toHaveProperty("creator");
      const keys = collectKeys(payload);
      FORBIDDEN_REALTIME_KEYS.forEach((key) =>
        expect(keys.has(key), key).toBe(false),
      );
    });
  });

  it("rejects malformed recipient selectors without storing or emitting a message", async () => {
    const admin = await User.create({
      email: "rt_selector_admin@example.com",
      username: "rt_selector_admin",
      firstName: "Admin",
      lastName: "Selector",
      password: "Password123!",
      role: "Administrator",
      isActive: true,
      isVerified: true,
      gender: "male",
    } as any);
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: admin.email, password: "Password123!" });
    const token = loginRes.body?.data?.accessToken as string;
    emitSpy.mockClear();

    const malformedSelectors = [
      { targetRoles: "Participant" },
      { targetRoles: null },
      { targetRoles: [] },
      { targetRoles: ["Not a role"] },
      { excludeUserIds: "507f1f77bcf86cd799439011" },
      { excludeUserIds: ["not-an-object-id"] },
    ];

    for (const selectors of malformedSelectors) {
      const response = await request(app)
        .post("/api/notifications/system")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Invalid selector message",
          content: "This message must never be stored or emitted.",
          type: "announcement",
          priority: "medium",
          ...selectors,
        });

      expect(response.status).toBe(400);
    }

    expect(
      await Message.countDocuments({ title: "Invalid selector message" }),
    ).toBe(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("canonicalizes uppercase excluded-user IDs before selecting recipients", async () => {
    const admin = await User.create({
      email: "rt_exclusion_admin@example.com",
      username: "rt_exclusion_admin",
      firstName: "Admin",
      lastName: "Exclusion",
      password: "Password123!",
      role: "Administrator",
      isActive: true,
      isVerified: true,
      gender: "male",
    } as any);
    const includedUser = await User.create({
      email: "rt_included@example.com",
      username: "rt_included",
      firstName: "Included",
      lastName: "User",
      password: "Password123!",
      role: "Participant",
      isActive: true,
      isVerified: true,
      gender: "female",
    } as any);
    const excludedUser = await User.create({
      email: "rt_excluded@example.com",
      username: "rt_excluded",
      firstName: "Excluded",
      lastName: "User",
      password: "Password123!",
      role: "Participant",
      isActive: true,
      isVerified: true,
      gender: "male",
    } as any);
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: admin.email, password: "Password123!" });
    const token = loginRes.body?.data?.accessToken as string;
    emitSpy.mockClear();

    const response = await request(app)
      .post("/api/notifications/system")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Canonical exclusion test",
        content: "Only the included participant should receive this message.",
        type: "announcement",
        priority: "medium",
        targetRoles: ["Participant"],
        excludeUserIds: [excludedUser._id.toString().toUpperCase()],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.message.recipientCount).toBe(1);
    const storedMessage = await Message.findOne({
      title: "Canonical exclusion test",
    });
    expect(storedMessage?.userStates.has(includedUser._id.toString())).toBe(true);
    expect(storedMessage?.userStates.has(excludedUser._id.toString())).toBe(
      false,
    );
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      includedUser._id.toString(),
      "message_created",
      expect.any(Object),
    );
  });
});
