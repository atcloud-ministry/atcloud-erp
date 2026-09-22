import { ChatBubbleOvalLeftEllipsisIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useRuntimeConfig } from "../../contexts/RuntimeConfigContext";
import { useAuth } from "../../hooks/useAuth";
import {
  conversationsService,
  type ProgramChatRoomLinkDTO,
} from "../../services/api";

interface LoadedProgramRoom {
  readonly requestKey: string;
  readonly room: ProgramChatRoomLinkDTO;
}

const PROGRAM_ROOM_LOOKUP_RETRY_DELAYS_MS = Object.freeze([250, 750, 1_500]);

function retryableProjectionStatus(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return false;
  }
  const status = Number((error as { readonly status?: unknown }).status);
  return status === 404 || status === 409;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default function ProgramChatRoomLink({
  programId,
  refreshKey = 0,
}: {
  readonly programId: string;
  readonly refreshKey?: number;
}) {
  const { currentUser } = useAuth();
  const { config, status } = useRuntimeConfig();
  const [loaded, setLoaded] = useState<LoadedProgramRoom | null>(null);
  const userId = currentUser?.id;
  const readable = status === "ready" && config.alumniNetwork.readable;
  const requestKey = `${userId ?? "anonymous"}:${programId}:${config.revision}:${refreshKey}`;

  useEffect(() => {
    if (!userId || !readable) {
      setLoaded(null);
      return;
    }
    const controller = new AbortController();
    setLoaded((current) =>
      current?.requestKey === requestKey ? current : null,
    );
    void (async () => {
      for (
        let attempt = 0;
        attempt <= PROGRAM_ROOM_LOOKUP_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        try {
          const { room } = await conversationsService.getProgramRoom(
            programId,
            controller.signal,
          );
          if (!controller.signal.aborted) setLoaded({ requestKey, room });
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          const delayMs = PROGRAM_ROOM_LOOKUP_RETRY_DELAYS_MS[attempt];
          if (delayMs === undefined || !retryableProjectionStatus(error)) {
            setLoaded(null);
            return;
          }
          if (!(await waitForRetry(delayMs, controller.signal))) return;
        }
      }
    })();
    return () => controller.abort();
  }, [programId, readable, requestKey, userId]);

  const room = loaded?.requestKey === requestKey ? loaded.room : null;
  if (!userId || !readable || !room) return null;

  const current = room.section === "current";
  const accessLabel =
    room.viewer.accessMode === "read_write" ? "Read/write" : "Read-only";
  return (
    <section
      aria-label="Program Chat Room"
      className="flex flex-col gap-4 rounded-lg border border-blue-100 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
          <ChatBubbleOvalLeftEllipsisIcon
            aria-hidden="true"
            className="h-6 w-6"
          />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-gray-900">Program Chat Room</h2>
          <p className="text-sm text-gray-600">
            {current ? "Current" : "Past"} · {accessLabel}
          </p>
        </div>
      </div>
      <Link
        className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:w-auto"
        to={`/dashboard/chat-rooms/${encodeURIComponent(room.id)}`}
      >
        {current ? "Open Chat Room" : "View Past Chat Room"}
      </Link>
    </section>
  );
}
