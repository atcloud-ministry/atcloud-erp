import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import type { NotificationOutboxDeliveryContext } from "../../../../src/services/reliability/NotificationOutboxDeliveryRegistry";
import type { ClaimedNotificationOutbox } from "../../../../src/services/reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  PermanentNotificationOutboxDeliveryError,
  RetryableNotificationOutboxDeliveryError,
} from "../../../../src/services/reliability/NotificationOutboxWorker";
import {
  ALUMNI_INVITATION_EMAIL_PAYLOAD_VERSION,
  ALUMNI_INVITATION_EMAIL_TOPIC,
  AlumniInvitationEmailDeliveryHandler,
  type AlumniInvitationEmailState,
} from "../../../../src/services/alumni/AlumniInvitationEmailDeliveryHandler";

const INVITATION_ID = "64f100000000000000000001";
const TOKEN = "t".repeat(43);
const TOKEN_HASH = "a".repeat(64);
const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  FRONTEND_URL: process.env.FRONTEND_URL,
};

function restore(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("NODE_ENV");
  restore("FRONTEND_URL");
  vi.restoreAllMocks();
});

function event(payload: unknown = { invitationId: INVITATION_ID, issueCount: 1 }) {
  return { payload } as ClaimedNotificationOutbox;
}

function context(): NotificationOutboxDeliveryContext {
  return {
    signal: new AbortController().signal,
    renewLease: vi.fn(),
  };
}

function invitation(
  overrides: Partial<AlumniInvitationEmailState> = {},
): AlumniInvitationEmailState {
  return {
    invitationId: INVITATION_ID,
    status: "active",
    issueCount: 1,
    issuedAt: new Date("2026-09-12T00:00:00.000Z"),
    tokenExpiresAt: new Date("2026-09-26T00:00:00.000Z"),
    tokenVersion: 1,
    tokenHash: TOKEN_HASH,
    contactEmail: "alumna@example.com",
    contactFirstName: "Amy",
    contactLastName: "Chen",
    contactPurgedAt: null,
    ...overrides,
  };
}

function handler(overrides: {
  state?: AlumniInvitationEmailState | null;
  sender?: { send: ReturnType<typeof vi.fn> };
  deriveToken?: () => string;
  tokenHashMatches?: () => boolean;
  runtimeReader?: {
    getOperationalRuntimeConfig: ReturnType<typeof vi.fn>;
  };
  releaseAvailable?: () => boolean;
} = {}) {
  const loadInvitation = vi.fn().mockResolvedValue(
    Object.prototype.hasOwnProperty.call(overrides, "state")
      ? overrides.state
      : invitation(),
  );
  const sender = overrides.sender ?? {
    send: vi.fn().mockResolvedValue(undefined),
  };
  const runtimeReader = overrides.runtimeReader ?? {
    getOperationalRuntimeConfig: vi
      .fn()
      .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
  };
  const deliveryHandler = new AlumniInvitationEmailDeliveryHandler({
    loadInvitation,
    sender,
    runtimeReader,
    releaseAvailable: overrides.releaseAvailable ?? (() => true),
    now: () => new Date("2026-09-13T00:00:00.000Z"),
    deriveToken: overrides.deriveToken ?? (() => TOKEN),
    tokenHashMatches: overrides.tokenHashMatches ?? (() => true),
  });
  return { deliveryHandler, loadInvitation, runtimeReader, sender };
}

