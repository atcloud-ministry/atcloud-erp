import type { ClientSession } from "mongoose";
import AlumniProfile from "../../models/AlumniProfile";
import type { IUser } from "../../models/User";
import { getRegistrationProfileReadiness } from "../RegistrationProfileService";
import { buildAlumniProfileSearchProjection } from "./AlumniProfileProjectionService";

/** Provision only a private draft. Existing profiles, consent, and roles are untouched. */
export async function ensurePrivateAlumniDraft(
  user: IUser,
  session?: ClientSession,
): Promise<boolean> {
  if (!getRegistrationProfileReadiness(user).ready) return false;

  const draft = new AlumniProfile({ userId: user._id });
  draft.searchProjection = buildAlumniProfileSearchProjection({
    user,
    profile: draft,
    affiliations: [],
  });
  const now = new Date();
  try {
    await AlumniProfile.updateOne(
      { userId: user._id },
      { $setOnInsert: {
        ...draft.toObject({ depopulate: true }),
        createdAt: now,
        updatedAt: now,
      } },
      { upsert: true, session, runValidators: true, timestamps: false },
    );
  } catch (error) {
    if (
      (error as { code?: unknown })?.code !== 11000 ||
      !(await AlumniProfile.exists({ userId: user._id }).session(session ?? null))
    ) throw error;
  }
  return true;
}
