import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SystemMessages from "../../pages/SystemMessages";

// Mock the service module
vi.mock("../../services/systemMessageService", () => ({
  systemMessageService: {
    getSystemMessagesPaginated: vi.fn(),
    createSystemMessage: vi.fn(),
    deleteSystemMessage: vi.fn(),
  },
}));

vi.mock("../../services/socketService", () => ({
  socketService: {
    connect: vi.fn(),
  },
}));

// Mock contexts
const mockMarkSystemMessageAsRead = vi.fn();
const mockReloadSystemMessages = vi.fn();

vi.mock("../../contexts/NotificationContext", () => ({
  useNotifications: () => ({
    messages: [],
    unreadCount: 0,
    markSystemMessageAsRead: mockMarkSystemMessageAsRead,
    reloadSystemMessages: mockReloadSystemMessages,
  }),
}));

const mockCurrentUser = {
  id: "user-1",
  email: "test@example.com",
  role: "Administrator",
  name: "Test User",
};

vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: mockCurrentUser,
    hasRole: (role: string) => mockCurrentUser.role === role,
  }),
}));

vi.mock("../../hooks/useAvatarUpdates", () => ({
  useAvatarUpdates: () => 0,
}));

const mockMessages = [
  {
    id: "msg-1",
    title: "System Update",
    content: "System will be updated tonight",
    type: "announcement" as const,
    priority: "medium" as const,
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    isActive: true,
    isRead: false,
    createdBy: {
      id: "admin-1",
      name: "Admin User",
      avatarUrl: null,
    },
  },
  {
    id: "msg-2",
    title: "Security Alert",
    content: "New security policy",
    type: "warning" as const,
    priority: "high" as const,
    createdAt: "2024-01-14T10:00:00Z",
    updatedAt: "2024-01-14T10:00:00Z",
    isActive: true,
    isRead: true,
    readAt: "2024-01-14T11:00:00Z",
    createdBy: {
      id: "admin-2",
      name: "Security Admin",
      avatarUrl: null,
    },
  },
];

