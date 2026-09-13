import mongoose, { type ClientSession, type Model } from "mongoose";
import Conversation, { type IConversation } from "../../models/Conversation";
import {
  programPurchaseRolePreflightService,
  type ProgramPurchaseRolePreflightService,
} from "./ProgramPurchaseRolePreflightService";

export interface EnsurePrimaryProgramRoomInput {
  readonly programId: mongoose.Types.ObjectId;
  readonly provisionedAt: Date;
  readonly session: ClientSession;
}

export interface ProgramRoomProvisionerDependencies {
  readonly conversationModel?: Model<IConversation>;
  readonly purchaseRolePreflight?: Pick<
    ProgramPurchaseRolePreflightService,
    "assertResolvedInTransaction"
  >;
}

export class ProgramRoomProvisioningConflictError extends Error {
  readonly name = "ProgramRoomProvisioningConflictError";
  readonly code = "PROGRAM_PRIMARY_ROOM_CONFLICT";

  constructor() {
    super("The Program primary Room conflicts with retained Room state.");
  }
}

function requireTransaction(session: ClientSession): void {
  if (!session || typeof session.inTransaction !== "function") {
    throw new TypeError("Program Room provisioning requires a transaction.");
  }
  let active = false;
  try {
    active = session.inTransaction();
  } catch {
    active = false;
  }
  if (!active) {
    throw new TypeError("Program Room provisioning requires a transaction.");
  }
}

/** Creates exactly one durable primary Room for a Program inside its caller's transaction. */
export class ProgramRoomProvisioner {
  private readonly conversations: Model<IConversation>;
  private readonly purchaseRolePreflight: Pick<
    ProgramPurchaseRolePreflightService,
    "assertResolvedInTransaction"
  >;

  constructor(dependencies: ProgramRoomProvisionerDependencies = {}) {
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.purchaseRolePreflight =
      dependencies.purchaseRolePreflight ?? programPurchaseRolePreflightService;
  }

  async ensurePrimaryRoomInTransaction(
    input: EnsurePrimaryProgramRoomInput,
  ): Promise<mongoose.Types.ObjectId> {
    requireTransaction(input.session);
    if (!(input.programId instanceof mongoose.Types.ObjectId)) {
      throw new TypeError("Program Room provisioning requires a Program ID.");
    }
    if (
      !(input.provisionedAt instanceof Date) ||
      Number.isNaN(input.provisionedAt.getTime())
    ) {
      throw new TypeError("Program Room provisioning requires a valid time.");
    }

    await this.purchaseRolePreflight.assertResolvedInTransaction(
      input.programId,
      input.session,
    );

    const room = await this.conversations.findOneAndUpdate(
      { programId: input.programId },
      {
        $setOnInsert: {
          _id: new mongoose.Types.ObjectId(),
          kind: "program",
          status: "current",
          helpRequestId: null,
          programId: input.programId,
          lastSequence: 0,
          lastMessageId: null,
          latestMessagePurgeAt: null,
          archivedAt: null,
          purgeAt: null,
          revision: 0,
          createdAt: input.provisionedAt,
          updatedAt: input.provisionedAt,
        },
      },
      {
        upsert: true,
        new: true,
        session: input.session,
        runValidators: true,
        setDefaultsOnInsert: true,
        timestamps: false,
      },
    );
    if (
      !room ||
      room.kind !== "program" ||
      !room.programId?.equals(input.programId) ||
      room.helpRequestId != null ||
      room.status !== "current" ||
      room.archivedAt != null ||
      room.purgeAt != null
    ) {
      throw new ProgramRoomProvisioningConflictError();
    }
    return room._id;
  }
}

export const programRoomProvisioner = new ProgramRoomProvisioner();
