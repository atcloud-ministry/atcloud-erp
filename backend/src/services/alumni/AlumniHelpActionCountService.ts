import { Types } from "mongoose";
import AlumniHelpRequest from "../../models/AlumniHelpRequest";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export function buildAlumniHelpActionRequiredFilter(
  userId: string,
  now: Date = new Date(),
): Readonly<Record<string, unknown>> {
  if (!OBJECT_ID_PATTERN.test(userId)) {
    throw new TypeError("Alumni Help action count requires a valid user ID.");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("Alumni Help action count requires a valid timestamp.");
  }
  const canonicalUserId = new Types.ObjectId(userId);
  const cutoff = new Date(now);
  return Object.freeze({
    $and: Object.freeze([
      Object.freeze({
        $or: Object.freeze([
          Object.freeze({ providerId: canonicalUserId, status: "requested" }),
          Object.freeze({
            requesterId: canonicalUserId,
            status: "needs_information",
          }),
          Object.freeze({
            requesterId: canonicalUserId,
            status: "alternative_proposed",
          }),
          Object.freeze({
            providerId: canonicalUserId,
            latestOutcomeStatus: "pending",
          }),
          Object.freeze({
            requesterId: canonicalUserId,
            latestOutcomeStatus: "denied",
          }),
        ]),
      }),
      Object.freeze({
        $or: Object.freeze([
          Object.freeze({ purgeAt: Object.freeze({ $exists: false }) }),
          Object.freeze({ purgeAt: null }),
          Object.freeze({ purgeAt: Object.freeze({ $gt: cutoff }) }),
        ]),
      }),
    ]),
  });
}

export interface AlumniHelpActionCountReader {
  countForUser(userId: string, signal?: AbortSignal): Promise<number>;
}

/** Counts request documents, so overlapping action predicates remain unique. */
export class AlumniHelpActionCountService
  implements AlumniHelpActionCountReader
{
  async countForUser(
    userId: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const query = AlumniHelpRequest.countDocuments(
      buildAlumniHelpActionRequiredFilter(userId),
    );
    if (signal) query.setOptions({ signal });
    const count = await query.exec();
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Alumni Help action count query returned an invalid value.");
    }
    return count;
  }
}

export const alumniHelpActionCountService =
  new AlumniHelpActionCountService();
