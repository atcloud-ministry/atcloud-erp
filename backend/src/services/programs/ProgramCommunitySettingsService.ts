import mongoose, {
  type ClientSession,
  type HydratedDocument,
  type Model,
} from "mongoose";
import type { AuditLogWriteInput } from "../../contracts/auditLog";
import {
  PROGRAM_COMMUNITY_SETTINGS_LIMITS,
  type ProgramCommunitySettingsDTO,
  type ProgramStudentRoleMappingDTO,
  type UpdateProgramCommunitySettingsBody,
  ProgramCommunitySettingsValidationError,
} from "../../contracts/programCommunitySettings";
import Program, { type IProgram } from "../../models/Program";
import ProgramCommunitySettings, {
  type IProgramCommunitySettings,
} from "../../models/ProgramCommunitySettings";
import Conversation, { type IConversation } from "../../models/Conversation";
import { normalizeProgramRoles } from "../../utils/programRoles";
import { AuditLogService } from "../AuditLogService";
import {
  IdempotencyService,
  idempotencyService,
  type IdempotencyReplayResponseDto,
} from "../reliability/IdempotencyService";
import {
  CasService,
  type CasUpdateInput,
} from "../reliability/CasService";
import {
  programRoomProvisioner,
  type ProgramRoomProvisioner,
} from "./ProgramRoomProvisioner";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export interface ProgramCommunitySettingsActor {
  readonly id: string;
  readonly role: string;
}

export interface UpdateProgramCommunitySettingsInput
  extends UpdateProgramCommunitySettingsBody {
  readonly programId: string;
  readonly actor: ProgramCommunitySettingsActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

interface ProgramCommunitySettingsMutationMappingResponse
  extends IdempotencyReplayResponseDto {
  readonly studentRoleId: string;
  readonly memberRole: "mentee" | "class_representative";
}

interface ProgramCommunitySettingsMutationResponse
  extends IdempotencyReplayResponseDto {
  readonly id: string;
  readonly programId: string;
  readonly primaryConversationId: string | null;
  readonly enabled: boolean;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly archivedAt: string | null;
  readonly studentRoleMappings: readonly ProgramCommunitySettingsMutationMappingResponse[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProgramCommunitySettingsMutationResult {
  readonly replayed: boolean;
  readonly settings: ProgramCommunitySettingsDTO;
}

type RequiredAuditWriter = (
  input: AuditLogWriteInput,
  session: ClientSession,
) => Promise<void>;

type SettingsCasUpdate = (
  input: CasUpdateInput<IProgramCommunitySettings>,
) => Promise<HydratedDocument<IProgramCommunitySettings>>;

export interface ProgramCommunitySettingsServiceDependencies {
  readonly now?: () => Date;
  readonly programModel?: Model<IProgram>;
  readonly settingsModel?: Model<IProgramCommunitySettings>;
  readonly conversationModel?: Model<IConversation>;
  readonly idempotency?: IdempotencyService;
  readonly roomProvisioner?: Pick<
    ProgramRoomProvisioner,
    "ensurePrimaryRoomInTransaction"
  >;
  readonly writeRequiredAudit?: RequiredAuditWriter;
  readonly casUpdate?: SettingsCasUpdate;
}

export type ProgramCommunitySettingsErrorCode =
  | "PROGRAM_NOT_FOUND"
  | "PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT"
  | "PROGRAM_COMMUNITY_ROLE_MAPPING_CONFLICT"
  | "PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT";

export class ProgramCommunitySettingsError extends Error {
  readonly name = "ProgramCommunitySettingsError";

  constructor(
    public readonly code: ProgramCommunitySettingsErrorCode,
    public readonly httpStatus: 404 | 409,
  ) {
    super(code);
  }
}

function inputObjectId(value: string, path: string): mongoose.Types.ObjectId {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw new ProgramCommunitySettingsValidationError([
      Object.freeze({ path, msg: `${path} must be a MongoDB ObjectId` }),
    ]);
  }
  return new mongoose.Types.ObjectId(value);
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Program community settings clock is invalid.");
  }
  return new Date(value);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Stored Program community settings contain an invalid date.");
  }
  return date.toISOString();
}

function objectIdString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function mappingDto(
  mappings: readonly {
    readonly studentRoleId: string;
    readonly memberRole: "mentee" | "class_representative";
  }[],
): readonly ProgramStudentRoleMappingDTO[] {
  return Object.freeze(
    mappings.map((mapping) =>
      Object.freeze({
        studentRoleId: mapping.studentRoleId,
        memberRole: mapping.memberRole,
      }),
    ),
  );
}

