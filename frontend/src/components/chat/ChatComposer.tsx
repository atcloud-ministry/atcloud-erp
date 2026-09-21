import { LinkIcon, PaperAirplaneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  CHAT_MESSAGE_MAX_CODE_POINTS,
  CHAT_SAFE_LINK_MAX_URL_LENGTH,
  isValidChatSafeLinkUrl,
} from "../../services/api";

export interface ChatComposerValue {
  content: string | null;
  safeLink?: { url: string; label?: string };
}

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_COMPOSER_HEIGHT_PX = 144;

export default function ChatComposer({
  disabled = false,
  sending = false,
  onSend,
}: {
  disabled?: boolean;
  sending?: boolean;
  onSend: (value: ChatComposerValue) => void;
}) {
  const [content, setContent] = useState("");
  const [showLink, setShowLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const linkUrlRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const contentLength = Array.from(content).length;
  const normalizedContent = content.normalize("NFC").trim();
  const normalizedUrl = linkUrl.trim();
  const normalizedLabel = linkLabel.normalize("NFC").trim();

  const error = useMemo(() => {
    if (contentLength > CHAT_MESSAGE_MAX_CODE_POINTS) {
      return "Messages cannot exceed 4,000 characters.";
    }
    if (showLink && normalizedUrl) {
      if (Array.from(normalizedUrl).length > CHAT_SAFE_LINK_MAX_URL_LENGTH) {
        return "The link cannot exceed 2,048 characters.";
      }
      if (!isValidChatSafeLinkUrl(normalizedUrl)) {
        return "Links must use a valid http:// or https:// address.";
      }
    }
    const payload = {
      clientMessageId: "00000000-0000-4000-8000-000000000000",
      content: normalizedContent,
      ...(showLink && normalizedUrl
        ? {
            safeLink: {
              url: normalizedUrl,
              ...(normalizedLabel ? { label: normalizedLabel } : {}),
            },
          }
        : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_REQUEST_BYTES) {
      return "The message and link are too large to send together.";
    }
    return null;
  }, [contentLength, normalizedContent, normalizedLabel, normalizedUrl, showLink]);

  const canSubmit =
    !disabled &&
    !sending &&
    (!!normalizedContent || (showLink && !!normalizedUrl)) &&
    !error;
  const linkHasError = Boolean(
    error &&
      (error.startsWith("The link") || error.startsWith("Links must")),
  );
  const messageHasError = Boolean(error && !linkHasError);

  useEffect(() => {
    if (showLink) linkUrlRef.current?.focus();
  }, [showLink]);

  // Keep the composer compact for one line, then grow with the message until
  // its existing 9rem visual limit. Past that limit, the field scrolls rather
  // than pushing the message history or the action buttons out of position.
  useLayoutEffect(() => {
    const textarea = messageRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const naturalHeight = textarea.scrollHeight;
    if (naturalHeight <= 0) {
      textarea.style.removeProperty("height");
      textarea.style.removeProperty("overflow-y");
      return;
    }
    const height = Math.min(naturalHeight, MAX_COMPOSER_HEIGHT_PX);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY =
      naturalHeight > MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
  }, [content]);

  const removeLink = () => {
    setShowLink(false);
    setLinkUrl("");
    setLinkLabel("");
    window.requestAnimationFrame(() => linkButtonRef.current?.focus());
  };

  const submit = () => {
    if (!canSubmit) return;
    messageRef.current?.focus();
    onSend({
      content: normalizedContent || null,
      ...(showLink && normalizedUrl
        ? {
            safeLink: {
              url: normalizedUrl,
              ...(normalizedLabel ? { label: normalizedLabel } : {}),
            },
          }
        : {}),
    });
    setContent("");
    setLinkUrl("");
    setLinkLabel("");
    setShowLink(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      aria-busy={sending}
      aria-label="Send a Chat Room message"
      className="border-t border-gray-200 bg-white p-3 sm:p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {showLink && (
        <fieldset
          className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3"
          id="chat-safe-link-fields"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            removeLink();
          }}
        >
          <legend className="px-1 text-sm font-semibold text-gray-800">
            Safe link
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-gray-700" htmlFor="chat-link-url">
                URL
              </label>
              <input
                aria-describedby={linkHasError ? "chat-message-error" : undefined}
                aria-invalid={linkHasError}
                className="mt-1 min-h-11 w-full rounded-md border border-gray-500 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={disabled || sending}
                id="chat-link-url"
                inputMode="url"
                onChange={(event) => setLinkUrl(event.target.value)}
                placeholder="https://example.com"
                ref={linkUrlRef}
                type="url"
                value={linkUrl}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700" htmlFor="chat-link-label">
                Link label (optional)
              </label>
              <input
                className="mt-1 min-h-11 w-full rounded-md border border-gray-500 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={disabled || sending}
                id="chat-link-label"
                maxLength={200}
                onChange={(event) => setLinkLabel(event.target.value)}
                placeholder="Open shared resource"
                type="text"
                value={linkLabel}
              />
            </div>
          </div>
          <button
            className="mt-2 inline-flex min-h-11 items-center gap-1 rounded px-2 text-xs font-medium text-gray-700 hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            onClick={removeLink}
            type="button"
          >
            <XMarkIcon aria-hidden="true" className="h-4 w-4" />
            Remove link
          </button>
        </fieldset>
      )}
      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-x-3">
        <button
          aria-controls="chat-safe-link-fields"
          aria-expanded={showLink}
          aria-label={showLink ? "Hide safe link fields" : "Add a safe link"}
          aria-pressed={showLink}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center self-center !rounded-full !border-0 !bg-transparent !p-0 text-gray-600 hover:!border-transparent hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
          disabled={disabled || sending}
          onClick={() => setShowLink((value) => !value)}
          ref={linkButtonRef}
          type="button"
        >
          <LinkIcon aria-hidden="true" className="h-6 w-6 stroke-2" />
        </button>
        <label className="sr-only" htmlFor="chat-message-composer">
          Message
        </label>
        <textarea
          aria-describedby="chat-message-help chat-message-error"
          aria-disabled={disabled || sending}
          aria-invalid={messageHasError}
          className="block min-h-11 max-h-36 w-full resize-none rounded-2xl border border-gray-500 px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400 disabled:bg-gray-100"
          id="chat-message-composer"
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a message…"
          ref={messageRef}
          readOnly={disabled || sending}
          rows={1}
          value={content}
        />
        <button
          aria-label="Send message"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center self-center !rounded-full !border-0 !bg-blue-600 !p-0 text-white hover:!border-transparent hover:!bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          type="submit"
        >
          <PaperAirplaneIcon aria-hidden="true" className="h-6 w-6 stroke-2" />
        </button>
        <div className="col-start-2 mt-1 flex justify-between gap-2 px-1 text-xs">
          <span aria-live="polite" className={error ? "text-red-700" : "text-gray-600"} id="chat-message-error" role={error ? "alert" : undefined}>
            {error ?? ""}
          </span>
          <span
            className={
              contentLength > CHAT_MESSAGE_MAX_CODE_POINTS
                ? "text-red-700"
                : "text-gray-600"
            }
            id="chat-message-help"
          >
            {contentLength.toLocaleString()} / 4,000
          </span>
        </div>
      </div>
      <p className="sr-only">Press Enter to send. Press Shift and Enter for a new line.</p>
      <span aria-live="polite" className="sr-only">
        {sending ? "Sending message." : ""}
      </span>
    </form>
  );
}
