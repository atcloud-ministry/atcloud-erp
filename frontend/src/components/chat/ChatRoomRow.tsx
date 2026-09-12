import {
  BellSlashIcon,
  ChatBubbleOvalLeftEllipsisIcon,
} from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";
import type { ConversationDTO } from "../../services/api";
import ChatAvatar from "./ChatAvatar";

function formatRoomTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" }),
  }).format(date);
}

function messagePreview(room: ConversationDTO): string {
  const message = room.lastMessage;
  if (!message) return "No messages yet";
  if (message.contentPreview?.trim()) {
    return message.contentPreview.replace(/\s+/gu, " ");
  }
  if (message.safeLink) return `Shared ${message.safeLink.label}`;
  return message.kind === "announcement" ? "Announcement" : "New message";
}

export default function ChatRoomRow({
  room,
  unreadCount = room.viewer.unreadCount,
}: {
  room: ConversationDTO;
  unreadCount?: number;
}) {
  const accessibleName =
    unreadCount > 0
      ? `${room.title}, ${unreadCount} unread messages`
      : room.title;
  return (
    <li>
      <Link
        aria-label={accessibleName}
        className="group flex min-h-[76px] items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:p-4"
        to={`/dashboard/chat-rooms/${encodeURIComponent(room.id)}`}
      >
        {room.counterpart ? (
          <ChatAvatar
            avatar={room.counterpart.avatar}
            displayName={room.counterpart.displayName}
          />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
            <ChatBubbleOvalLeftEllipsisIcon
              aria-hidden="true"
              className="h-6 w-6"
            />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-3">
            <span className="truncate font-semibold text-gray-900 group-hover:text-blue-800">
              {room.title}
            </span>
            <time
              className="shrink-0 text-xs text-gray-500"
              dateTime={room.lastMessage?.createdAt ?? room.updatedAt}
            >
              {formatRoomTime(room.lastMessage?.createdAt ?? room.updatedAt)}
            </time>
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-gray-600">
              {messagePreview(room)}
            </span>
            {room.viewer.muted && (
              <BellSlashIcon
                aria-label="Notifications muted"
                className="h-4 w-4 shrink-0 text-gray-500"
              />
            )}
            {unreadCount > 0 && (
              <span
                aria-hidden="true"
                className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs font-medium text-gray-500">
            {room.kind === "alumni_help" ? "Alumni Help" : "Program"}
            {room.viewer.accessMode === "read_only" ? " · Read-only" : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

export { formatRoomTime, messagePreview };
