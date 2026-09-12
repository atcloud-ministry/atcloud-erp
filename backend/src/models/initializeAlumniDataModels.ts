import AlumniAffiliation from "./AlumniAffiliation";
import AlumniImportBatch from "./AlumniImportBatch";
import AlumniInvitation from "./AlumniInvitation";
import AlumniProfile from "./AlumniProfile";
import ConsentRecord from "./ConsentRecord";
import AlumniHelpRequest from "./AlumniHelpRequest";
import AlumniHelpOutcomeSubmission from "./AlumniHelpOutcomeSubmission";
import Conversation from "./Conversation";
import ConversationMember from "./ConversationMember";
import ChatMessage from "./ChatMessage";
import Message from "./Message";

const ALUMNI_DATA_MODELS = [
  AlumniProfile,
  AlumniAffiliation,
  AlumniInvitation,
  AlumniImportBatch,
  ConsentRecord,
  AlumniHelpRequest,
  AlumniHelpOutcomeSubmission,
  Conversation,
  ConversationMember,
  ChatMessage,
  Message,
] as const;

/** Create and verify every Alumni feature index before accepting traffic. */
export async function initializeAlumniDataModels(): Promise<void> {
  await Promise.all(ALUMNI_DATA_MODELS.map((model) => model.init()));
}
