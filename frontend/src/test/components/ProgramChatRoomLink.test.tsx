import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramChatRoomLink from "../../components/ProgramDetail/ProgramChatRoomLink";

const mocks = vi.hoisted(() => ({
  getProgramRoom: vi.fn(),
  userId: "64b000000000000000000003" as string | null,
  readable: true,
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  conversationsService: { getProgramRoom: mocks.getProgramRoom },
}));
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: mocks.userId ? { id: mocks.userId } : null,
  }),
}));
vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: {
        mode: mocks.readable ? "on" : "off",
        readable: mocks.readable,
        writable: mocks.readable,
      },
    },
  }),
}));

const PROGRAM_ID = "64b000000000000000000005";
const ROOM_ID = "64b000000000000000000001";

function renderLink(refreshKey = 0) {
  return render(
    <MemoryRouter>
      <ProgramChatRoomLink programId={PROGRAM_ID} refreshKey={refreshKey} />
    </MemoryRouter>,
  );
}

describe("ProgramChatRoomLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = "64b000000000000000000003";
    mocks.readable = true;
    mocks.getProgramRoom.mockResolvedValue({
      room: {
        id: ROOM_ID,
        programId: PROGRAM_ID,
        status: "current",
        section: "current",
        viewer: { status: "active", accessMode: "read_write" },
      },
    });
  });

  it("shows a responsive deep link only after current membership is confirmed", async () => {
    renderLink();
    expect(screen.queryByRole("link", { name: "Open Chat Room" })).toBeNull();
    const link = await screen.findByRole("link", { name: "Open Chat Room" });
    expect(link).toHaveAttribute("href", `/dashboard/chat-rooms/${ROOM_ID}`);
    expect(screen.getByText("Current · Read/write")).toBeInTheDocument();
    expect(mocks.getProgramRoom).toHaveBeenCalledWith(
      PROGRAM_ID,
      expect.any(AbortSignal),
    );
  });

  it("labels retained history access as a Past read-only Room", async () => {
    mocks.getProgramRoom.mockResolvedValueOnce({
      room: {
        id: ROOM_ID,
        programId: PROGRAM_ID,
        status: "current",
        section: "past",
        viewer: { status: "history_only", accessMode: "read_only" },
      },
    });
    renderLink();
    expect(
      await screen.findByRole("link", { name: "View Past Chat Room" }),
    ).toHaveAttribute("href", `/dashboard/chat-rooms/${ROOM_ID}`);
    expect(screen.getByText("Past · Read-only")).toBeInTheDocument();
  });

  it("conceals the entry when lookup says the viewer has no membership", async () => {
    mocks.getProgramRoom.mockRejectedValueOnce(
      Object.assign(new Error("The chat room was not found."), { status: 404 }),
    );
    renderLink();
    await waitFor(() => expect(mocks.getProgramRoom).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Program Chat Room")).toBeNull();
  });

  it("retries a short-lived projection gap and displays the Room once ready", async () => {
    vi.useFakeTimers();
    try {
      mocks.getProgramRoom
        .mockRejectedValueOnce(
          Object.assign(new Error("The chat room was not found."), {
            status: 404,
          }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("Program Room projection is changing."), {
            status: 409,
          }),
        )
        .mockResolvedValueOnce({
          room: {
            id: ROOM_ID,
            programId: PROGRAM_ID,
            status: "current",
            section: "current",
            viewer: { status: "active", accessMode: "read_write" },
          },
        });

      renderLink();
      await act(async () => Promise.resolve());
      expect(mocks.getProgramRoom).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(mocks.getProgramRoom).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("link", { name: "Open Chat Room" })).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });
      expect(mocks.getProgramRoom).toHaveBeenCalledTimes(3);
      expect(
        screen.getByRole("link", { name: "Open Chat Room" }),
      ).toHaveAttribute("href", `/dashboard/chat-rooms/${ROOM_ID}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks up the Room again when Program enrollment state is refreshed", async () => {
    mocks.getProgramRoom
      .mockRejectedValueOnce(
        Object.assign(new Error("The chat room was not found."), { status: 403 }),
      )
      .mockResolvedValueOnce({
        room: {
          id: ROOM_ID,
          programId: PROGRAM_ID,
          status: "current",
          section: "current",
          viewer: { status: "active", accessMode: "read_write" },
        },
      });
    const view = renderLink();
    await waitFor(() => expect(mocks.getProgramRoom).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link", { name: "Open Chat Room" })).toBeNull();

    view.rerender(
      <MemoryRouter>
        <ProgramChatRoomLink programId={PROGRAM_ID} refreshKey={1} />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "Open Chat Room" }),
    ).toHaveAttribute("href", `/dashboard/chat-rooms/${ROOM_ID}`);
    expect(mocks.getProgramRoom).toHaveBeenCalledTimes(2);
  });

  it("cancels a scheduled retry when the component unmounts", async () => {
    vi.useFakeTimers();
    try {
      mocks.getProgramRoom.mockRejectedValue(
        Object.assign(new Error("The chat room was not found."), {
          status: 404,
        }),
      );
      const view = renderLink();
      await act(async () => Promise.resolve());
      expect(mocks.getProgramRoom).toHaveBeenCalledTimes(1);

      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(mocks.getProgramRoom).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not probe for a Room for guests or while the feature is unavailable", () => {
    mocks.userId = null;
    const first = renderLink();
    expect(mocks.getProgramRoom).not.toHaveBeenCalled();
    first.unmount();

    mocks.userId = "64b000000000000000000003";
    mocks.readable = false;
    renderLink();
    expect(mocks.getProgramRoom).not.toHaveBeenCalled();
  });
});
