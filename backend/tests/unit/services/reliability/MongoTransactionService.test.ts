import type { ClientSession, Connection } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  MongoTransactionCommitUncertainError,
  MongoTransactionRetryExhaustedError,
  MongoTransactionService,
  MongoTransactionUnavailableError,
  MongoTransactionUsageError,
  hasMongoErrorLabel,
  inspectMongoTransactionTopology,
} from "../../../../src/services/reliability/MongoTransactionService";

function labeledError(message: string, ...labels: string[]) {
  return Object.assign(new Error(message), { errorLabels: labels });
}

function createSession(params: {
  commitErrors?: Error[];
} = {}) {
  let inTransaction = false;
  const commitErrors = [...(params.commitErrors ?? [])];
  const startTransaction = vi.fn(() => {
    inTransaction = true;
  });
  const commitTransaction = vi.fn(async () => {
    const error = commitErrors.shift();
    if (error) throw error;
    inTransaction = false;
  });
  const abortTransaction = vi.fn(async () => {
    inTransaction = false;
  });
  const endSession = vi.fn(async () => undefined);
  const session = {
    startTransaction,
    commitTransaction,
    abortTransaction,
    endSession,
    inTransaction: vi.fn(() => inTransaction),
  } as unknown as ClientSession;
  return {
    session,
    startTransaction,
    commitTransaction,
    abortTransaction,
    endSession,
  };
}

function createConnection(
  sessions: ClientSession[],
  hello: Record<string, unknown> = {
    setName: "rs0",
    maxWireVersion: 21,
    logicalSessionTimeoutMinutes: 30,
  },
) {
  const command = vi.fn().mockResolvedValue(hello);
  const startSession = vi.fn(async () => {
    const session = sessions.shift();
    if (!session) throw new Error("No fake session available");
    return session;
  });
  const connection = {
    db: { admin: () => ({ command }) },
    startSession,
  } as unknown as Connection;
  return { connection, command, startSession };
}