describe("AlumniInvitationEmailDeliveryHandler", () => {
  it("registers one explicit versioned topic", () => {
    const { deliveryHandler } = handler();
    expect(deliveryHandler.topic).toBe(ALUMNI_INVITATION_EMAIL_TOPIC);
    expect(deliveryHandler.payloadVersion).toBe(
      ALUMNI_INVITATION_EMAIL_PAYLOAD_VERSION,
    );
  });

  it("allows claims only while the effective alumni runtime is writable", async () => {
    const { deliveryHandler, runtimeReader } = handler();

    await expect(
      deliveryHandler.canClaim(context().signal),
    ).resolves.toBe(true);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
  });

  it("short-circuits the deployment release ceiling before a Mongo runtime read", async () => {
    const releaseAvailable = vi.fn().mockReturnValue(false);
    const { deliveryHandler, runtimeReader, loadInvitation, sender } = handler({
      releaseAvailable,
    });

    await expect(
      deliveryHandler.canClaim(context().signal),
    ).resolves.toBe(false);

    expect(releaseAvailable).toHaveBeenCalledOnce();
    expect(runtimeReader.getOperationalRuntimeConfig).not.toHaveBeenCalled();
    expect(loadInvitation).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each(["off", "read_only"] as const)(
    "does not claim or inspect invitation data while runtime mode is %s",
    async (mode) => {
      const runtimeReader = {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO(mode, 2)),
      };
      const { deliveryHandler, loadInvitation, sender } = handler({
        runtimeReader,
      });

      await expect(
        deliveryHandler.canClaim(context().signal),
      ).resolves.toBe(false);
      await expect(
        deliveryHandler.assertCanDeliver(event(), context()),
      ).rejects.toBeInstanceOf(DeferredNotificationOutboxDeliveryError);
      expect(loadInvitation).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    },
  );

  it("fails closed without external I/O when runtime configuration cannot be read", async () => {
    const runtimeReader = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockRejectedValue(
          new Error("secret-and-private-recipient@example.com"),
        ),
    };
    const { deliveryHandler, loadInvitation, sender } = handler({
      runtimeReader,
    });

    await expect(
      deliveryHandler.canClaim(context().signal),
    ).resolves.toBe(false);
    let observed: unknown;
    try {
      await deliveryHandler.assertCanDeliver(event(), context());
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(DeferredNotificationOutboxDeliveryError);
    expect(observed).toMatchObject({ code: "ALUMNI_NETWORK_NOT_WRITABLE" });
    expect(JSON.stringify(observed)).not.toContain("private-recipient");
    expect(loadInvitation).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rechecks the kill switch immediately before SMTP and defers a mode flip", async () => {
    const runtimeReader = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValueOnce(createRuntimeConfigDTO("on", 1))
        .mockResolvedValueOnce(createRuntimeConfigDTO("on", 1))
        .mockResolvedValueOnce(createRuntimeConfigDTO("read_only", 2)),
    };
    const { deliveryHandler, loadInvitation, sender } = handler({
      runtimeReader,
    });

    await expect(
      deliveryHandler.canClaim(context().signal),
    ).resolves.toBe(true);
    await deliveryHandler.assertCanDeliver(event(), context());
    await expect(
      deliveryHandler.deliver(event(), context()),
    ).rejects.toMatchObject({
      code: "ALUMNI_NETWORK_NOT_WRITABLE",
    });

    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledTimes(3);
    expect(loadInvitation).toHaveBeenCalledTimes(2);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("reloads current state and sends the approved fragment-only claim URL", async () => {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://erp.example.org";
    const { deliveryHandler, loadInvitation, sender } = handler({
      state: invitation({ contactFirstName: "<Amy>" }),
    });

    await deliveryHandler.assertCanDeliver(event(), context());
    await deliveryHandler.deliver(event(), context());

    expect(loadInvitation).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledOnce();
    const options = sender.send.mock.calls[0][0];
    const expectedUrl =
      `https://erp.example.org/#/dashboard/community/alumni/me?invitation=${INVITATION_ID}&claim=${TOKEN}`;
    expect(options.to).toBe("alumna@example.com");
    expect(options.text).toContain(expectedUrl);
    expect(options.html).toContain(expectedUrl.replace("&", "&amp;"));
    expect(options.html).toContain("&lt;Amy&gt;");
    expect(JSON.stringify(event().payload)).not.toContain(TOKEN);
  });

  it.each([
    ["missing", null],
    ["reissued", invitation({ issueCount: 2 })],
    ["claimed", invitation({ status: "claimed" })],
    [
      "expired",
      invitation({ tokenExpiresAt: new Date("2026-09-13T00:00:00.000Z") }),
    ],
    ["purged", invitation({ contactPurgedAt: new Date() })],
  ])("permanently rejects a %s invitation event", async (_label, state) => {
    const { deliveryHandler, sender } = handler({ state });
    await expect(
      deliveryHandler.assertCanDeliver(event(), context()),
    ).rejects.toBeInstanceOf(PermanentNotificationOutboxDeliveryError);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("permanently rejects payload drift and token-hash mismatch", async () => {
    const invalidPayload = handler().deliveryHandler.assertCanDeliver(
      event({ invitationId: INVITATION_ID, issueCount: 1, token: TOKEN }),
      context(),
    );
    await expect(invalidPayload).rejects.toMatchObject({
      code: "ALUMNI_INVITATION_EVENT_INVALID",
    });

    const mismatch = handler({ tokenHashMatches: () => false });
    await expect(
      mismatch.deliveryHandler.assertCanDeliver(event(), context()),
    ).rejects.toMatchObject({ code: "ALUMNI_INVITATION_EVENT_STALE" });
  });

  it("treats missing crypto configuration as retryable", async () => {
    const { deliveryHandler } = handler({
      deriveToken: () => {
        throw new Error("secret-value-that-must-not-escape");
      },
    });
    await expect(
      deliveryHandler.assertCanDeliver(event(), context()),
    ).rejects.toMatchObject({
      code: "ALUMNI_INVITATION_SECURITY_UNAVAILABLE",
      message: "ALUMNI_INVITATION_SECURITY_UNAVAILABLE",
    });
  });

  it("turns transport failures into value-free retryable errors", async () => {
    const sender = {
      send: vi.fn().mockRejectedValue(
        new Error(`SMTP failed for alumna@example.com using ${TOKEN}`),
      ),
    };
    const { deliveryHandler } = handler({ sender });
    let observed: unknown;
    try {
      await deliveryHandler.deliver(event(), context());
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(RetryableNotificationOutboxDeliveryError);
    expect(observed).toMatchObject({
      code: "ALUMNI_INVITATION_EMAIL_SEND_FAILED",
    });
    expect(JSON.stringify(observed)).not.toContain("alumna@example.com");
    expect(JSON.stringify(observed)).not.toContain(TOKEN);
  });
});
