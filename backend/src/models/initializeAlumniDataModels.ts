import AlumniAffiliation from "./AlumniAffiliation";
import AlumniImportBatch from "./AlumniImportBatch";
import AlumniInvitation from "./AlumniInvitation";
import AlumniProfile from "./AlumniProfile";
import ConsentRecord from "./ConsentRecord";

const ALUMNI_DATA_MODELS = [
  AlumniProfile,
  AlumniAffiliation,
  AlumniInvitation,
  AlumniImportBatch,
  ConsentRecord,
] as const;

/** Create and verify the new empty-collection indexes before accepting traffic. */
export async function initializeAlumniDataModels(): Promise<void> {
  await Promise.all(ALUMNI_DATA_MODELS.map((model) => model.init()));
}
