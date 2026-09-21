import type { ClientSession } from "mongoose";
import AlumniAffiliation from "../../models/AlumniAffiliation";
import AlumniProfile, {
  type AlumniProfileSearchProjection,
} from "../../models/AlumniProfile";
import type { IUser } from "../../models/User";
import { buildAlumniProfileSearchProjection } from "./AlumniProfileProjectionService";

function sameValues(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameProjection(
  current: AlumniProfileSearchProjection,
  next: AlumniProfileSearchProjection,
): boolean {
  return (
    current.searchText === next.searchText &&
    current.displayNameKey === next.displayNameKey &&
    current.companyKey === next.companyKey &&
    current.occupationKey === next.occupationKey &&
    current.industryKey === next.industryKey &&
    current.generalLocationKey === next.generalLocationKey &&
    sameValues(current.skillKeys, next.skillKeys) &&
    sameValues(current.cohortKeys, next.cohortKeys)
  );
}

/**
 * Keep the rebuildable Directory projection aligned with a canonical User
 * mutation. The caller owns the transaction so the User and projection can
 * never commit independently.
 */
export async function synchronizeExistingAlumniProfileProjection(
  user: IUser,
  session: ClientSession,
): Promise<boolean> {
  if (!session.inTransaction()) {
    throw new Error(
      "Alumni profile projection synchronization requires an active transaction.",
    );
  }

  const profile = await AlumniProfile.findOne({ userId: user._id })
    .select("+searchProjection")
    .session(session);
  if (!profile) return false;

  const affiliations = await AlumniAffiliation.find({
    alumniProfileId: profile._id,
    verificationStatus: "verified",
    accountDeletionApprovedAt: null,
  })
    .select("programName cohortLabel")
    .sort({ programName: 1, cohortLabel: 1, _id: 1 })
    .session(session)
    .lean();
  const next = buildAlumniProfileSearchProjection({
    user,
    profile,
    affiliations,
  });
  if (sameProjection(profile.searchProjection, next)) return false;

  const updated = await AlumniProfile.updateOne(
    { _id: profile._id, userId: user._id },
    {
      $set: { searchProjection: next },
      $inc: { revision: 1 },
    },
    { session, runValidators: false },
  );
  if (updated.matchedCount !== 1) {
    throw new Error("Alumni profile disappeared during projection synchronization.");
  }
  return true;
}
