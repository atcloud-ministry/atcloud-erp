import type { ChatDisplayMessage } from "./ChatMessageItem";
import ChatMessageItem from "./ChatMessageItem";

export default function ChatMessageList({
  messages,
  currentUserId,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
}: {
  messages: ChatDisplayMessage[];
  currentUserId: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (message: ChatDisplayMessage) => void;
}) {
  return (
    <section aria-label="Conversation messages" className="min-h-full px-3 py-4 sm:px-6">
      {hasOlder && (
        <div className="mb-4 text-center">
          <button
            className="min-h-11 rounded-md px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
            disabled={loadingOlder}
            onClick={onLoadOlder}
            type="button"
          >
            {loadingOlder ? "Loading..." : "Load older messages"}
          </button>
        </div>
      )}
      {messages.length === 0 ? (
        <div className="flex min-h-48 items-center justify-center text-center text-sm text-gray-600">
          No messages yet. Start the conversation when you are ready.
        </div>
      ) : (
        <ol
          aria-live="polite"
          aria-relevant="additions"
          className="space-y-3"
          role="log"
        >
          {messages.map((message) => (
            <ChatMessageItem
              currentUserId={currentUserId}
              key={`${message.id}:${message.clientMessageId}`}
              message={message}
              onRetry={onRetry}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
