import { describe, expect, it } from "vitest";
import FeatureControl, {
  FEATURE_CONTROL_COLLECTION,
  FEATURE_CONTROL_SINGLETON_ID,
} from "../../../src/models/FeatureControl";

const changedBy = "507f1f77bcf86cd799439011";

describe("FeatureControl model", () => {
  it("accepts only the fixed singleton shape", () => {
    const control = new FeatureControl({
      _id: FEATURE_CONTROL_SINGLETON_ID,
      mode: "read_only",
      revision: 2,
      changedBy,
    });

    expect(control.validateSync()).toBeUndefined();
    expect(FeatureControl.collection.collectionName).toBe(
      FEATURE_CONTROL_COLLECTION,
    );
    expect(control.toObject()).not.toHaveProperty("reasonCode");
  });

  it.each([
    [{ _id: "another", mode: "off", revision: 0, changedBy }],
    [
      {
        _id: FEATURE_CONTROL_SINGLETON_ID,
        mode: "partial",
        revision: 0,
        changedBy,
      },
    ],
    [
      {
        _id: FEATURE_CONTROL_SINGLETON_ID,
        mode: "off",
        revision: -1,
        changedBy,
      },
    ],
    [
      {
        _id: FEATURE_CONTROL_SINGLETON_ID,
        mode: "off",
        revision: 1.5,
        changedBy,
      },
    ],
    [
      {
        _id: FEATURE_CONTROL_SINGLETON_ID,
        mode: "off",
        revision: 0,
        changedBy: "not-an-object-id",
      },
    ],
  ])("rejects an invalid singleton document", (input) => {
    const control = new FeatureControl(input);
    expect(control.validateSync()).toBeDefined();
  });

  it("throws on fields outside the control schema", () => {
    expect(
      () =>
        new FeatureControl({
          _id: FEATURE_CONTROL_SINGLETON_ID,
          mode: "off",
          revision: 0,
          changedBy,
          reasonCode: "NOT_STORED",
        }),
    ).toThrow();
  });
});
