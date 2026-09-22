import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProgramCommunitySettingsSection, {
  buildProgramCommunitySettingsInput,
  createProgramCommunitySettingsDraft,
} from "../../components/EditProgram/ProgramCommunitySettingsSection";
import type { ProgramCommunitySettingsDTO } from "../../services/api/programCommunitySettings.contracts";

const roles = [
  {
    id: "participant",
    name: "Participant",
    discountEligible: false,
    discountAmount: 0,
    limit: 0,
    count: 0,
  },
  {
    id: "class-rep",
    name: "Class Representative",
    discountEligible: true,
    discountAmount: 0,
    limit: 0,
    count: 0,
  },
];

function settings(
  overrides: Partial<ProgramCommunitySettingsDTO> = {},
): ProgramCommunitySettingsDTO {
  return {
    id: "507f191e810c19729de860ec",
    programId: "507f191e810c19729de860ea",
    primaryConversationId: "507f191e810c19729de860eb",
    enabled: true,
    opensAt: "2026-09-12T15:00:00.000Z",
    closesAt: "2027-01-01T00:00:00.000Z",
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" },
      { studentRoleId: "class-rep", memberRole: "class_representative" },
    ],
    revision: 3,
    createdAt: "2026-09-12T16:00:00.000Z",
    updatedAt: "2026-09-12T16:00:00.000Z",
    ...overrides,
  };
}

describe("ProgramCommunitySettingsSection", () => {
  it("builds an exact UTC/CAS replacement and fills mappings for new roles", () => {
    const draft = createProgramCommunitySettingsDraft(settings());
    expect(draft.opensAt).toBe("2026-09-12T15:00:00.000");
    expect(
      buildProgramCommunitySettingsInput(
        {
          ...draft,
          closesAt: "2027-02-01T12:30",
          studentRoleMappings: draft.studentRoleMappings.slice(0, 1),
        },
        roles,
        3,
      ),
    ).toEqual({
      enabled: true,
      opensAt: "2026-09-12T15:00:00.000Z",
      closesAt: "2027-02-01T12:30:00.000Z",
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        { studentRoleId: "class-rep", memberRole: "class_representative" },
      ],
      expectedRevision: 3,
    });
  });

  it("rejects a missing open instant and a non-increasing access window", () => {
    expect(() =>
      buildProgramCommunitySettingsInput(
        {
          enabled: false,
          opensAt: "",
          closesAt: "2027-02-01T12:30",
          studentRoleMappings: [],
        },
        roles,
        0,
      ),
    ).toThrow(/Open time/u);
    expect(() =>
      buildProgramCommunitySettingsInput(
        {
          enabled: true,
          opensAt: "2027-02-01T12:30",
          closesAt: "2027-02-01T12:30",
          studentRoleMappings: [],
        },
        roles,
        0,
      ),
    ).toThrow(/after/u);
  });

  it.each([
    "2026-02-30T12:00",
    "2026-04-31T12:00",
    "2026-09-12T24:00",
  ])("rejects the nonexistent UTC local instant %s", (opensAt) => {
    expect(() =>
      buildProgramCommunitySettingsInput(
        {
          enabled: true,
          opensAt,
          closesAt: "",
          studentRoleMappings: [],
        },
        roles,
        0,
      ),
    ).toThrow(/valid UTC date and time/u);
  });

  it("accepts a valid UTC leap day", () => {
    expect(
      buildProgramCommunitySettingsInput(
        {
          enabled: true,
          opensAt: "2028-02-29T12:00",
          closesAt: "",
          studentRoleMappings: [],
        },
        roles,
        0,
      ).opensAt,
    ).toBe("2028-02-29T12:00:00.000Z");
  });

  it("preserves seconds and milliseconds unless the UTC input is edited", () => {
    const current = settings({
      opensAt: "2026-09-12T15:00:30.500Z",
      closesAt: "2027-01-01T00:00:45.125Z",
    });
    const draft = createProgramCommunitySettingsDraft(current);
    expect(draft).toMatchObject({
      opensAt: "2026-09-12T15:00:30.500",
      closesAt: "2027-01-01T00:00:45.125",
    });
    expect(buildProgramCommunitySettingsInput(draft, roles, 3)).toMatchObject({
      opensAt: current.opensAt,
      closesAt: current.closesAt,
    });
    expect(
      buildProgramCommunitySettingsInput(
        { ...draft, opensAt: "2026-09-12T15:00:30.5" },
        roles,
        3,
      ).opensAt,
    ).toBe("2026-09-12T15:00:30.500Z");
  });

  it("edits enabled, UTC window, and every Program student-role mapping", () => {
    const onChange = vi.fn();
    const current = settings();
    const draft = createProgramCommunitySettingsDraft(current);
    render(
      <ProgramCommunitySettingsSection
        settings={current}
        draft={draft}
        studentRoles={roles}
        loading={false}
        writable={true}
        error={null}
        onChange={onChange}
        onReload={vi.fn()}
      />,
    );

    expect(screen.getByText("Primary Room ready")).toBeInTheDocument();
    expect(screen.getByLabelText("Opens at (UTC) *")).toHaveAttribute(
      "step",
      "0.001",
    );
    fireEvent.click(screen.getByLabelText(/Enable Program Chat Room/u));
    expect(onChange).toHaveBeenCalledWith({ ...draft, enabled: false });

    fireEvent.change(screen.getByLabelText("Opens at (UTC) *"), {
      target: { value: "2026-09-20T10:15" },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...draft,
      opensAt: "2026-09-20T10:15",
    });

    fireEvent.change(screen.getByLabelText("Participant"), {
      target: { value: "class_representative" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        studentRoleMappings: [
          {
            studentRoleId: "participant",
            memberRole: "class_representative",
          },
          {
            studentRoleId: "class-rep",
            memberRole: "class_representative",
          },
        ],
      }),
    );
  });

  it("locks lifecycle-owned archived settings and exposes a load retry", () => {
    const onReload = vi.fn();
    const archived = settings({
      archivedAt: "2027-01-02T00:00:00.000Z",
    });
    const { rerender } = render(
      <ProgramCommunitySettingsSection
        settings={archived}
        draft={createProgramCommunitySettingsDraft(archived)}
        studentRoles={roles}
        loading={false}
        writable={true}
        error={null}
        onChange={vi.fn()}
        onReload={onReload}
      />,
    );

    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.queryByText("Primary Room ready")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Enable Program Chat Room/u)).toBeDisabled();

    rerender(
      <ProgramCommunitySettingsSection
        settings={null}
        draft={null}
        studentRoles={roles}
        loading={false}
        writable={false}
        error="Settings unavailable"
        onChange={vi.fn()}
        onReload={onReload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    expect(onReload).toHaveBeenCalledOnce();
  });
});
