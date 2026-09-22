import { describe, expect, it, vi } from "vitest";
import { ExternalNotificationRouter } from "../../../../src/services/push/ExternalNotificationRouter";

const CHAT = Object.freeze({
  eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
  conversationId: "507f1f77bcf86cd799439011",
  messageId: "507f1f77bcf86cd799439015",
  recipientUserId: "507f1f77bcf86cd799439012",
  sequence: 4,
  authorizeRecipient: async () => true,
});
const HELP = Object.freeze({
  eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f6",
  requestId: "507f1f77bcf86cd799439013",
  requestRevision: 7,
  recipientUserId: "507f1f77bcf86cd799439012",
});

function pushResult(route: string) {
  return {
    route,
    attempted: route === "no_subscription" ? 0 : 1,
    succeeded: route === "delivered" ? 1 : 0,
    permanentFailures: route === "permanent_failure" ? 1 : 0,
    transientFailures: route === "transient_failure" ? 1 : 0,
  };
}

function setup(chatRoute = "delivered", helpRoute = "delivered") {
  const push = {
    deliverChatMessage: vi.fn().mockResolvedValue(pushResult(chatRoute)),
    deliverHelpNotification: vi.fn().mockResolvedValue(pushResult(helpRoute)),
  };
  const email = {
    sendChatFallback: vi.fn().mockResolvedValue("sent"),
    sendHelpFallback: vi.fn().mockResolvedValue("sent"),
  };
  const router = new ExternalNotificationRouter({
    push: push as never,
    email,
    badges: { totalForUser: vi.fn().mockResolvedValue(8) },
  });
  return { router, push, email };
}

