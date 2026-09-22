import { describe, expect, it } from "vitest";
import {
  buildDiscountRoleCountIncrement,
  normalizeProgramRoles,
  syncLegacyProgramPricingFields,
} from "../../../src/utils/programRoles";

describe("programRoles utilities", () => {
  it("preserves the legacy Class Representative role ID while normalizing", () => {
    const roles = normalizeProgramRoles({
      programRoles: {
        studentRoles: [
          {
            id: "classRep",
            name: "Class Representative",
            discountEligible: true,
          },
          {
            id: "class-rep",
            name: "Different Role",
            discountEligible: false,
          },
        ],
      },
    });

    expect(roles.studentRoles.map((role) => role.id)).toEqual([
      "classRep",
      "class-rep",
    ]);
  });

  it("preserves zero tuition discount roles in explicit programRoles", () => {
    const roles = normalizeProgramRoles({
      programRoles: {
        teacherRoleName: "Coach",
        studentRoles: [
          {
            id: "learner",
            name: "Learner",
            discountEligible: false,
            discountAmount: 5000,
            limit: 3,
            count: 2,
          },
        ],
      },
    });

    expect(roles.studentRoles).toEqual([
      {
        id: "learner",
        name: "Learner",
        discountEligible: false,
        discountAmount: 0,
        limit: 0,
        count: 0,
      },
    ]);
  });

  it("preserves multiple tuition discount roles while normalizing", () => {
    const roles = normalizeProgramRoles({
      programRoles: {
        teacherRoleName: "Mentor",
        studentRoles: [
          {
            id: "classRep",
            name: "Class Rep",
            discountEligible: true,
            discountAmount: 1000,
            limit: 2,
            count: 1,
          },
          {
            id: "scholar",
            name: "Scholar",
            discountEligible: true,
            discountAmount: 2500,
            limit: 4,
            count: 3,
          },
        ],
      },
    });

    expect(roles.studentRoles.map((role) => role.discountEligible)).toEqual([
      true,
      true,
    ]);
    expect(roles.studentRoles.map((role) => role.discountAmount)).toEqual([
      1000,
      2500,
    ]);
    expect(roles.studentRoles.map((role) => role.count)).toEqual([1, 3]);
  });

  it("increments only the selected non-legacy discount role count", () => {
    const increment = buildDiscountRoleCountIncrement(
      {
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [
            { id: "mentee", name: "Mentee", discountEligible: false },
            {
              id: "classRep",
              name: "Class Rep",
              discountEligible: true,
              discountAmount: 1000,
              limit: 2,
              count: 1,
            },
            {
              id: "scholar",
              name: "Scholar",
              discountEligible: true,
              discountAmount: 2500,
              limit: 4,
              count: 3,
            },
          ],
        },
      },
      1,
      "scholar",
    );

    expect(increment).toEqual({
      "programRoles.studentRoles.2.count": 1,
    });
  });

  it("keeps classRepCount as a compatibility mirror for the first discount role only", () => {
    const target = {
      classRepCount: 7,
      classRepDiscount: 1000,
      classRepLimit: 2,
      programRoles: {
        teacherRoleName: "Mentor",
        studentRoles: [
          {
            id: "classRep",
            name: "Class Rep",
            discountEligible: true,
            discountAmount: 1000,
            limit: 2,
            count: 1,
          },
          {
            id: "scholar",
            name: "Scholar",
            discountEligible: true,
            discountAmount: 2500,
            limit: 4,
            count: 3,
          },
        ],
      },
    };

    syncLegacyProgramPricingFields(target);

    expect(target.classRepCount).toBe(7);
    expect(target.programRoles.studentRoles.map((role) => role.count)).toEqual([
      7,
      3,
    ]);
  });
});
