import mongoose, { type ClientSession } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlumniHelpRoomGraceExpiryService,
  type AlumniHelpRoomGraceExpiryRunContext,
} from "../../../../src/services/alumni/AlumniHelpRoomGraceExpiryService";
import {
  WORKER_CAPABILITIES,
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
} from "../../../../src/services/authorization/WorkerAuthorizationService";

const NOW = new Date("2032-09-12T12:00:00.000Z");
const ROOM_ID = new mongoose.Types.ObjectId();
const REQUEST_ID = new mongoose.Types.ObjectId();
const DEADLINE = new Date("2032-09-12T11:59:00.000Z");
const session = {} as ClientSession;

function runContext(): AlumniHelpRoomGraceExpiryRunContext {
  return {
    source: "worker",
    runId: "550e8400-e29b-41d4-a716-446655440002",
    trigger: WORKER_RUN_TRIGGERS.SCHEDULED,
    principal: {
      kind: "service",
      serviceKey: WORKER_SERVICE_KEYS.ALUMNI_HELP_ROOM_GRACE,
      capabilities: [WORKER_CAPABILITIES.ALUMNI_HELP_ROOM_GRACE_ARCHIVE],
      runId: "550e8400-e29b-41d4-a716-446655440002",
    },
  };
}

function findOneQuery<T>(value: T) {
  const chain = {
    session: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  chain.session.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

function candidateQuery<T>(value: T) {
  const chain = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  chain.select.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

function setup(options: {
  readonly candidateCount?: number;
  readonly remainingOverdue?: number;
  readonly room?: Record<string, unknown> | null;
  readonly limit?: number;
} = {}) {
  const candidate = {
    _id: ROOM_ID,
    revision: 4,
    helpRequestId: REQUEST_ID,
    writeAccessEndsAt: DEADLINE,
  };
  const room = options.room === undefined
    ? {
        ...candidate,
        kind: "alumni_help",
        status: "current",
      }
    : options.room;
  const candidates = Array.from(
    { length: options.candidateCount ?? 1 },
    () => candidate,
  );
  const find = candidateQuery(candidates);
  const conversationModel = {
    find: vi.fn().mockReturnValue(find),
    findOne: vi.fn().mockReturnValue(findOneQuery(room)),
    countDocuments: vi.fn().mockResolvedValue(options.remainingOverdue ?? 0),
  };
  const transactions = {
    run: vi.fn(async (operation: (value: ClientSession) => Promise<unknown>) =>
      operation(session),
    ),
  };
  const authorization = { assertCapability: vi.fn().mockResolvedValue(undefined) };
  const audit = { recordRequiredInTransaction: vi.fn().mockResolvedValue({}) };
  const roomProvisioner = { archiveInTransaction: vi.fn().mockResolvedValue(undefined) };
  const service = new AlumniHelpRoomGraceExpiryService({
    now: () => new Date(NOW),
    conversationModel: conversationModel as never,
    transactions,
    authorization: authorization as never,
    audit: audit as never,
    roomProvisioner: roomProvisioner as never,
    ...(options.limit === undefined ? {} : { maxCandidates: options.limit }),
  });
  return {
    service,
    conversationModel,
    transactions,
    authorization,
    audit,
    roomProvisioner,
  };
}

describe("AlumniHelpRoomGraceExpiryService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("archives an expired current Help Room at its fixed deadline and writes the worker audit", async () => {
    const fixture = setup();

    await expect(fixture.service.runBounded(runContext())).resolves.toEqual({
      candidatesScanned: 1,
      archived: 1,
      racedOrUnavailable: 0,
      remainingOverdue: 0,
    });

    expect(fixture.authorization.assertCapability).toHaveBeenCalledWith(
      runContext(),
      WORKER_CAPABILITIES.ALUMNI_HELP_ROOM_GRACE_ARCHIVE,
      { resource: { type: "alumni_help_room", id: "expired-grace-periods" } },
    );
    expect(fixture.conversationModel.find).toHaveBeenCalledWith({
      kind: "alumni_help",
      status: "current",
      writeAccessEndsAt: { $lte: NOW },
    });
    expect(fixture.roomProvisioner.archiveInTransaction).toHaveBeenCalledWith({
      conversationId: ROOM_ID,
      helpRequestId: REQUEST_ID,
      archivedAt: DEADLINE,
      session,
    });
    expect(fixture.audit.recordRequiredInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "alumni_help.room_grace_expired",
        actor: {
          type: "worker",
          key: WORKER_SERVICE_KEYS.ALUMNI_HELP_ROOM_GRACE,
        },
        reasonCode: "grace_period_elapsed",
        details: expect.objectContaining({
          helpRequestId: REQUEST_ID.toString(),
          writeAccessEndedAt: DEADLINE.toISOString(),
        }),
      }),
      session,
    );
  });

  it("leaves a raced or no-longer-current candidate untouched for a later bounded tick", async () => {
    const fixture = setup({ room: null, remainingOverdue: 1 });

    await expect(fixture.service.runBounded(runContext())).resolves.toEqual({
      candidatesScanned: 1,
      archived: 0,
      racedOrUnavailable: 1,
      remainingOverdue: 1,
    });
    expect(fixture.roomProvisioner.archiveInTransaction).not.toHaveBeenCalled();
    expect(fixture.audit.recordRequiredInTransaction).not.toHaveBeenCalled();
  });

  it("uses the configured bounded limit and reports the remaining backlog", async () => {
    const fixture = setup({ candidateCount: 1, remainingOverdue: 2, limit: 1 });

    await expect(fixture.service.runBounded(runContext())).resolves.toEqual({
      candidatesScanned: 1,
      archived: 1,
      racedOrUnavailable: 0,
      remainingOverdue: 2,
    });
    const query = fixture.conversationModel.find.mock.results[0]?.value as {
      limit: ReturnType<typeof vi.fn>;
    };
    expect(query.limit).toHaveBeenCalledWith(1);
  });
});
