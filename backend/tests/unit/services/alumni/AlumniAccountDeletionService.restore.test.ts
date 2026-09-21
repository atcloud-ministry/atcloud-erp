import type { ClientSession } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  AlumniAccountDeletionService,
  RESTORE_ACCOUNT_DELETION_ACTOR_KEY,
} from "../../../../src/services/alumni/AlumniAccountDeletionService";
import type { MongoTransactionService } from "../../../../src/services/reliability/MongoTransactionService";

const TARGET_USER_ID = "507f1f77bcf86cd799439011";
const ACTOR_USER_ID = "507f1f77bcf86cd799439012";
const SOURCE_DELETED_AT = new Date("2030-09-18T12:01:00.000Z");

function createService() {
  const transactions = {
    run: vi.fn(async (work: (session: ClientSession) => Promise<unknown>) =>
      work({} as ClientSession),
    ),
  };
  return {
    service: new AlumniAccountDeletionService({
      now: () => new Date("2030-09-19T12:00:00.000Z"),
      transactions: transactions as unknown as MongoTransactionService,
    }),
    transactions,
  };
}

describe("AlumniAccountDeletionService restore replay guard", () => {
  it("allows only the fixed restore actor to preserve the source deletion clock", async () => {
    const { service, transactions } = createService();
    const stopBeforeWrites = new Error("test transaction stop");
    let observedNow: Date | undefined;

    await expect(
      service.deleteAccount(
        {
          targetUserId: TARGET_USER_ID,
          actor: {
            type: "system",
            key: RESTORE_ACCOUNT_DELETION_ACTOR_KEY,
          },
          occurredAt: SOURCE_DELETED_AT,
        },
        async ({ now }) => {
          observedNow = now;
          throw stopBeforeWrites;
        },
      ),
    ).rejects.toBe(stopBeforeWrites);

    expect(transactions.run).toHaveBeenCalledOnce();
    expect(observedNow).toEqual(SOURCE_DELETED_AT);
    expect(observedNow).not.toBe(SOURCE_DELETED_AT);
  });

  it("rejects arbitrary system actors and caller-chosen timestamps before a transaction starts", async () => {
    const invalidSystem = createService();
    await expect(
      invalidSystem.service.deleteAccount({
        targetUserId: TARGET_USER_ID,
        actor: { type: "system", key: "other-system" },
      }),
    ).rejects.toThrow("system actor key");
    expect(invalidSystem.transactions.run).not.toHaveBeenCalled();

    const userTimestamp = createService();
    await expect(
      userTimestamp.service.deleteAccount({
        targetUserId: TARGET_USER_ID,
        actor: { id: ACTOR_USER_ID, role: "Super Admin" },
        occurredAt: SOURCE_DELETED_AT,
      }),
    ).rejects.toThrow("Only the isolated restore actor");
    expect(userTimestamp.transactions.run).not.toHaveBeenCalled();
  });
});