describe("MongoTransactionService", () => {
  describe("topology capability", () => {
    it("accepts supported replica-set and sharded deployments", () => {
      expect(
        inspectMongoTransactionTopology({
          setName: "atlas-rs",
          maxWireVersion: 21,
          logicalSessionTimeoutMinutes: 30,
        }),
      ).toMatchObject({ supported: true, topology: "replica_set" });
      expect(
        inspectMongoTransactionTopology({
          msg: "isdbgrid",
          maxWireVersion: 21,
          logicalSessionTimeoutMinutes: 30,
        }),
      ).toMatchObject({ supported: true, topology: "sharded" });
    });

    it("rejects standalone, sessionless, and obsolete deployments", () => {
      expect(
        inspectMongoTransactionTopology({
          maxWireVersion: 21,
          logicalSessionTimeoutMinutes: 30,
        }),
      ).toMatchObject({ supported: false, topology: "standalone" });
      expect(
        inspectMongoTransactionTopology({ setName: "rs0", maxWireVersion: 21 }),
      ).toMatchObject({ supported: false });
      expect(
        inspectMongoTransactionTopology({
          setName: "rs0",
          maxWireVersion: 6,
          logicalSessionTimeoutMinutes: 30,
        }),
      ).toMatchObject({ supported: false });
    });

    it("fails closed before opening a session on standalone MongoDB", async () => {
      const { session } = createSession();
      const { connection, startSession } = createConnection([session], {
        maxWireVersion: 21,
        logicalSessionTimeoutMinutes: 30,
      });
      const service = new MongoTransactionService(connection);

      await expect(service.run(async () => "never")).rejects.toBeInstanceOf(
        MongoTransactionUnavailableError,
      );
      expect(startSession).not.toHaveBeenCalled();
    });

    it("does not silently continue when topology inspection fails", async () => {
      const { session } = createSession();
      const { connection, command, startSession } = createConnection([session]);
      command.mockRejectedValueOnce(new Error("hello unavailable"));
      const service = new MongoTransactionService(connection);

      await expect(service.run(async () => "never")).rejects.toMatchObject({
        code: "MONGO_TRANSACTIONS_UNAVAILABLE",
      });
      expect(startSession).not.toHaveBeenCalled();
    });
  });

  describe("transaction lifecycle", () => {
    it("passes an explicit session and commits with durable defaults", async () => {
      const controls = createSession();
      const { connection } = createConnection([controls.session]);
      const service = new MongoTransactionService(connection);
      const operation = vi.fn(async (session, context) => {
        expect(session).toBe(controls.session);
        expect(context).toEqual({ attempt: 1, maxAttempts: 3 });
        return { ok: true };
      });

      await expect(service.run(operation)).resolves.toEqual({ ok: true });
      expect(controls.startTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
        }),
      );
      expect(controls.commitTransaction).toHaveBeenCalledTimes(1);
      expect(controls.abortTransaction).not.toHaveBeenCalled();
      expect(controls.endSession).toHaveBeenCalledTimes(1);
    });

    it("allows only a bounded commit deadline without weakening invariants", async () => {
      const controls = createSession();
      const { connection } = createConnection([controls.session]);
      const service = new MongoTransactionService(connection);

      await service.run(async () => "done", { maxCommitTimeMS: 4_321 });

      expect(controls.startTransaction).toHaveBeenCalledWith({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
        maxCommitTimeMS: 4_321,
      });
    });

    it("rejects an invalid commit deadline before opening a session", async () => {
      const controls = createSession();
      const { connection, startSession } = createConnection([controls.session]);
      const service = new MongoTransactionService(connection);

      await expect(
        service.run(async () => "never", { maxCommitTimeMS: 0 }),
      ).rejects.toBeInstanceOf(MongoTransactionUsageError);
      expect(startSession).not.toHaveBeenCalled();
    });

    it("maps session acquisition failure to a typed error with a non-enumerable cause", async () => {
      const controls = createSession();
      const { connection, startSession } = createConnection([controls.session]);
      const cause = new Error("driver session detail");
      startSession.mockRejectedValueOnce(cause);
      const service = new MongoTransactionService(connection);
      const operation = vi.fn(async () => "never");

      const error = await service.run(operation).then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(MongoTransactionUnavailableError);
      expect(error).toMatchObject({
        code: "MONGO_TRANSACTIONS_UNAVAILABLE",
        cause,
      });
      expect(
        Object.prototype.propertyIsEnumerable.call(error, "cause"),
      ).toBe(false);
      expect(Object.keys(error as object)).not.toContain("cause");
      expect((error as Error).message).not.toContain("driver session detail");
      expect(operation).not.toHaveBeenCalled();
    });

    it("aborts once and preserves a non-transient callback error", async () => {
      const controls = createSession();
      const { connection, startSession } = createConnection([controls.session]);
      const service = new MongoTransactionService(connection);
      const failure = new Error("domain rejected");

      await expect(
        service.run(async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(controls.abortTransaction).toHaveBeenCalledTimes(1);
      expect(controls.commitTransaction).not.toHaveBeenCalled();
      expect(controls.endSession).toHaveBeenCalledTimes(1);
    });

    it("reruns the whole callback only for a labeled transient error", async () => {
      const first = createSession();
      const second = createSession();
      const { connection } = createConnection([first.session, second.session]);
      const sleep = vi.fn(async () => undefined);
      const service = new MongoTransactionService(connection, sleep);
      const operation = vi.fn(async (_session, context) => {
        if (context.attempt === 1) {
          throw labeledError("write conflict", "TransientTransactionError");
        }
        return "committed";
      });

      await expect(
        service.run(operation, { maxAttempts: 2, retryDelayMs: 7 }),
      ).resolves.toBe("committed");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(first.abortTransaction).toHaveBeenCalledTimes(1);
      expect(second.commitTransaction).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(7);
    });

    it("throws a typed error after the finite whole-transaction retry budget", async () => {
      const first = createSession();
      const second = createSession();
      const { connection } = createConnection([first.session, second.session]);
      const service = new MongoTransactionService(
        connection,
        async () => undefined,
      );

      await expect(
        service.run(
          async () => {
            throw labeledError("conflict", "TransientTransactionError");
          },
          { maxAttempts: 2, retryDelayMs: 0 },
        ),
      ).rejects.toBeInstanceOf(MongoTransactionRetryExhaustedError);
      expect(first.abortTransaction).toHaveBeenCalledTimes(1);
      expect(second.abortTransaction).toHaveBeenCalledTimes(1);
    });

    it("retries an uncertain commit without rerunning the callback", async () => {
      const controls = createSession({
        commitErrors: [
          labeledError("network after commit", "UnknownTransactionCommitResult"),
        ],
      });
      const { connection } = createConnection([controls.session]);
      const sleep = vi.fn(async () => undefined);
      const service = new MongoTransactionService(connection, sleep);
      const operation = vi.fn(async () => "done");

      await expect(
        service.run(operation, { maxCommitAttempts: 2, retryDelayMs: 4 }),
      ).resolves.toBe("done");
      expect(operation).toHaveBeenCalledTimes(1);
      expect(controls.commitTransaction).toHaveBeenCalledTimes(2);
      expect(controls.abortTransaction).not.toHaveBeenCalled();
      expect(sleep).toHaveBeenCalledWith(4);
    });

    it("reports an uncertain commit after a finite commit retry budget", async () => {
      const controls = createSession({
        commitErrors: [
          labeledError("unknown one", "UnknownTransactionCommitResult"),
          labeledError("unknown two", "UnknownTransactionCommitResult"),
        ],
      });
      const { connection } = createConnection([controls.session]);
      const service = new MongoTransactionService(
        connection,
        async () => undefined,
      );

      await expect(
        service.run(async () => "result", {
          maxCommitAttempts: 2,
          retryDelayMs: 0,
        }),
      ).rejects.toBeInstanceOf(MongoTransactionCommitUncertainError);
      expect(controls.commitTransaction).toHaveBeenCalledTimes(2);
      expect(controls.abortTransaction).not.toHaveBeenCalled();
    });

    it("rejects callbacks that take ownership of commit", async () => {
      const controls = createSession();
      const { connection } = createConnection([controls.session]);
      const service = new MongoTransactionService(connection);

      await expect(
        service.run(async (session) => {
          await session.commitTransaction();
          return "invalid";
        }),
      ).rejects.toBeInstanceOf(MongoTransactionUsageError);
    });
  });

  it("recognizes driver and plain-object error labels", () => {
    expect(
      hasMongoErrorLabel(
        { hasErrorLabel: (label: string) => label === "TransientTransactionError" },
        "TransientTransactionError",
      ),
    ).toBe(true);
    expect(
      hasMongoErrorLabel(
        { errorLabels: ["UnknownTransactionCommitResult"] },
        "UnknownTransactionCommitResult",
      ),
    ).toBe(true);
  });
});
