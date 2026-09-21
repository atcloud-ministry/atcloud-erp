import type { ProgramStudentRole } from "../../types/program";
import type {
  ProgramCommunityMemberRole,
  ProgramCommunitySettingsDTO,
  ProgramStudentRoleMappingDTO,
  UpdateProgramCommunitySettingsInput,
} from "../../services/api/programCommunitySettings.contracts";

export interface ProgramCommunitySettingsDraft {
  readonly enabled: boolean;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly studentRoleMappings: readonly ProgramStudentRoleMappingDTO[];
}

interface ProgramCommunitySettingsSectionProps {
  readonly settings: ProgramCommunitySettingsDTO | null;
  readonly draft: ProgramCommunitySettingsDraft | null;
  readonly studentRoles: readonly ProgramStudentRole[];
  readonly loading: boolean;
  readonly writable: boolean;
  readonly error: string | null;
  readonly onChange: (draft: ProgramCommunitySettingsDraft) => void;
  readonly onReload: () => void;
}

function defaultMemberRole(role: ProgramStudentRole): ProgramCommunityMemberRole {
  return role.discountEligible ? "class_representative" : "mentee";
}

function isoToUtcInput(value: string | null): string {
  return value?.endsWith("Z") ? value.slice(0, -1) : "";
}

function utcInputToIso(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value,
  );
  if (!match) {
    throw new Error("Program Chat Room times must use a valid UTC date and time.");
  }
  const seconds = match[2] ?? "00";
  const milliseconds = (match[3] ?? "").padEnd(3, "0");
  const canonical = `${match[1]}:${seconds}.${milliseconds}Z`;
  const result = new Date(canonical);
  if (
    Number.isNaN(result.getTime()) ||
    result.toISOString() !== canonical
  ) {
    throw new Error("Program Chat Room times must use a valid UTC date and time.");
  }
  return result.toISOString();
}

export function createProgramCommunitySettingsDraft(
  settings: ProgramCommunitySettingsDTO,
): ProgramCommunitySettingsDraft {
  return Object.freeze({
    enabled: settings.enabled,
    opensAt: isoToUtcInput(settings.opensAt),
    closesAt: isoToUtcInput(settings.closesAt),
    studentRoleMappings: Object.freeze(
      settings.studentRoleMappings.map((mapping) => ({ ...mapping })),
    ),
  });
}

export function buildProgramCommunitySettingsInput(
  draft: ProgramCommunitySettingsDraft,
  studentRoles: readonly ProgramStudentRole[],
  expectedRevision: number,
): UpdateProgramCommunitySettingsInput {
  const submittedById = new Map(
    draft.studentRoleMappings.map((mapping) => [
      mapping.studentRoleId,
      mapping.memberRole,
    ]),
  );
  const opensAt = utcInputToIso(draft.opensAt);
  const closesAt = utcInputToIso(draft.closesAt);
  if (draft.enabled && !opensAt) {
    throw new Error("Open time is required when the Program Chat Room is enabled.");
  }
  if (closesAt && !opensAt) {
    throw new Error("Open time is required when a close time is set.");
  }
  if (
    opensAt &&
    closesAt &&
    new Date(closesAt).getTime() <= new Date(opensAt).getTime()
  ) {
    throw new Error("Close time must be after the open time.");
  }
  return Object.freeze({
    enabled: draft.enabled,
    opensAt,
    closesAt,
    studentRoleMappings: Object.freeze(
      studentRoles.map((role) =>
        Object.freeze({
          studentRoleId: role.id,
          memberRole: submittedById.get(role.id) ?? defaultMemberRole(role),
        }),
      ),
    ),
    expectedRevision,
  });
}

export function programCommunitySettingsChanged(
  settings: ProgramCommunitySettingsDTO,
  input: UpdateProgramCommunitySettingsInput,
): boolean {
  return (
    settings.enabled !== input.enabled ||
    settings.opensAt !== input.opensAt ||
    settings.closesAt !== input.closesAt ||
    settings.studentRoleMappings.length !== input.studentRoleMappings.length ||
    settings.studentRoleMappings.some(
      (mapping, index) =>
        mapping.studentRoleId !==
          input.studentRoleMappings[index]?.studentRoleId ||
        mapping.memberRole !== input.studentRoleMappings[index]?.memberRole,
    )
  );
}

