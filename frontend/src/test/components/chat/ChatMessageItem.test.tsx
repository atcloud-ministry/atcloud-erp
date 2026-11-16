import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatMessageItem, {
  type ChatDisplayMessage,
} from "../../../components/chat/ChatMessageItem";

const ME = "64b000000000000000000001";
const PEER = "64b000000000000000000002";

function message(overrides: Partial<ChatDisplayMessage> = {}): ChatDisplayMessage {
  return {
    id: "64b0000000000000000000a1",
    conversationId: "64b0000000000000000000c1",
    sequence: 1,
    kind: "text",
    sender: { id: PEER, displayName: "Grace Hopper", avatar: null },
    content: "Hello there",
    safeLink: null,
    clientMessageId: "client-1",
    createdAt: "2026-10-18T22:00:00.000Z",
    ...overrides,
  };
}

function renderItem(
  value: ChatDisplayMessage,
  onRetry?: (message: ChatDisplayMessage) => void,
) {
  return render(
    <ul>
      <ChatMessageItem currentUserId={ME} message={value} onRetry={onRetry} />
    </ul>,
  );
}

describe("ChatMessageItem", () => {
  it("shows the sender's name and avatar on someone else's message", () => {
    renderItem(message());

    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Grace Hopper avatar" }),
    ).toBeInTheDocument();
  });

  it("hides the sender's name and avatar on the viewer's own message", () => {
    renderItem(message({ sender: { id: ME, displayName: "Me", avatar: null } }));

    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.queryByText("Me")).toBeNull();
    expect(screen.queryByRole("img", { name: "Me avatar" })).toBeNull();
  });

  it("turns web addresses in the text into links that open in a new tab", () => {
    renderItem(message({ content: "See https://example.org/page." }));

    const link = screen.getByRole("link", { name: "https://example.org/page" });
    expect(link).toHaveAttribute("href", "https://example.org/page");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows where a labeled safe link really goes", () => {
    renderItem(
      message({
        content: null,
        safeLink: { url: "https://www.example.org/form", label: "Sign-up form" },
      }),
    );

    const link = screen.getByRole("link", { name: /Sign-up form/ });
    expect(link).toHaveAttribute("href", "https://www.example.org/form");
    expect(screen.getByText("Goes to example.org")).toBeInTheDocument();
  });

  it("does not repeat the destination when the label is the address", () => {
    const url = "https://example.org/form";
    renderItem(message({ content: null, safeLink: { url, label: url } }));

    expect(screen.queryByText(/Goes to/)).toBeNull();
  });

  it("offers Retry only on the viewer's own failed message", () => {
    const onRetry = vi.fn();
    const failed = message({
      sender: { id: ME, displayName: "Me", avatar: null },
      deliveryState: "failed",
    });
    renderItem(failed, onRetry);

    expect(screen.getByText(/failed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it("never shows delivery state or Retry on someone else's message", () => {
    renderItem(message({ deliveryState: "failed" }), vi.fn());

    expect(screen.queryByText(/failed/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders announcements as a labeled card with the sender", () => {
    renderItem(message({ kind: "announcement", content: "Meeting moved" }));

    expect(screen.getByText("Announcement")).toBeInTheDocument();
    expect(screen.getByText("Meeting moved")).toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper ·/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Grace Hopper avatar" })).toBeNull();
  });
});
