import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import EventRoleSignup from "../../components/events/EventRoleSignup";

const { listOptionsMock } = vi.hoisted(() => ({
  listOptionsMock: vi.fn(async () => ({
    options: [],
    pagination: {
      currentPage: 1,
      totalPages: 0,
      totalOptions: 0,
      hasNext: false,
      hasPrev: false,
    },
  })),
}));

vi.mock("../../services/api", async () => {
  const actual = await vi.importActual<typeof import("../../services/api")>(
    "../../services/api",
  );
  return {
    ...actual,
    userOptionsService: { list: listOptionsMock },
  };
});

vi.mock("../../components/common/NameCardActionModal", () => ({
  default: () => null,
}));

describe("EventRoleSignup assignee options", () => {
  it("loads assignees through the concrete event authorization scope", async () => {
    render(
      <MemoryRouter>
        <EventRoleSignup
          role={{
            id: "role-1",
            name: "Host",
            description: "",
            maxParticipants: 5,
            currentSignups: [],
          }}
          onSignup={vi.fn()}
          onCancel={vi.fn()}
          currentUserId="organizer-1"
          currentUserRole="Leader"
          isUserSignedUpForThisRole={false}
          hasReachedMaxRoles={false}
          maxRolesForUser={1}
          isRoleAllowedForUser={true}
          eventId="event-123"
          isOrganizer
          onAssignUser={vi.fn()}
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: /^sign up$/i }));
    await userEvent.click(screen.getByRole("button", { name: /assign user/i }));

    await waitFor(() => {
      expect(listOptionsMock).toHaveBeenCalledWith({
        context: "event-role-assignee",
        resourceId: "event-123",
        q: undefined,
        page: 1,
        limit: 20,
      });
    });
  });
});