function candidateMappings(program: IProgram): readonly ProgramStudentRoleMappingDTO[] {
  return Object.freeze(
    normalizeProgramRoles(program).studentRoles.map((role) =>
      Object.freeze({
        studentRoleId: role.id,
        memberRole: role.discountEligible
          ? ("class_representative" as const)
          : ("mentee" as const),
      }),
    ),
  );
}

function virtualDto(
  program: IProgram,
  primaryConversationId: string | null,
): ProgramCommunitySettingsDTO {
  return Object.freeze({
    id: null,
    programId: String(program._id),
    primaryConversationId,
    enabled: false,
    opensAt: null,
    closesAt: null,
    archivedAt: null,
    studentRoleMappings: candidateMappings(program),
    revision: 0,
    createdAt: null,
    updatedAt: null,
  });
}

export function buildProgramCommunitySettingsDTO(
  settings: IProgramCommunitySettings,
  primaryConversationId: string | null,
): ProgramCommunitySettingsDTO {
  return Object.freeze({
    id: String(settings._id),
    programId: String(settings.programId),
    primaryConversationId,
    enabled: settings.enabled,
    opensAt: iso(settings.opensAt),
    closesAt: iso(settings.closesAt),
    archivedAt: iso(settings.archivedAt),
    studentRoleMappings: mappingDto(settings.studentRoleMappings ?? []),
    revision: settings.revision,
    createdAt: iso(settings.createdAt),
    updatedAt: iso(settings.updatedAt),
  });
}

function sameDate(
  first: Date | string | null | undefined,
  second: Date | null,
): boolean {
  return iso(first) === iso(second);
}

function sameMappings(
  first: readonly ProgramStudentRoleMappingDTO[],
  second: readonly ProgramStudentRoleMappingDTO[],
): boolean {
  return (
    first.length === second.length &&
    first.every(
      (mapping, index) =>
        mapping.studentRoleId === second[index]?.studentRoleId &&
        mapping.memberRole === second[index]?.memberRole,
    )
  );
}

function storedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Stored Program community settings revision is invalid.");
  }
  return Number(value);
}

function duplicateKey(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === 11000
  );
}

function revisionConflict(): ProgramCommunitySettingsError {
  return new ProgramCommunitySettingsError(
    "PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT",
    409,
  );
}

function validateMappingsForProgram(
  program: IProgram,
  submitted: readonly ProgramStudentRoleMappingDTO[],
  enabled: boolean,
): readonly ProgramStudentRoleMappingDTO[] {
  const roles = normalizeProgramRoles(program).studentRoles;
  if (
    enabled &&
    roles.length > PROGRAM_COMMUNITY_SETTINGS_LIMITS.studentRoleMappings
  ) {
    throw new ProgramCommunitySettingsError(
      "PROGRAM_COMMUNITY_ROLE_MAPPING_CONFLICT",
      409,
    );
  }
  const submittedById = new Map(
    submitted.map((mapping) => [mapping.studentRoleId, mapping]),
  );
  const knownIds = new Set(roles.map((role) => role.id));
  if (submitted.some((mapping) => !knownIds.has(mapping.studentRoleId))) {
    throw new ProgramCommunitySettingsError(
      "PROGRAM_COMMUNITY_ROLE_MAPPING_CONFLICT",
      409,
    );
  }
  if (enabled && roles.some((role) => !submittedById.has(role.id))) {
    throw new ProgramCommunitySettingsError(
      "PROGRAM_COMMUNITY_ROLE_MAPPING_CONFLICT",
      409,
    );
  }

  return Object.freeze(
    roles.flatMap((role) => {
      const mapping = submittedById.get(role.id);
      return mapping ? [mapping] : [];
    }),
  );
}

function mutationResponse(
  settings: IProgramCommunitySettings,
  primaryConversationId: mongoose.Types.ObjectId | null,
): ProgramCommunitySettingsMutationResponse {
  return Object.freeze({
    id: String(settings._id),
    programId: String(settings.programId),
    primaryConversationId: objectIdString(primaryConversationId),
    enabled: settings.enabled,
    opensAt: iso(settings.opensAt),
    closesAt: iso(settings.closesAt),
    archivedAt: iso(settings.archivedAt),
    studentRoleMappings: Object.freeze(
      (settings.studentRoleMappings ?? []).map((mapping) =>
        Object.freeze({
          studentRoleId: mapping.studentRoleId,
          memberRole: mapping.memberRole,
        }),
      ),
    ),
    revision: storedRevision(settings.revision),
    createdAt: iso(settings.createdAt)!,
    updatedAt: iso(settings.updatedAt)!,
  });
}

