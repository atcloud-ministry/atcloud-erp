import { Types } from "mongoose";
import type {
  AlumniHelpActionRequiredCountDTO,
  AlumniHelpParticipantRole,
} from "../../contracts/alumniHelpFlow";
import AlumniHelpRequest, {
  type IAlumniHelpRequest,
} from "../../models/AlumniHelpRequest";
import { buildAlumniHelpActionRequiredFilter } from "./AlumniHelpActionCountService";

/** Sequence zero means no tracked update; revision zero is represented by one. */
export function helpUpdateMarkers(
  resultingRevision: number,
  actorRole: AlumniHelpParticipantRole | null,
): Record<string, number> {
  if (
    !Number.isSafeInteger(resultingRevision) ||
    resultingRevision < 0 ||
    resultingRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError("Alumni Help update requires a safe request revision.");
  }
  const sequence = resultingRevision + 1;
  if (actorRole === "requester") {
    return { providerUpdateSequence: sequence, requesterReadSequence: sequence };
  }
  if (actorRole === "provider") {
    return { requesterUpdateSequence: sequence, providerReadSequence: sequence };
  }
  return { requesterUpdateSequence: sequence, providerUpdateSequence: sequence };
}

export function hasUnreadHelpUpdate(
  request: Pick<
    IAlumniHelpRequest,
    | "requesterUpdateSequence"
    | "requesterReadSequence"
    | "providerUpdateSequence"
    | "providerReadSequence"
  >,
  role: AlumniHelpParticipantRole,
): boolean {
  return (
    (request[`${role}UpdateSequence`] ?? 0) >
    (request[`${role}ReadSequence`] ?? 0)
  );
}

export function buildAlumniHelpNotificationFilter(
  userId: string,
  now: Date = new Date(),
): Readonly<Record<string, unknown>> {
  // Reuse the validated action/retention policy and count the union once.
  const actionRequired = buildAlumniHelpActionRequiredFilter(userId, now);
  const canonicalUserId = new Types.ObjectId(userId);
  return {
    $and: [
      { $or: [{ purgeAt: null }, { purgeAt: { $gt: new Date(now) } }] },
      {
        $or: [
          actionRequired,
          ...(["requester", "provider"] as const).map((role) => ({
            [`${role}Id`]: canonicalUserId,
            $expr: {
              $gt: [
                { $ifNull: [`$${role}UpdateSequence`, 0] },
                { $ifNull: [`$${role}ReadSequence`, 0] },
              ],
            },
          })),
        ],
      },
    ],
  };
}

export interface AlumniHelpNotificationCountReader {
  countForUser(userId: string, signal?: AbortSignal): Promise<number>;
}

export interface AlumniHelpNotificationCountsReader {
  countsForUser(
    userId: string,
    signal?: AbortSignal,
  ): Promise<AlumniHelpActionRequiredCountDTO>;
}

/** A request with both an unread update and required action contributes only one. */
export class AlumniHelpNotificationCountService
  implements AlumniHelpNotificationCountReader, AlumniHelpNotificationCountsReader
{
  async countForUser(userId: string, signal?: AbortSignal): Promise<number> {
    return (await this.countsForUser(userId, signal)).helpNotificationCount;
  }

  async countsForUser(
    userId: string,
    signal?: AbortSignal,
  ): Promise<AlumniHelpActionRequiredCountDTO> {
    const now = new Date();
    const notifications = buildAlumniHelpNotificationFilter(userId, now);
    const query = AlumniHelpRequest.aggregate<{
      notifications: { count: number }[];
      actions: { count: number }[];
    }>([
      // Both totals are derived from the same documents in a single operation.
      // Separate queries could straddle a read/action and produce contradictory counts.
      { $match: { ...notifications } },
      {
        $facet: {
          notifications: [{ $count: "count" }],
          actions: [
            { $match: { ...buildAlumniHelpActionRequiredFilter(userId, now) } },
            { $count: "count" },
          ],
        },
      },
    ]);
    if (signal) query.option({ signal });
    const [result] = await query.exec();
    const helpNotificationCount = result?.notifications[0]?.count ?? 0;
    const helpActionRequiredCount = result?.actions[0]?.count ?? 0;
    if (
      !Number.isSafeInteger(helpNotificationCount) || helpNotificationCount < 0 ||
      !Number.isSafeInteger(helpActionRequiredCount) || helpActionRequiredCount < 0 ||
      helpActionRequiredCount > helpNotificationCount
    ) {
      throw new Error("Alumni Help notification count query returned an invalid value.");
    }
    return Object.freeze({ helpActionRequiredCount, helpNotificationCount });
  }
}

export const alumniHelpNotificationCountService =
  new AlumniHelpNotificationCountService();
