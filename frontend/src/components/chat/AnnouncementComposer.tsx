import { MegaphoneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import {
  CHAT_HTTP_PAYLOAD_MAX_BYTES,
  CHAT_MESSAGE_MAX_CODE_POINTS,
} from "../../services/api";

const CLIENT_MESSAGE_ID_PLACEHOLDER =
  "00000000-0000-4000-8000-000000000000";

export default function AnnouncementComposer({
  disabled = false,
  sending = false,
  onPublish,
}: {
  readonly disabled?: boolean;
  readonly sending?: boolean;
  readonly onPublish: (content: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState("");
  const normalizedContent = content.normalize("NFC").trim();
  const contentLength = Array.from(normalizedContent).length;
  const error = useMemo(() => {
    if (contentLength > CHAT_MESSAGE_MAX_CODE_POINTS) {
      return "Announcements cannot exceed 4,000 characters.";
    }
    if (
      new TextEncoder().encode(
        JSON.stringify({
          clientMessageId: CLIENT_MESSAGE_ID_PLACEHOLDER,
          content: normalizedContent,
        }),
      ).byteLength > CHAT_HTTP_PAYLOAD_MAX_BYTES
    ) {
      return "The announcement is too large to publish.";
    }
    return null;
  }, [contentLength, normalizedContent]);
  const canPublish =
    !disabled && !sending && normalizedContent.length > 0 && !error;

  if (!expanded) {
    return (
      <div className="border-t border-blue-100 bg-blue-50 px-3 py-2 sm:px-4">
        <button
          aria-expanded="false"
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-semibold text-blue-800 hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:w-auto"
          disabled={disabled || sending}
          onClick={() => setExpanded(true)}
          type="button"
        >
          <MegaphoneIcon aria-hidden="true" className="h-5 w-5" />
          Post announcement
        </button>
      </div>
    );
  }

  return (
    <form
      aria-label="Post Program announcement"
      className="border-t border-blue-100 bg-blue-50 p-3 sm:p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canPublish) return;
        onPublish(normalizedContent);
        setContent("");
        setExpanded(false);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <label
            className="text-sm font-semibold text-blue-950"
            htmlFor="program-announcement-composer"
          >
            Program announcement
          </label>
          <p className="mt-0.5 text-xs text-blue-800" id="program-announcement-guidance">
            This will be highlighted for every current member of this Program Room.
          </p>
        </div>
        <button
          aria-label="Cancel announcement"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-blue-800 hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          onClick={() => {
            setContent("");
            setExpanded(false);
          }}
          type="button"
        >
          <XMarkIcon aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
      <textarea
        aria-describedby="program-announcement-guidance program-announcement-error program-announcement-count"
        className="mt-3 block min-h-24 max-h-48 w-full resize-y rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
        disabled={disabled || sending}
        id="program-announcement-composer"
        onChange={(event) => setContent(event.target.value)}
        placeholder="Write an announcement for this Program…"
        value={content}
      />
      <div className="mt-1 flex justify-between gap-3 text-xs">
        <span className="text-red-700" id="program-announcement-error" role={error ? "alert" : undefined}>
          {error ?? ""}
        </span>
        <span
          className={
            error ? "shrink-0 text-red-700" : "shrink-0 text-blue-800"
          }
          id="program-announcement-count"
        >
          {contentLength.toLocaleString()} / 4,000
        </span>
      </div>
      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          className="min-h-11 rounded-md px-4 py-2 text-sm font-medium text-blue-800 hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          disabled={sending}
          onClick={() => {
            setContent("");
            setExpanded(false);
          }}
          type="button"
        >
          Cancel
        </button>
        <button
          className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canPublish}
          type="submit"
        >
          Publish announcement
        </button>
      </div>
    </form>
  );
}