describe("ExternalNotificationRouter", () => {
  it("uses the exact fixed SW payload and does not email after Push success", async () => {
    const { router, push, email } = setup();
    await expect(router.deliverChat(CHAT)).resolves.toMatchObject({ route: "push" });
    expect(push.deliverChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          title: "@Cloud Chat Rooms",
          body: "You have a new chat message.",
          tag: `chat-${CHAT.conversationId}`,
          deepLink: `/#/dashboard/chat-rooms/${CHAT.conversationId}`,
          badgeCount: 8,
        },
      }),
    );
    expect(Object.keys(push.deliverChatMessage.mock.calls[0][0].payload).sort()).toEqual(
      ["badgeCount", "body", "deepLink", "tag", "title"],
    );
    expect(email.sendChatFallback).not.toHaveBeenCalled();
  });

  it("uses fixed Program announcement Push and Email fallback routing", async () => {
    const { router, push, email } = setup("no_subscription");
    await expect(
      router.deliverChat({ ...CHAT, kind: "announcement" }),
    ).resolves.toMatchObject({ route: "email" });
    expect(push.deliverChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "@Cloud Program Announcement",
          body: "A new Program announcement is available.",
          deepLink: `/#/dashboard/chat-rooms/${CHAT.conversationId}`,
        }),
      }),
    );
    expect(email.sendChatFallback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "announcement" }),
    );
  });

  it.each(["push_disabled", "no_subscription", "permanent_failure"])(
    "falls back to email for %s",
    async (route) => {
      const { router, email } = setup(route);
      await expect(router.deliverChat(CHAT)).resolves.toMatchObject({ route: "email" });
      expect(email.sendChatFallback).toHaveBeenCalledTimes(1);
    },
  );

  it("skips both channels for Room mute", async () => {
    const { router, email } = setup("muted");
    await expect(router.deliverChat(CHAT)).resolves.toMatchObject({ route: "skipped" });
    expect(email.sendChatFallback).not.toHaveBeenCalled();
  });

  it("stops fallback when the provider-boundary authorization sees a revocation", async () => {
    let releaseBadge!: () => void;
    let badgeStarted!: () => void;
    const badgeBarrier = new Promise<void>((resolve) => {
      releaseBadge = resolve;
    });
    const badgeEntered = new Promise<void>((resolve) => {
      badgeStarted = resolve;
    });
    let authorized = true;
    const authorizeRecipient = vi.fn(async () => authorized);
    const push = {
      deliverChatMessage: vi.fn(async (input: {
        authorizeRecipient: () => Promise<boolean>;
      }) =>
        pushResult(
          (await input.authorizeRecipient())
            ? "delivered"
            : "recipient_unavailable",
        ),
      ),
      deliverHelpNotification: vi.fn(),
    };
    const email = {
      sendChatFallback: vi.fn(),
      sendHelpFallback: vi.fn(),
    };
    const router = new ExternalNotificationRouter({
      push: push as never,
      email: email as never,
      badges: {
        totalForUser: vi.fn(async () => {
          badgeStarted();
          await badgeBarrier;
          return 8;
        }),
      },
    });

    const delivery = router.deliverChat({ ...CHAT, authorizeRecipient });
    await badgeEntered;
    authorized = false;
    releaseBadge();

    await expect(delivery).resolves.toMatchObject({ route: "skipped" });
    expect(authorizeRecipient).toHaveBeenCalledTimes(1);
    expect(email.sendChatFallback).not.toHaveBeenCalled();
  });

  it("fails closed without Email fallback when final authorization cannot be read", async () => {
    const authorizationError = new Error("canonical database unavailable");
    const push = {
      deliverChatMessage: vi.fn(async (input: {
        authorizeRecipient: () => Promise<boolean>;
      }) => {
        await input.authorizeRecipient();
        return pushResult("delivered");
      }),
      deliverHelpNotification: vi.fn(),
    };
    const email = {
      sendChatFallback: vi.fn(),
      sendHelpFallback: vi.fn(),
    };
    const router = new ExternalNotificationRouter({
      push: push as never,
      email: email as never,
      badges: { totalForUser: vi.fn().mockResolvedValue(8) },
    });

    await expect(
      router.deliverChat({
        ...CHAT,
        authorizeRecipient: vi.fn().mockRejectedValue(authorizationError),
      }),
    ).rejects.toBe(authorizationError);
    expect(email.sendChatFallback).not.toHaveBeenCalled();
  });

  it("retries transient Push without email fallback", async () => {
    const { router, email } = setup("transient_failure");
    await expect(router.deliverChat(CHAT)).resolves.toMatchObject({ route: "retry" });
    expect(email.sendChatFallback).not.toHaveBeenCalled();
  });

  it("propagates SMTP failure so the durable handler can retry", async () => {
    const { router, email } = setup("no_subscription");
    email.sendChatFallback.mockRejectedValueOnce(new Error("SMTP unavailable"));
    await expect(router.deliverChat(CHAT)).rejects.toThrow("SMTP unavailable");
  });

  it("routes Help with its fixed authorized detail link and no email after Push success", async () => {
    const { router, push, email } = setup("delivered", "delivered");
    await expect(router.deliverHelp(HELP)).resolves.toMatchObject({ route: "push" });
    expect(push.deliverHelpNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: HELP.requestId,
        minimumRevision: HELP.requestRevision,
        payload: expect.objectContaining({
          deepLink: `/#/dashboard/community/help-requests/${HELP.requestId}`,
          badgeCount: 8,
        }),
      }),
    );
    expect(email.sendHelpFallback).not.toHaveBeenCalled();
  });

  it.each(["push_disabled", "no_subscription", "permanent_failure"])(
    "falls back to email for Help when Push reports %s",
    async (route) => {
      const { router, email } = setup("delivered", route);
      await expect(router.deliverHelp(HELP)).resolves.toMatchObject({
        route: "email",
      });
      expect(email.sendHelpFallback).toHaveBeenCalledTimes(1);
    },
  );

  it("retries transient Help Push without email fallback", async () => {
    const { router, email } = setup("delivered", "transient_failure");
    await expect(router.deliverHelp(HELP)).resolves.toMatchObject({
      route: "retry",
    });
    expect(email.sendHelpFallback).not.toHaveBeenCalled();
  });
});