function dtoFromMutationResponse(
  response: ProgramCommunitySettingsMutationResponse,
): ProgramCommunitySettingsDTO {
  return Object.freeze({
    id: response.id,
    programId: response.programId,
    primaryConversationId: response.primaryConversationId,
    enabled: response.enabled,
    opensAt: response.opensAt,
    closesAt: response.closesAt,
    archivedAt: response.archivedAt,
    studentRoleMappings: Object.freeze(
      response.studentRoleMappings.map((mapping) =>
        Object.freeze({
          studentRoleId: mapping.studentRoleId,
          memberRole: mapping.memberRole,
        }),
      ),
    ),
    revision: response.revision,
    createdAt: response.createdAt,
    updatedAt: response.updatedAt,
  });
}

/** Owns Program community configuration and atomic primary-Room provisioning. */
export class ProgramCommunitySettingsService {
  private readonly now: () => Date;
  private readonly programs: Model<IProgram>;
  private readonly settings: Model<IProgramCommunitySettings>;
  private readonly conversations: Model<IConversation>;
  private readonly idempotency: IdempotencyService;
  private readonly roomProvisioner: Pick<
    ProgramRoomProvisioner,
    "ensurePrimaryRoomInTransaction"
  >;
  private readonly writeRequiredAudit: RequiredAuditWriter;
  private readonly casUpdate: SettingsCasUpdate;

  constructor(dependencies: ProgramCommunitySettingsServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.programs = dependencies.programModel ?? Program;
    this.settings = dependencies.settingsModel ?? ProgramCommunitySettings;
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.roomProvisioner =
      dependencies.roomProvisioner ?? programRoomProvisioner;
    this.writeRequiredAudit =
      dependencies.writeRequiredAudit ??
      AuditLogService.recordRequiredInTransaction.bind(AuditLogService);
    this.casUpdate =
      dependencies.casUpdate ??
      ((input) => CasService.update<IProgramCommunitySettings>(input));
  }

  async get(programId: string): Promise<ProgramCommunitySettingsDTO> {
    const id = inputObjectId(programId, "programId");
    const [program, settings, room] = await Promise.all([
      this.programs.findById(id),
      this.settings.findOne({ programId: id }),
      this.conversations
        .findOne({ kind: "program", programId: id })
        .select("_id status archivedAt purgeAt"),
    ]);
    if (!program) {
      throw new ProgramCommunitySettingsError("PROGRAM_NOT_FOUND", 404);
    }
    const primaryConversationId = room ? String(room._id) : null;
    if (
      settings?.enabled &&
      (!room ||
        room.status !== "current" ||
        room.archivedAt != null ||
        room.purgeAt != null)
    ) {
      throw new ProgramCommunitySettingsError(
        "PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT",
        409,
      );
    }
    return settings
      ? buildProgramCommunitySettingsDTO(settings, primaryConversationId)
      : virtualDto(program, primaryConversationId);
  }

