import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatRoomProfileLinks from "../../components/chat/ChatRoomProfileLinks";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  alumniHelpService: { get: mocks.get },
}));

const viewer = {
  role: "requester" as const,
  status: "active" as const,
  lastReadSequence: 0,
  unreadCount: 0,
  muted: false,
  canSend: true,
  canAnnounce: false,
  accessMode: "read_write" as const,
};

describe("ChatRoomProfileLinks", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({
      request: { alumniProfileId: "64b000000000000000000009" },
    });
  });

  it("links a requester to the alumni profile and the help request", async () => {
    render(
      <MemoryRouter>
        <ChatRoomProfileLinks
          conversation={{
            kind: "alumni_help",
            helpRequestId: "64b000000000000000000002",
            viewer,
          }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "View profile" }),
    ).toHaveAttribute("href", "/dashboard/community/alumni/64b000000000000000000009");
    expect(
      screen.getByRole("link", { name: "View help request" }),
    ).toHaveAttribute(
      "href",
      "/dashboard/community/help-requests/64b000000000000000000002",
    );
  });

  it("does not look up a profile for the provider", () => {
    render(
      <MemoryRouter>
        <ChatRoomProfileLinks
          conversation={{
            kind: "alumni_help",
            helpRequestId: "64b000000000000000000002",
            viewer: { ...viewer, role: "provider" },
          }}
        />
      </MemoryRouter>,
    );

    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "View profile" })).toBeNull();
    expect(screen.getByRole("link", { name: "View help request" })).toBeInTheDocument();
  });

  it("renders nothing for Program Rooms", () => {
    const { container } = render(
      <MemoryRouter>
        <ChatRoomProfileLinks
          conversation={{ kind: "program", helpRequestId: null, viewer }}
        />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
