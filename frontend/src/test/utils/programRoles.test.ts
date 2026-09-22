import { describe, expect, it } from "vitest";
import {
  buildProgramRolesPayload,
  normalizeProgramRoles,
} from "../../utils/programRoles";

describe("program role utilities", () => {
  it("preserves the legacy Class Representative role ID during a Program edit", () => {
    const payload = buildProgramRolesPayload({
      studentRoles: [
        {
          id: "classRep",
          name: "Class Representative",
          discountEligible: true,
          discountAmount: 0,
          limit: 0,
          count: 1,
        },
        {
          id: "class-rep",
          name: "Different Role",
          discountEligible: false,
          discountAmount: 0,
          limit: 0,
          count: 0,
        },
      ],
    });

    expect(payload.studentRoles.map((role) => role.id)).toEqual([
      "classRep",
      "class-rep",
    ]);
  });

  it("preserves programs with no tuition discount roles", () => {
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

    expect(roles.teacherRoleName).toBe("Coach");
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

  it("preserves multiple tuition discount roles when normalizing", () => {
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
    expect(roles.studentRoles.map((role) => role.limit)).toEqual([2, 4]);
  });

  it("builds a payload with zero, one, or multiple tuition discount roles", () => {
    const payload = buildProgramRolesPayload({
      teacherRoleName: "Advisor",
      studentRoles: [
        {
          id: "standard",
          name: "Standard",
          discountEligible: false,
          discountAmount: 99,
          limit: 5,
        },
        {
          id: "team-lead",
          name: "Team Lead",
          discountEligible: true,
          discountAmount: 15,
          limit: 2,
        },
        {
          id: "scholar",
          name: "Scholar",
          discountEligible: true,
          discountAmount: 20,
          limit: 0,
        },
      ],
    });

    expect(payload.teacherRoleName).toBe("Advisor");
    expect(payload.studentRoles).toMatchObject([
      {
        id: "standard",
        discountEligible: false,
        discountAmount: 0,
        limit: 0,
      },
      {
        id: "team-lead",
        discountEligible: true,
        discountAmount: 1500,
        limit: 2,
      },
      {
        id: "scholar",
        discountEligible: true,
        discountAmount: 2000,
        limit: 0,
      },
    ]);
  });
});