  async update(
    input: UpdateProgramCommunitySettingsInput,
  ): Promise<ProgramCommunitySettingsMutationResult> {
    const programId = inputObjectId(input.programId, "programId");
    const actorId = inputObjectId(input.actor.id, "actor.id");
    let execution;
    try {
      execution =
        await this.idempotency.execute<ProgramCommunitySettingsMutationResponse>(
          {
            scope: "program.community-settings.update",
            actorKey: actorId.toString(),
            key: input.idempotencyKey,
            requestPayload: {
              programId: programId.toString(),
              enabled: input.enabled,
              opensAt: iso(input.opensAt),
              closesAt: iso(input.closesAt),
              studentRoleMappings: input.studentRoleMappings,
              expectedRevision: input.expectedRevision,
            },
            execute: async (session) => {
              const program = await this.programs.findById(programId).session(session);
              if (!program) {
                throw new ProgramCommunitySettingsError("PROGRAM_NOT_FOUND", 404);
              }
              const current = await this.settings
                .findOne({ programId })
                .session(session);
              const currentRevision = current
                ? storedRevision(current.revision)
                : 0;
              if (currentRevision !== input.expectedRevision) {
                throw revisionConflict();
              }
              if (current?.archivedAt) {
                throw new ProgramCommunitySettingsError(
                  "PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT",
                  409,
                );
              }
              const now = validNow(this.now());
              if (current?.enabled && current.closesAt != null) {
                const closesAt = new Date(current.closesAt);
                if (
                  Number.isNaN(closesAt.getTime()) ||
                  now.getTime() >= closesAt.getTime()
                ) {
                  throw new ProgramCommunitySettingsError(
                    "PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT",
                    409,
                  );
                }
              }

              const normalizedMappings = validateMappingsForProgram(
                program,
                input.studentRoleMappings,
                input.enabled,
              );
              let primaryConversationId: mongoose.Types.ObjectId | null;
              if (input.enabled) {
                primaryConversationId =
                  await this.roomProvisioner.ensurePrimaryRoomInTransaction({
                    programId,
                    provisionedAt: now,
                    session,
                  });
              } else {
                const existingRoom = await this.conversations
                  .findOne({ kind: "program", programId })
                  .select("_id")
                  .session(session);
                primaryConversationId = existingRoom?._id ?? null;
              }

              const nextFields = {
                enabled: input.enabled,
                opensAt: input.opensAt,
                closesAt: input.closesAt,
                studentRoleMappings: normalizedMappings,
              };

              let updated: HydratedDocument<IProgramCommunitySettings>;
              const unchanged =
                !!current &&
                current.enabled === input.enabled &&
                sameDate(current.opensAt, input.opensAt) &&
                sameDate(current.closesAt, input.closesAt) &&
                sameMappings(
                  mappingDto(current.studentRoleMappings),
                  normalizedMappings,
                );

              if (unchanged) {
                updated = current;
              } else if (!current) {
                [updated] = await this.settings.create(
                  [
                    {
                      programId,
                      ...nextFields,
                      archivedAt: null,
                      membershipProjectionRevision: 0,
                      membershipProjectionState: "pending",
                      revision: 1,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ],
                  { session },
                );
              } else {
                const candidate = new this.settings({
                  ...current.toObject(),
                  ...nextFields,
                  membershipProjectionState: "pending",
                  revision: currentRevision + 1,
                  updatedAt: now,
                });
                await candidate.validate();
                updated = await this.casUpdate({
                  model: this.settings,
                  id: current._id,
                  expectedRevision: currentRevision,
                  update: {
                    $set: {
                      ...nextFields,
                      membershipProjectionState: "pending",
                      updatedAt: now,
                    },
                  },
                  session,
                });
              }

              const changedFields = current
                ? [
                    ...(current.enabled !== input.enabled ? ["enabled"] : []),
                    ...(!sameDate(current.opensAt, input.opensAt)
                      ? ["opensAt"]
                      : []),
                    ...(!sameDate(current.closesAt, input.closesAt)
                      ? ["closesAt"]
                      : []),
                    ...(!sameMappings(
                      mappingDto(current.studentRoleMappings),
                      normalizedMappings,
                    )
                      ? ["studentRoleMappings"]
                      : []),
                  ]
                : [
                    "enabled",
                    "opensAt",
                    "closesAt",
                    "studentRoleMappings",
                  ];

              await this.writeRequiredAudit(
                {
                  action: "program.community_settings_updated",
                  actor: {
                    type: "user",
                    id: input.actor.id,
                    role: input.actor.role,
                  },
                  source: "http",
                  outcome: unchanged ? "noop" : "success",
                  target: {
                    model: "ProgramCommunitySettings",
                    id: String(updated._id),
                  },
                  correlationId: input.correlationId,
                  details: {
                    programId: programId.toString(),
                    fromRevision: currentRevision,
                    toRevision: storedRevision(updated.revision),
                    changedFields,
                    enabled: updated.enabled,
                    opensAt: iso(updated.opensAt),
                    closesAt: iso(updated.closesAt),
                    archivedAt: iso(updated.archivedAt),
                    studentRoleMappings: mappingDto(
                      updated.studentRoleMappings,
                    ),
                  },
                },
                session,
              );

              return {
                httpStatus: 200,
                response: mutationResponse(updated, primaryConversationId),
                resource: {
                  type: "ProgramCommunitySettings",
                  id: String(updated._id),
                },
              };
            },
          },
        );
    } catch (error) {
      if (duplicateKey(error)) throw revisionConflict();
      throw error;
    }

    return Object.freeze({
      replayed: execution.replayed,
      settings: dtoFromMutationResponse(execution.response!),
    });
  }
}

export const programCommunitySettingsService =
  new ProgramCommunitySettingsService();
