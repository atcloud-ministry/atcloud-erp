import { Icon } from "../common";
import { formatViewerLocalDateTime } from "../../utils/timezoneUtils";
import { messageTypeHelpers } from "../../utils/messageTypeHelpers";
import { getHashRouteUrl } from "../../utils/hashRouting";
import { getAlumniHelpRequestPath } from "../../utils/alumniHelpNotification";

interface TimingMeta {
  originalDate?: string;
  originalTime?: string;
  originalTimeZone?: string;
  eventDateTimeUtc?: string;
}

interface RoleInviteMetadata {
  eventId?: string;
  eventDetailUrl?: string;
  rejectionLink?: string;
  timing?: TimingMeta;
}

interface GenericCtaMetadata {
  ctaUrl?: string;
  ctaLabel?: string;
}

interface MessageCreator {
  id: string;
  firstName: string;
  lastName: string;
  avatar?: string | null;
  gender?: "male" | "female";
  authLevel?: string;
  roleInAtCloud?: string;
}

interface SystemMessage {
  id: string;
  title: string;
  content: string;
  type: string;
  priority: "high" | "medium" | "low";
  isRead: boolean;
  readAt?: string;
  createdAt: string;
  creator?: MessageCreator;
  metadata?: Record<string, unknown>;
}

interface MessageListItemProps {
  message: SystemMessage;
  currentUserId?: string;
  canNavigateToProfiles: boolean;
  avatarUpdateCounter: number;
  onMessageClick: (messageId: string) => void;
  onDeleteMessage: (e: React.MouseEvent, messageId: string) => void;
  onNameCardClick: (userId: string) => void;
  formatDate: (date: string) => string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isTimingMeta(v: unknown): v is TimingMeta {
  if (!isRecord(v)) return false;
  const od = v["originalDate"];
  const ot = v["originalTime"];
  const oz = v["originalTimeZone"];
  const utc = v["eventDateTimeUtc"];
  const ok =
    (od === undefined || typeof od === "string") &&
    (ot === undefined || typeof ot === "string") &&
    (oz === undefined || typeof oz === "string") &&
    (utc === undefined || typeof utc === "string");
  return ok;
}

function readRoleInviteMetadata(message: SystemMessage): RoleInviteMetadata {
  const meta = message.metadata;
  if (!isRecord(meta)) return {};
  const eventId = typeof meta.eventId === "string" ? meta.eventId : undefined;
  const metaRec = meta as Record<string, unknown>;
  const eventDetailUrl =
    typeof metaRec["eventDetailUrl"] === "string"
      ? String(metaRec["eventDetailUrl"])
      : undefined;
  const rejectionLink =
    typeof metaRec["rejectionLink"] === "string"
      ? String(metaRec["rejectionLink"])
      : undefined;
  const timingRaw = metaRec["timing"];
  const timing = isTimingMeta(timingRaw) ? timingRaw : undefined;
  return { eventId, eventDetailUrl, rejectionLink, timing };
}

function readGenericCtaMetadata(message: SystemMessage): GenericCtaMetadata {
  const meta = message.metadata;
  if (!isRecord(meta)) return {};
  const ctaUrl =
    typeof meta.ctaUrl === "string" ? String(meta.ctaUrl) : undefined;
  const ctaLabel =
    typeof meta.ctaLabel === "string" ? String(meta.ctaLabel) : undefined;
  return { ctaUrl, ctaLabel };
}

/**
 * MessageListItem - Individual system message card component
 *
 * Displays a system message with:
 * - Header with type icon, title, date, priority badge, delete button, and unread indicator
 * - Content with role invite metadata parsing and local time formatting
 * - Call-to-action buttons for event links and role invitations
 * - Creator information with avatar and role (clickable if authorized)
 * - Read timestamp for read messages
 * - Type badge
 */
export default function MessageListItem({
  message,
  currentUserId,
  canNavigateToProfiles,
  avatarUpdateCounter,
  onMessageClick,
  onDeleteMessage,
  onNameCardClick,
  formatDate,
}: MessageListItemProps) {
  return (
    <div
      key={message.id}
      id={message.id}
      onClick={() => onMessageClick(message.id)}
      className={`bg-white rounded-lg shadow-sm border cursor-pointer transition-all duration-200 hover:shadow-md ${
        !message.isRead
          ? "border-blue-200 bg-blue-50"
          : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div
              className={`${messageTypeHelpers.getTypeColor(
                message.type,
                message
              )}`}
            >
              {messageTypeHelpers.getTypeIcon(message.type, message)}
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900">
                {message.title}
              </h3>
              <p className="text-sm text-gray-500">
                {formatDate(message.createdAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            {/* Priority Badge */}
            <span
              className={`px-2 py-1 text-xs font-medium rounded-md border ${messageTypeHelpers.getPriorityColor(
                message.priority
              )}`}
            >
              {message.priority.toUpperCase()}
            </span>
            {/* Delete Button */}
            <button
              onClick={(e) => onDeleteMessage(e, message.id)}
              className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200"
              title="Delete message"
            >
              <Icon name="trash" className="w-4 h-4" />
            </button>
            {/* Unread Indicator */}
            {!message.isRead && (
              <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="prose prose-sm max-w-none">
          <p className="text-gray-700 leading-relaxed whitespace-pre-wrap">
            {(() => {
              // Replace Event Time line with viewer local time for Role Invited messages
              if (
                message.type === "event_role_change" &&
                message.title === "Role Invited"
              ) {
                const { timing } = readRoleInviteMetadata(message);
                if (timing?.originalDate && timing?.originalTime) {
                  const localized = formatViewerLocalDateTime({
                    date: timing.originalDate,
                    time: timing.originalTime,
                    timeZone: timing.originalTimeZone,
                    eventDateTimeUtc: timing.eventDateTimeUtc,
                  });
                  if (localized) {
                    return message.content.replace(
                      /Event Time:.*?(\n|$)/,
                      `Event Time: ${localized.date} • ${localized.time} (your local time)$1`
                    );
                  }
                }
              }
              return message.content;
            })()}
          </p>
          {(() => {
            const requestPath = getAlumniHelpRequestPath(message.metadata);
            if (!requestPath) return null;
            return (
              <div className="mt-4">
                <a
                  href={getHashRouteUrl(requestPath)}
                  onClick={(e) => e.stopPropagation()}
                  className="block w-full rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-center font-semibold text-white shadow transition-all hover:from-blue-700 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  View Help Request
                </a>
              </div>
            );
          })()}
          {/* Local time already inlined by replacing Event Time line above */}
          {typeof message.metadata?.eventId === "string" &&
            (message.title.startsWith("New Event:") ||
              message.title.startsWith("Event Updated:") ||
              message.title.startsWith("New Recurring Program:")) && (
              <div className="mt-4">
                <a
                  href={`/dashboard/event/${String(message.metadata?.eventId)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="block w-full text-center bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-3 px-4 rounded-lg shadow focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all"
                >
                  View Event Details
                </a>
              </div>
            )}

          {(() => {
            const { ctaUrl, ctaLabel } = readGenericCtaMetadata(message);
            if (!ctaUrl) return null;
            return (
              <div className="mt-4">
                <a
                  href={ctaUrl}
                  onClick={(e) => e.stopPropagation()}
                  className="block w-full text-center bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-3 px-4 rounded-lg shadow focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all"
                >
                  {ctaLabel || "Open"}
                </a>
              </div>
            );
          })()}

          {/* CTA buttons for Role Invited system messages */}
          {message.type === "event_role_change" &&
            message.title === "Role Invited" && (
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(() => {
                  const { eventId, eventDetailUrl } =
                    readRoleInviteMetadata(message);
                  const href =
                    eventDetailUrl ||
                    (typeof eventId === "string"
                      ? `/dashboard/event/${eventId}`
                      : undefined);
                  if (!href) return null;
                  return (
                    <a
                      href={href}
                      onClick={(e) => e.stopPropagation()}
                      className="block w-full text-center bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-3 px-4 rounded-lg shadow focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all"
                    >
                      See the Event & Role Details
                    </a>
                  );
                })()}

                {(() => {
                  const { rejectionLink } = readRoleInviteMetadata(message);
                  if (typeof rejectionLink !== "string") return null;
                  return (
                    <a
                      href={rejectionLink}
                      onClick={(e) => e.stopPropagation()}
                      className="block w-full text-center bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-3 px-4 rounded-lg shadow focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-400 transition-all"
                    >
                      Decline This Invitation
                    </a>
                  );
                })()}
              </div>
            )}
        </div>

        {/* Creator Information */}
        {message.creator && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div
              className={`flex items-center space-x-3 -mx-2 px-2 py-2 rounded-md transition-colors ${
                canNavigateToProfiles ||
                message.creator.id ===
                  (currentUserId || "550e8400-e29b-41d4-a716-446655440000")
                  ? "cursor-pointer hover:bg-gray-50"
                  : "cursor-default"
              }`}
              onClick={(e) => {
                e.stopPropagation(); // Prevent triggering the message click
                if (message.creator) {
                  onNameCardClick(message.creator.id);
                }
              }}
              title={
                canNavigateToProfiles ||
                message.creator.id ===
                  (currentUserId || "550e8400-e29b-41d4-a716-446655440000")
                  ? `View ${message.creator.firstName} ${message.creator.lastName}'s profile`
                  : undefined
              }
            >
              {(() => {
                const baseAvatar = message.creator.avatar || null;
                let avatarUrl;

                if (baseAvatar && !baseAvatar.includes("default-avatar")) {
                  // Keep the existing URL from database (which has fresh timestamp)
                  // Just add counter to ensure browser sees it as different
                  const separator = baseAvatar.includes("?") ? "&" : "?";
                  avatarUrl = `${baseAvatar}${separator}v=${avatarUpdateCounter}`;
                } else {
                  // Use default avatar
                  const gender = message.creator.gender;
                  avatarUrl =
                    gender === "male"
                      ? "/default-avatar-male.jpg"
                      : "/default-avatar-female.jpg";
                }

                return (
                  <img
                    className="w-8 h-8 rounded-full object-cover"
                    src={avatarUrl}
                    alt={`${message.creator.firstName} ${message.creator.lastName}`}
                  />
                );
              })()}
              <div>
                <p className="text-sm font-medium text-gray-900 hover:text-blue-600 transition-colors">
                  {message.creator.firstName} {message.creator.lastName}
                </p>
                {/* Show both authLevel and roleInAtCloud when available */}
                {(message.creator.authLevel ||
                  message.creator.roleInAtCloud) && (
                  <p className="text-xs text-gray-500">
                    {[message.creator.authLevel, message.creator.roleInAtCloud]
                      .filter(Boolean) // Remove null/undefined values
                      .filter(
                        (value, index, array) => array.indexOf(value) === index
                      ) // Remove duplicates
                      .join(" • ")}{" "}
                    {/* Use bullet separator */}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Read Timestamp for read messages */}
        {message.isRead && message.readAt && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <span className="inline-flex items-center space-x-1 text-xs text-gray-500">
              <span>Read:</span>
              <span className="font-medium">{formatDate(message.readAt)}</span>
            </span>
          </div>
        )}

        {/* Type Badge */}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <span className="inline-flex items-center space-x-1 text-xs text-gray-500">
            <span>Type:</span>
            <span className="font-medium capitalize">
              {message.type.replace("_", " ")}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