export default function ProgramCommunitySettingsSection({
  settings,
  draft,
  studentRoles,
  loading,
  writable,
  error,
  onChange,
  onReload,
}: ProgramCommunitySettingsSectionProps) {
  const locked = loading || !settings || !draft || !writable || !!settings.archivedAt;
  const mappingById = new Map(
    draft?.studentRoleMappings.map((mapping) => [
      mapping.studentRoleId,
      mapping.memberRole,
    ]) ?? [],
  );

  const changeMapping = (
    studentRoleId: string,
    memberRole: ProgramCommunityMemberRole,
  ) => {
    if (!draft) return;
    const next = new Map(
      draft.studentRoleMappings.map((mapping) => [
        mapping.studentRoleId,
        mapping.memberRole,
      ]),
    );
    next.set(studentRoleId, memberRole);
    onChange({
      ...draft,
      studentRoleMappings: studentRoles.map((role) => ({
        studentRoleId: role.id,
        memberRole: next.get(role.id) ?? defaultMemberRole(role),
      })),
    });
  };

  return (
    <section
      aria-labelledby="program-community-settings-title"
      className="rounded-lg border border-gray-200 bg-gray-50 p-5 space-y-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="program-community-settings-title"
            className="text-lg font-semibold text-gray-900"
          >
            Program Chat Room
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Set the UTC access window and map each student role before opening
            this Program&apos;s primary Room.
          </p>
        </div>
        {settings?.primaryConversationId && !settings.archivedAt && (
          <span className="self-start rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
            Primary Room ready
          </span>
        )}
        {settings?.archivedAt && (
          <span className="self-start rounded-full bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700">
            Archived
          </span>
        )}
      </div>

      {loading && (
        <p role="status" className="text-sm text-gray-600">
          Loading Program Chat Room settings…
        </p>
      )}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={onReload}
            className="mt-2 text-sm font-medium text-red-700 underline"
          >
            Reload settings
          </button>
        </div>
      )}

      {settings && draft && (
        <>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={locked}
              onChange={(event) =>
                onChange({ ...draft, enabled: event.target.checked })
              }
              className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">
                Enable Program Chat Room
              </span>
              <span className="block text-sm text-gray-600">
                Enabling provisions one permanent primary Room for this Program.
              </span>
            </span>
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="program-room-opens-at"
                className="block text-sm font-medium text-gray-700"
              >
                Opens at (UTC){draft.enabled ? " *" : ""}
              </label>
              <input
                id="program-room-opens-at"
                type="datetime-local"
                step="0.001"
                value={draft.opensAt}
                required={draft.enabled}
                disabled={locked}
                onChange={(event) =>
                  onChange({ ...draft, opensAt: event.target.value })
                }
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label
                htmlFor="program-room-closes-at"
                className="block text-sm font-medium text-gray-700"
              >
                Closes at (UTC)
              </label>
              <input
                id="program-room-closes-at"
                type="datetime-local"
                step="0.001"
                value={draft.closesAt}
                disabled={locked}
                onChange={(event) =>
                  onChange({ ...draft, closesAt: event.target.value })
                }
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <fieldset disabled={locked} className="space-y-3">
            <legend className="text-sm font-medium text-gray-900">
              Student role mapping
            </legend>
            {studentRoles.map((role) => (
              <div
                key={role.id}
                className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,1fr)] sm:items-center"
              >
                <label
                  htmlFor={`program-room-role-${role.id}`}
                  className="text-sm text-gray-700"
                >
                  {role.name}
                </label>
                <select
                  id={`program-room-role-${role.id}`}
                  value={mappingById.get(role.id) ?? defaultMemberRole(role)}
                  onChange={(event) =>
                    changeMapping(
                      role.id,
                      event.target.value as ProgramCommunityMemberRole,
                    )
                  }
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="mentee">Mentee</option>
                  <option value="class_representative">
                    Class Representative
                  </option>
                </select>
              </div>
            ))}
          </fieldset>

          {!writable && !settings.archivedAt && (
            <p className="text-sm text-amber-700">
              Program Chat Room settings are currently read-only.
            </p>
          )}
        </>
      )}
    </section>
  );
}
