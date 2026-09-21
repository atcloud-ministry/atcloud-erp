import mongoose, { type ClientSession } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogService } from "../../../../src/services/AuditLogService";
import {
  CHAT_UNREAD_RECONCILIATION_CAPACITY,
  ChatUnreadReconciliationService,
  type ChatUnreadReconciliationRunContext,
} from "../../../../src/services/chat/ChatUnreadReconciliationService";
import {
  WORKER_CAPABILITIES,
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
} from "../../../../src/services/authorization/WorkerAuthorizationService";

const NOW = new Date("2032-09-12T12:00:00.000Z");
const MEMBER_ID = new mongoose.Types.ObjectId();
const ROOM_ID = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();
const session = {} as ClientSession;

function countQuery<T>(value: T) {
  const chain = {
    session: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  chain.session.mockReturnValue(chain);
  return chain;
}

function findQuery<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) };
}

function runContext(): ChatUnreadReconciliationRunContext {
  return Object.freeze({
    serviceKey: WORKER_SERVICE_KEYS.CHAT_UNREAD,
    runId: "550e8400-e29b-41d4-a716-446655440001",
    trigger: WORKER_RUN_TRIGGERS.SCHEDULED,
  });
}

function setup(options: {
  readonly storedUnread?: number;
  readonly exactUnread?: number;
  readonly updateModified?: number;
  readonly candidateCount?: number;
  readonly limit?: number;
} = {}) {
  const member = {
    _id: MEMBER_ID,
    conversationId: ROOM_ID,
    userId: USER_ID,
    role: "requester",
    status: "active",
    joinedAt: NOW,
    accessWindows: [
      {
        visibleFromSequence: 1,
        visibleThroughSequence: null,
        openedAt: NOW,
        closedAt: null,
      },
    ],
    lastReadSequence: 4,
    unreadCount: options.storedUnread ?? 9,
    unreadReconciledThroughSequence: 5,
    unreadReconciledAt: null,
    muted: false,
    mutedAt: null,
    purgeAt: null,
    revision: 3,
  };
  const conversation = {
    _id: ROOM_ID,
    kind: "alumni_help",
    status: "current",
    lastSequence: 7,
    purgeAt: null,
  };
  const memberModel = {
    aggregate: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(
        Array.from({ length: options.candidateCount ?? 1 }, () => ({
          _id: MEMBER_ID,
        })),
      ),
    }),
    findOne: vi.fn().mockReturnValue(findQuery(member)),
    updateOne: vi
      .fn()
      .mockResolvedValue({ modifiedCount: options.updateModified ?? 1 }),
  };
  const conversationModel = {
    findOne: vi.fn().mockReturnValue(findQuery(conversation)),
  };
  const messageModel = {
    countDocuments: vi
      .fn()
      .mockReturnValue(countQuery(options.exactUnread ?? 2)),
  };
  const transactions = {
    run: vi.fn(async (operation: (value: ClientSession) => Promise<unknown>) =>
      operation(session),
    ),
  };
  const authorization = { assertCapability: vi.fn().mockResolvedValue(undefined) };
  const service = new ChatUnreadReconciliationService({
    now: () => new Date(NOW),
    memberModel: memberModel as never,
    conversationModel: conversationModel as never,
    messageModel: messageModel as never,
    transactions,
    authorization: authorization as never,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return {
    service,
    member,
    memberModel,
    conversationModel,
    messageModel,
    transactions,
    authorization,
  };
}

describe("ChatUnreadReconciliationService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("authorizes a bounded worker run and repairs only the exact counter drift", async () => {
    const fixture = setup({ storedUnread: 9, exactUnread: 2 });
    const audit = vi
      .spyOn(AuditLogService, "recordRequiredInTransaction")
      .mockResolvedValue({} as never);

    await expect(fixture.service.runBounded(runContext())).resolves.toEqual({
      candidatesScanned: 1,
      reconciled: 1,
      corrected: 1,
      racedOrUnavailable: 0,
      hasMore: false,
      capacityPerRun: 500,
    });
    expect(fixture.authorization.assertCapability).toHaveBeenCalledWith(
      runContext(),
      WORKER_CAPABILITIES.CHAT_UNREAD_RECONCILE,
      { resource: { type: "chat_unread", id: "active-members" } },
    );
    expect(fixture.messageModel.countDocuments).toHaveBeenCalledWith({
      $and: expect.arrayContaining([
        { conversationId: ROOM_ID },
        { sequence: { $gt: 4 } },
        { senderId: { $ne: USER_ID } },
      ]),
    });
    expect(fixture.memberModel.updateOne).toHaveBeenCalledWith(
      { _id: MEMBER_ID, revision: 3, status: "active" },
      {
        $set: expect.objectContaining({
          unreadCount: 2,
          unreadReconciledThroughSequence: 7,
          unreadReconciledAt: NOW,
        }),
        $inc: { revision: 1 },
      },
      { session, runValidators: false },
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "chat.unread_reconciled",
        reasonCode: "counter_drift",
        details: expect.objectContaining({ fromCount: 9, toCount: 2 }),
      }),
      session,
    );
  });

  it("refreshes the reconciliation watermark without auditing an unchanged count", async () => {
    const fixture = setup({ storedUnread: 2, exactUnread: 2 });
    const audit = vi
      .spyOn(AuditLogService, "recordRequiredInTransaction")
      .mockResolvedValue({} as never);

    await expect(fixture.service.reconcileMember(MEMBER_ID)).resolves.toEqual({
      reconciled: true,
      corrected: false,
    });
    expect(fixture.memberModel.updateOne).toHaveBeenCalledOnce();
    expect(audit).not.toHaveBeenCalled();
  });

  it("reports a CAS race without claiming that drift was repaired", async () => {
    const fixture = setup({ storedUnread: 9, exactUnread: 2, updateModified: 0 });
    const audit = vi
      .spyOn(AuditLogService, "recordRequiredInTransaction")
      .mockResolvedValue({} as never);

    await expect(fixture.service.reconcileMember(MEMBER_ID)).resolves.toEqual({
      reconciled: false,
      corrected: false,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("caps each run, exposes backlog, and meets the 10,000-member 20-hour baseline", async () => {
    const fixture = setup({ candidateCount: 4, limit: 3 });
    vi.spyOn(fixture.service, "reconcileMember").mockResolvedValue({
      reconciled: true,
      corrected: false,
    });

    await expect(fixture.service.runBounded(runContext())).resolves.toEqual({
      candidatesScanned: 3,
      reconciled: 3,
      corrected: 0,
      racedOrUnavailable: 0,
      hasMore: true,
      capacityPerRun: 3,
    });
    const pipeline = fixture.memberModel.aggregate.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(pipeline).toEqual(expect.arrayContaining([{ $limit: 4 }]));
    expect(
      Math.ceil(
        CHAT_UNREAD_RECONCILIATION_CAPACITY.baselineActiveMembers /
          CHAT_UNREAD_RECONCILIATION_CAPACITY.defaultLimit,
      ),
    ).toBe(CHAT_UNREAD_RECONCILIATION_CAPACITY.baselineMaximumSweepHours);
  });
});
