import type { ChatMessageDTO } from "../../services/api";
import ChatAvatar from "./ChatAvatar";

export type ChatDeliveryState = "sending" | "sent" | "failed";

export interface ChatDisplayMessage extends ChatMessageDTO {
  deliveryState?: ChatDeliveryState;
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function ChatMessageItem({
  message,
  currentUserId,
  onRetry,
}: {
  message: ChatDisplayMessage;
  currentUserId: string;
  onRetry?: (message: ChatDisplayMessage) => void;
}) {
  const own = message.sender.id === currentUserId;
  const announcement = message.kind === "announcement";

  if (announcement) {
    return (
      <li className="mx-auto max-w-2xl py-2">
        <article className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
            Announcement
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-blue-950">
            {message.content}
          </p>
          <p className="mt-2 text-xs text-blue-700">
            {message.sender.displayName} ·{" "}
            <time dateTime={message.createdAt}>
              {formatMessageTime(message.createdAt)}
            </time>
          </p>
        </article>
      </li>
    );
  }

  return (
    <li className={`flex items-end gap-2 ${own ? "justify-end" : "justify-start"}`}>
      {!own && (
        <ChatAvatar
          avatar={message.sender.avatar}
          displayName={message.sender.displayName}
          size="sm"
        />
      )}
      <article className={`max-w-[85%] sm:max-w-[72%] ${own ? "text-right" : ""}`}>
        {!own && (
          <p className="mb-1 px-1 text-xs font-medium text-gray-600">
            {message.sender.displayName}
          </p>
        )}
        <div
          className={`rounded-2xl px-4 py-2 text-left shadow-sm ${
            own
              ? "rounded-br-sm bg-blue-600 text-white"
              : "rounded-bl-sm border border-gray-200 bg-white text-gray-900"
          }`}
        >
          {message.content && (
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content}
            </p>
          )}
          {message.safeLink && (
            <a
              className={`mt-2 block break-all rounded-md px-3 py-2 text-sm font-medium underline focus:outline-none focus-visible:ring-2 ${
                own
                  ? "bg-blue-700 text-white focus-visible:ring-white"
                  : "bg-gray-50 text-blue-700 focus-visible:ring-blue-500"
              }`}
              href={message.safeLink.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {message.safeLink.label}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
        <p className="mt-1 px-1 text-xs text-gray-500">
          <time dateTime={message.createdAt}>
            {formatMessageTime(message.createdAt)}
          </time>
          {own && message.deliveryState && (
            <span aria-live="polite"> · {message.deliveryState}</span>
          )}
          {own && message.deliveryState === "failed" && onRetry && (
            <button
              className="ml-2 min-h-11 rounded px-2 font-semibold text-red-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              onClick={() => onRetry(message)}
              type="button"
            >
              Retry
            </button>
          )}
        </p>
      </article>
    </li>
  );
}

export { formatMessageTime };