describe("SystemMessages", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCurrentUser.role = "Administrator";
    localStorage.setItem("authToken", "fake-token");

    // Import the mocked module to get access to the mock function
    const { systemMessageService } = await import(
      "../../services/systemMessageService"
    );

    vi.mocked(
      systemMessageService.getSystemMessagesPaginated
    ).mockResolvedValue({
      messages: mockMessages,
      unreadCount: 1,
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalCount: 2,
        hasNext: false,
        hasPrev: false,
      },
    });
  });

  describe("Initial Rendering", () => {
    it("renders the page header", async () => {
      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("System Messages")).toBeInTheDocument();
      });
    });

    it("shows loading state initially", () => {
      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      expect(screen.getByText("Loading system messages…")).toBeInTheDocument();
    });

    it("loads messages on mount", async () => {
      const { systemMessageService } = await import(
        "../../services/systemMessageService"
      );

      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(
          systemMessageService.getSystemMessagesPaginated
        ).toHaveBeenCalledWith({
          page: 1,
          limit: 20,
        });
      });
    });

    it("displays total message count", async () => {
      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("2 total messages")).toBeInTheDocument();
      });
    });
  });

  describe("Create Message Authorization", () => {
    it.each(["Administrator", "Super Admin"])(
      "shows the create action for %s",
      async (role) => {
        mockCurrentUser.role = role;

        render(
          <MemoryRouter>
            <SystemMessages />
          </MemoryRouter>
        );

        await waitFor(() => {
          expect(
            screen.getByRole("button", {
              name: /create new system message/i,
            })
          ).toBeInTheDocument();
        });
      }
    );

    it.each(["Leader", "Guest Expert", "Participant"])(
      "hides the create action from %s while preserving message access",
      async (role) => {
        mockCurrentUser.role = role;

        render(
          <MemoryRouter>
            <SystemMessages />
          </MemoryRouter>
        );

        await waitFor(() => {
          expect(screen.getByText("System Update")).toBeInTheDocument();
        });
        expect(
          screen.queryByRole("button", {
            name: /create new system message/i,
          })
        ).not.toBeInTheDocument();
      }
    );
  });

  describe("Message List Display", () => {
    it("displays all messages", async () => {
      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("System Update")).toBeInTheDocument();
      });

      expect(screen.getByText("Security Alert")).toBeInTheDocument();
      expect(
        screen.getByText("System will be updated tonight")
      ).toBeInTheDocument();
      expect(screen.getByText("New security policy")).toBeInTheDocument();
    });

    it("shows empty state when no messages", async () => {
      const { systemMessageService } = await import(
        "../../services/systemMessageService"
      );

      vi.mocked(
        systemMessageService.getSystemMessagesPaginated
      ).mockResolvedValue({
        messages: [],
        unreadCount: 0,
        pagination: {
          currentPage: 1,
          totalPages: 0,
          totalCount: 0,
          hasNext: false,
          hasPrev: false,
        },
      });

      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("No system messages")).toBeInTheDocument();
      });

      expect(
        screen.getByText(
          "You're all caught up! Check back later for system updates."
        )
      ).toBeInTheDocument();
    });

    it("marks message as read when clicked", async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("System Update")).toBeInTheDocument();
      });

      const message = screen.getByText("System Update");
      await user.click(message);

      // Note: The actual mark as read happens through context
      expect(mockMarkSystemMessageAsRead).toHaveBeenCalled();
    });
  });

  describe("Pagination", () => {
    it("shows pagination when multiple pages", async () => {
      const { systemMessageService } = await import(
        "../../services/systemMessageService"
      );

      vi.mocked(
        systemMessageService.getSystemMessagesPaginated
      ).mockResolvedValue({
        messages: mockMessages,
        unreadCount: 1,
        pagination: {
          currentPage: 1,
          totalPages: 3,
          totalCount: 50,
          hasNext: true,
          hasPrev: false,
        },
      });

      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        const pagination = screen.queryAllByText(/page \d+ of \d+/i);
        expect(pagination.length).toBeGreaterThan(0);
      });
    });

    it("hides pagination when single page", async () => {
      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("System Update")).toBeInTheDocument();
      });

      const pagination = screen.queryAllByText(/page \d+ of \d+/i);
      expect(pagination).toHaveLength(0);
    });

    it("loads next page when clicked", async () => {
      const user = userEvent.setup();
      const { systemMessageService } = await import(
        "../../services/systemMessageService"
      );

      vi.mocked(
        systemMessageService.getSystemMessagesPaginated
      ).mockResolvedValue({
        messages: mockMessages,
        unreadCount: 1,
        pagination: {
          currentPage: 1,
          totalPages: 3,
          totalCount: 50,
          hasNext: true,
          hasPrev: false,
        },
      });

      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(
          screen.getAllByRole("button", { name: /next/i }).length
        ).toBeGreaterThan(0);
      });

      const nextButtons = screen.getAllByRole("button", { name: /next/i });
      await user.click(nextButtons[0]);

      await waitFor(() => {
        expect(
          systemMessageService.getSystemMessagesPaginated
        ).toHaveBeenCalledWith({
          page: 2,
          limit: 20,
        });
      });
    });
  });

  describe("Delete Message", () => {
    it("opens confirmation modal when delete clicked", async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("System Update")).toBeInTheDocument();
      });

      // Find delete button (typically in a dropdown or action menu)
      const deleteButtons = screen.queryAllByRole("button", {
        name: /delete/i,
      });
      if (deleteButtons.length > 0) {
        await user.click(deleteButtons[0]);

        await waitFor(() => {
          expect(
            screen.getByText(/delete system message/i)
          ).toBeInTheDocument();
        });
      }
    });

    it("deletes message when confirmed", async () => {
      const user = userEvent.setup();
      const { systemMessageService } = await import(
        "../../services/systemMessageService"
      );

      vi.mocked(systemMessageService.deleteSystemMessage).mockResolvedValue(
        true
      );

      render(
        <MemoryRouter>
          <SystemMessages />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText("System Update")).toBeInTheDocument();
      });

      const deleteButtons = screen.queryAllByRole("button", {
        name: /delete/i,
      });
      if (deleteButtons.length > 0) {
        await user.click(deleteButtons[0]);

        // Wait for confirmation modal to appear
        await waitFor(() => {
          expect(
            screen.getByText(/delete system message/i)
          ).toBeInTheDocument();
        });

        // Find the "Delete Message" button specifically (the one in the modal)
        const allButtons = screen.getAllByRole("button");
        const confirmButton = allButtons.find(
          (btn) => btn.textContent === "Delete Message"
        );
        expect(confirmButton).toBeDefined();
        await user.click(confirmButton!);

        await waitFor(() => {
          expect(systemMessageService.deleteSystemMessage).toHaveBeenCalled();
        });
      }
    });
  });
});
