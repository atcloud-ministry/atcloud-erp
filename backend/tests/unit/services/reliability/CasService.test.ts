import type { ClientSession, Model } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  CasConflictError,
  CasNotFoundError,
  CasService,
  CasValidationError,
  buildRevisionFencedUpdate,
  type RevisionedEntity,
} from "../../../../src/services/reliability/CasService";

interface TestEntity extends RevisionedEntity {
  name: string;
  status?: string;
  visits?: number;
}

function createModel() {
  const findOneAndUpdate = vi.fn();
  const findOne = vi.fn();
  const model = {
    findOneAndUpdate,
    findOne,
  } as unknown as Model<TestEntity>;

  return { model, findOneAndUpdate, findOne };
}

describe("CasService", () => {
  it("fences a direct update by revision and passes the explicit session", async () => {
    const { model, findOneAndUpdate, findOne } = createModel();
    const session = {
      inTransaction: () => true,
    } as unknown as ClientSession;
    const updated = { _id: "resource-1", revision: 4, name: "Updated" };
    findOneAndUpdate.mockResolvedValue(updated);

    await expect(
      CasService.update({
        model,
        id: "resource-1",
        expectedRevision: 3,
        update: { name: "Updated" },
        session,
      }),
    ).resolves.toBe(updated);

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "resource-1", revision: 3 },
      { $set: { name: "Updated" }, $inc: { revision: 1 } },
      { new: true, runValidators: true, session },
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it("merges the server-owned revision increment into operator updates", () => {
    expect(
      buildRevisionFencedUpdate({
        $set: { status: "active" },
        $inc: { visits: 2 },
      }),
    ).toEqual({
      $set: { status: "active" },
      $inc: { visits: 2, revision: 1 },
    });
  });

  it("combines a domain guard with the immutable revision fence", async () => {
    const { model, findOneAndUpdate } = createModel();
    findOneAndUpdate.mockResolvedValue({
      _id: "resource-2",
      revision: 8,
      name: "Approved",
      status: "approved",
    });

    await CasService.update({
      model,
      id: "resource-2",
      expectedRevision: 7,
      additionalFilter: { status: "pending" },
      update: { status: "approved" },
      session: null,
    });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        $and: [
          { status: "pending" },
          { _id: "resource-2", revision: 7 },
        ],
      },
      {
        $set: { status: "approved" },
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true },
    );
  });

  it("reports a typed revision mismatch with expected and actual revisions", async () => {
    const { model, findOneAndUpdate, findOne } = createModel();
    const session = {
      inTransaction: () => true,
    } as unknown as ClientSession;
    findOneAndUpdate.mockResolvedValue(null);
    findOne.mockResolvedValue({ _id: "resource-3", revision: 9 });

    const promise = CasService.update({
      model,
      id: "resource-3",
      expectedRevision: 8,
      update: { name: "Late write" },
      session,
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({
        name: "CasConflictError",
        code: "CAS_CONFLICT",
        reason: "revision_mismatch",
        expectedRevision: 8,
        actualRevision: 9,
      }),
    );
    await expect(promise).rejects.toBeInstanceOf(CasConflictError);
    expect(findOne).toHaveBeenCalledWith(
      { _id: "resource-3" },
      { revision: 1 },
      { session },
    );
  });

  it("distinguishes a failed domain guard from a revision mismatch", async () => {
    const { model, findOneAndUpdate, findOne } = createModel();
    findOneAndUpdate.mockResolvedValue(null);
    findOne.mockResolvedValue({ _id: "resource-4", revision: 5 });

    await expect(
      CasService.update({
        model,
        id: "resource-4",
        expectedRevision: 5,
        additionalFilter: { status: "pending" },
        update: { status: "approved" },
        session: null,
      }),
    ).rejects.toMatchObject({
      code: "CAS_CONFLICT",
      reason: "guard_failed",
      expectedRevision: 5,
      actualRevision: 5,
    });
  });

  it("reports a typed not-found error when the resource does not exist", async () => {
    const { model, findOneAndUpdate, findOne } = createModel();
    findOneAndUpdate.mockResolvedValue(null);
    findOne.mockResolvedValue(null);

    await expect(
      CasService.update({
        model,
        id: "missing",
        expectedRevision: 0,
        update: { name: "No resource" },
        session: null,
      }),
    ).rejects.toBeInstanceOf(CasNotFoundError);
  });

  it("rejects invalid stored revisions instead of misreporting a conflict", async () => {
    const { model, findOneAndUpdate, findOne } = createModel();
    findOneAndUpdate.mockResolvedValue(null);
    findOne.mockResolvedValue({ _id: "broken", revision: -1 });

    await expect(
      CasService.update({
        model,
        id: "broken",
        expectedRevision: 0,
        update: { name: "No resource" },
        session: null,
      }),
    ).rejects.toBeInstanceOf(CasValidationError);
  });

  it("prevents callers from bypassing the server-owned revision fence", () => {
    const invalidUpdates = [
      {},
      { revision: 10 },
      { _id: "replacement" },
      { $set: { "revision.value": 10 } },
      { $unset: { "_id.value": true } },
      { $rename: { name: "revision" } },
      { $set: { name: "mixed" }, status: "active" },
      { $where: { value: true } },
      { $set: null },
    ];

    for (const update of invalidUpdates) {
      expect(() => buildRevisionFencedUpdate(update)).toThrow(
        CasValidationError,
      );
    }
  });

  it("validates the id and expected revision before issuing a write", async () => {
    const { model, findOneAndUpdate } = createModel();

    await expect(
      CasService.update({
        model,
        id: " ",
        expectedRevision: 0,
        update: { name: "Invalid" },
        session: null,
      }),
    ).rejects.toBeInstanceOf(CasValidationError);
    await expect(
      CasService.update({
        model,
        id: "resource",
        expectedRevision: -1,
        update: { name: "Invalid" },
        session: null,
      }),
    ).rejects.toBeInstanceOf(CasValidationError);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("requires an explicit null or active transaction session", async () => {
    const { model, findOneAndUpdate } = createModel();
    const updateWithoutTypedBoundary = CasService.update as unknown as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    const baseInput = {
      model,
      id: "resource",
      expectedRevision: 0,
      update: { name: "Updated" },
    };

    await expect(updateWithoutTypedBoundary(baseInput)).rejects.toBeInstanceOf(
      CasValidationError,
    );
    await expect(
      CasService.update({
        ...baseInput,
        session: {
          inTransaction: () => false,
        } as unknown as ClientSession,
      }),
    ).rejects.toBeInstanceOf(CasValidationError);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
