import {
  BellSlashIcon,
  ChatBubbleOvalLeftEllipsisIcon,
} from "@heroicons/react/24/outline";
import { useId } from "react";
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
  const descriptionId = useId();
  const accessibleName =
    unreadCount > 0
      ? `${room.title}, ${unreadCount} unread ${
          unreadCount === 1 ? "message" : "messages"
        }`
      : room.title;
  const unreadDescription =
    unreadCount > 0
      ? `${unreadCount} unread ${unreadCount === 1 ? "message" : "messages"}. `
      : "";
  return (
    <li>
      <Link
        aria-describedby={descriptionId}
        aria-label={accessibleName}
        className="group flex min-h-[76px] items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 sm:px-5"
        to={`/dashboard/chat-rooms/${encodeURIComponent(room.id)}`}
      >
        {room.counterpart ? (
          <ChatAvatar
            avatar={room.counterpart.avatar}
            displayName={room.counterpart.displayName}
          />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
            <ChatBubbleOvalLeftEllipsisIcon
              aria-hidden="true"
              className="h-6 w-6"
            />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span
              className={`truncate text-[0.9375rem] text-gray-900 ${
                unreadCount > 0 ? "font-semibold" : "font-medium"
              }`}
            >
              {room.title}
            </span>
            <time
              className={`shrink-0 text-xs ${
                unreadCount > 0 ? "font-medium text-brand-700" : "text-gray-400"
              }`}
              dateTime={room.lastMessage?.createdAt ?? room.updatedAt}
            >
              {formatRoomTime(room.lastMessage?.createdAt ?? room.updatedAt)}
            </time>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-sm ${
                unreadCount > 0 ? "text-gray-800" : "text-gray-500"
              }`}
            >
              {messagePreview(room)}
            </span>
            {room.viewer.muted && (
              <BellSlashIcon
                aria-label="Notifications muted"
                className="h-4 w-4 shrink-0 text-gray-400"
              />
            )}
            {unreadCount > 0 && (
              <span
                aria-hidden="true"
                className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white tabular-nums"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs text-gray-400">
            {room.kind === "alumni_help" ? "Alumni Help" : "Program"}
            {` · ${room.section === "current" ? "Current" : "Past"}`}
            {` · ${
              room.viewer.accessMode === "read_write"
                ? "Read/write"
                : "Read-only"
            }`}
          </span>
          <span className="sr-only" id={descriptionId}>
            {unreadDescription}
            {messagePreview(room)}. Notifications{" "}
            {room.viewer.muted ? "muted" : "active"}.{" "}
            {room.kind === "alumni_help" ? "Alumni Help" : "Program"} Room,{" "}
            {room.section === "current" ? "current" : "past"},{" "}
            {room.viewer.accessMode === "read_write"
              ? "read and write"
              : "read only"}
            .
          </span>
        </span>
      </Link>
    </li>
  );
}

export { formatRoomTime, messagePreview };
