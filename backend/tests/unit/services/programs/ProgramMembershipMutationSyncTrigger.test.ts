import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import {
  PROGRAM_MEMBERSHIP_TRIGGER_MAX_CONCURRENT_SCOPES,
  ProgramMembershipMutationSyncTrigger,
} from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

const PROGRAM_ID = new mongoose.Types.ObjectId("64f000000000000000000001");
const PROGRAM_B = new mongoose.Types.ObjectId("64f000000000000000000002");
const PROGRAM_C = new mongoose.Types.ObjectId("64f000000000000000000003");
const PROGRAM_D = new mongoose.Types.ObjectId("64f000000000000000000004");
const USER_ID = new mongoose.Types.ObjectId("64f000000000000000000011");

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ProgramMembershipMutationSyncTrigger", () => {
  let sync: {
    programAssignmentsChanged: ReturnType<typeof vi.fn>;
    programPurchaseChanged: ReturnType<typeof vi.fn>;
    userEligibilityChanged: ReturnType<typeof vi.fn>;
    communitySettingsChanged: ReturnType<typeof vi.fn>;
  };
  let logger: { error: ReturnType<typeof vi.fn> };
  let runtimeReader: { getOperationalRuntimeConfig: ReturnType<typeof vi.fn> };
  let trigger: ProgramMembershipMutationSyncTrigger;

  beforeEach(() => {
    sync = {
      programAssignmentsChanged: vi.fn().mockResolvedValue(undefined),
      programPurchaseChanged: vi.fn().mockResolvedValue(undefined),
      userEligibilityChanged: vi.fn().mockResolvedValue(undefined),
      communitySettingsChanged: vi.fn().mockResolvedValue(undefined),
    };
    logger = { error: vi.fn() };
    runtimeReader = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
    };
    trigger = new ProgramMembershipMutationSyncTrigger({
      sync: sync as any,
      logger: logger as any,
      runtimeReader,
    });
  });

  function totalSyncCalls(): number {
    return (
      sync.programAssignmentsChanged.mock.calls.length +
      sync.programPurchaseChanged.mock.calls.length +
      sync.userEligibilityChanged.mock.calls.length +
      sync.communitySettingsChanged.mock.calls.length
    );
  }

  it("defers every canonical mutation hint with its context", async () => {
    const context = {
      actor: { type: "system" as const, key: "test" },
      source: "system" as const,
      correlationId: "correlation-1",
    };

    trigger.programAssignmentsChanged(PROGRAM_ID, context);
    trigger.programPurchaseChanged(
      { purchaseType: "program", programId: PROGRAM_B },
      context,
    );
    trigger.userEligibilityChanged(USER_ID, context);
    trigger.communitySettingsChanged(PROGRAM_C, context);

    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledWith(
        PROGRAM_ID,
        expect.objectContaining(context),
      );
      expect(sync.programPurchaseChanged).toHaveBeenCalledWith(
        { purchaseType: "program", programId: PROGRAM_B },
        expect.objectContaining(context),
      );
      expect(sync.userEligibilityChanged).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining(context),
      );
      expect(sync.communitySettingsChanged).toHaveBeenCalledWith(
        PROGRAM_C,
        expect.objectContaining(context),
      );
    });
    for (const call of [
      sync.programAssignmentsChanged,
      sync.programPurchaseChanged,
      sync.userEligibilityChanged,
      sync.communitySettingsChanged,
    ]) {
      expect(call.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ runtimePermit: expect.any(Object) }),
      );
    }
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("coalesces 100 same-Program hints in one event-loop burst into one pass", async () => {
    for (let index = 0; index < 100; index += 1) {
      const context = { correlationId: `burst-${index}` };
      if (index % 3 === 0) {
        trigger.programAssignmentsChanged(PROGRAM_ID, context);
      } else if (index % 3 === 1) {
        trigger.programPurchaseChanged(
          { purchaseType: "program", programId: PROGRAM_ID },
          context,
        );
      } else {
        trigger.communitySettingsChanged(PROGRAM_ID, context);
      }
    }

    await vi.waitFor(() => expect(totalSyncCalls()).toBe(1));

    expect(sync.programAssignmentsChanged).toHaveBeenCalledWith(
      PROGRAM_ID,
      expect.objectContaining({
        correlationId: "burst-99",
        runtimePermit: expect.any(Object),
      }),
    );
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("coalesces repeated user eligibility hints by user scope", async () => {
    for (let index = 0; index < 100; index += 1) {
      trigger.userEligibilityChanged(USER_ID, {
        correlationId: `user-burst-${index}`,
      });
    }

    await vi.waitFor(() => {
      expect(sync.userEligibilityChanged).toHaveBeenCalledOnce();
    });
    expect(sync.userEligibilityChanged).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ correlationId: "user-burst-99" }),
    );
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("runs one dirty follow-up with the latest Program hint and never overlaps the same scope", async () => {
    const firstPass = deferred();
    let active = 0;
    let maximumActive = 0;
    const execute = async (blocker: Promise<void>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await blocker;
      active -= 1;
    };
    sync.programAssignmentsChanged.mockImplementation(() =>
      execute(firstPass.promise),
    );
    sync.communitySettingsChanged.mockImplementation(() =>
      execute(Promise.resolve()),
    );

    trigger.programAssignmentsChanged(PROGRAM_ID, {
      correlationId: "first-pass",
    });
    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledOnce();
    });

    for (let index = 0; index < 100; index += 1) {
      trigger.communitySettingsChanged(PROGRAM_ID, {
        correlationId: `dirty-${index}`,
      });
    }
    expect(sync.communitySettingsChanged).not.toHaveBeenCalled();
    firstPass.resolve();

    await vi.waitFor(() => {
      expect(sync.communitySettingsChanged).toHaveBeenCalledOnce();
    });
    expect(sync.communitySettingsChanged).toHaveBeenCalledWith(
      PROGRAM_ID,
      expect.objectContaining({ correlationId: "dirty-99" }),
    );
    expect(totalSyncCalls()).toBe(2);
    expect(maximumActive).toBe(1);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledTimes(2);
  });

  it("requeues a third wave that arrives while the second pass is running", async () => {
    const firstPass = deferred();
    const secondPass = deferred();
    let invocation = 0;
    let active = 0;
    let maximumActive = 0;
    sync.programAssignmentsChanged.mockImplementation(async () => {
      invocation += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (invocation === 1) await firstPass.promise;
      if (invocation === 2) await secondPass.promise;
      active -= 1;
    });

    trigger.programAssignmentsChanged(PROGRAM_ID, {
      correlationId: "wave-1",
    });
    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledTimes(1);
    });

    trigger.programAssignmentsChanged(PROGRAM_ID, {
      correlationId: "wave-2",
    });
    firstPass.resolve();
    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledTimes(2);
    });

    trigger.programAssignmentsChanged(PROGRAM_ID, {
      correlationId: "wave-3",
    });
    secondPass.resolve();
    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledTimes(3);
    });

    expect(sync.programAssignmentsChanged.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ correlationId: "wave-3" }),
    );
    expect(maximumActive).toBe(1);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledTimes(3);
  });

  it("limits a cross-scope burst to two concurrent synchronizations", async () => {
    expect(PROGRAM_MEMBERSHIP_TRIGGER_MAX_CONCURRENT_SCOPES).toBe(2);
    const blockers = [deferred(), deferred(), deferred(), deferred()];
    let nextBlocker = 0;
    let active = 0;
    let maximumActive = 0;
    sync.programAssignmentsChanged.mockImplementation(async () => {
      const blocker = blockers[nextBlocker];
      nextBlocker += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await blocker?.promise;
      active -= 1;
    });

    for (const programId of [PROGRAM_ID, PROGRAM_B, PROGRAM_C, PROGRAM_D]) {
      trigger.programAssignmentsChanged(programId);
    }

    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledTimes(2);
    });
    expect(maximumActive).toBe(2);
    blockers[0]?.resolve();
    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledTimes(3);
    });
    expect(maximumActive).toBe(2);
    blockers[1]?.resolve();
    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledTimes(4);
    });
    expect(maximumActive).toBe(2);
    blockers[2]?.resolve();
    blockers[3]?.resolve();
    await vi.waitFor(() => expect(active).toBe(0));
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledTimes(4);
  });

  it.each(["off", "read_only"] as const)(
    "drops mutation hints without starting sync while Alumni runtime is %s",
    async (mode) => {
      runtimeReader.getOperationalRuntimeConfig.mockResolvedValue(
        createRuntimeConfigDTO(mode, 2),
      );

      for (let index = 0; index < 100; index += 1) {
        trigger.programAssignmentsChanged(PROGRAM_ID);
      }

      await vi.waitFor(() => {
        expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
      });
      expect(sync.programAssignmentsChanged).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it("fails closed without reporting a sync failure when runtime configuration is unavailable", async () => {
    runtimeReader.getOperationalRuntimeConfig.mockRejectedValue(
      new Error("runtime unavailable"),
    );

    for (let index = 0; index < 100; index += 1) {
      trigger.userEligibilityChanged(USER_ID);
    }

    await vi.waitFor(() => {
      expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
    });
    expect(sync.userEligibilityChanged).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("ignores purchase changes that cannot affect a Program room", async () => {
    trigger.programPurchaseChanged({
      purchaseType: "event",
      programId: PROGRAM_ID,
    });
    trigger.programPurchaseChanged({
      purchaseType: "membership",
      programId: PROGRAM_ID,
    });
    trigger.programPurchaseChanged({ purchaseType: "program" });

    await Promise.resolve();

    expect(sync.programPurchaseChanged).not.toHaveBeenCalled();
  });

  it("observes rejected background work and records its scope", async () => {
    const error = new Error("database unavailable");
    sync.programAssignmentsChanged.mockRejectedValueOnce(error);

    expect(() => trigger.programAssignmentsChanged(PROGRAM_ID)).not.toThrow();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        "Deferred Program membership synchronization failed",
        error,
        "ProgramMembershipMutationSync",
        {
          trigger: "program_assignments_changed",
          scopeId: PROGRAM_ID.toString(),
        },
      );
    });
  });

  it("observes synchronous adapter failures without escaping the mutation path", async () => {
    sync.userEligibilityChanged.mockImplementationOnce(() => {
      throw "adapter failed";
    });

    expect(() => trigger.userEligibilityChanged(USER_ID)).not.toThrow();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
    expect(logger.error.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        name: "Error",
        message: "Unknown Program membership synchronization error.",
      }),
    );
    expect(logger.error.mock.calls[0]?.[3]).toEqual({
      trigger: "user_eligibility_changed",
      scopeId: USER_ID.toString(),
    });
  });

  it("continues draining queued scopes even when sync and logging both fail", async () => {
    sync.programAssignmentsChanged
      .mockRejectedValueOnce(new Error("sync failed"))
      .mockResolvedValue(undefined);
    logger.error.mockImplementation(() => {
      throw new Error("logger failed");
    });

    expect(() => {
      trigger.programAssignmentsChanged(PROGRAM_ID);
      trigger.programAssignmentsChanged(PROGRAM_B);
      trigger.programAssignmentsChanged(PROGRAM_C);
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(sync.programAssignmentsChanged).toHaveBeenCalledTimes(3);
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
