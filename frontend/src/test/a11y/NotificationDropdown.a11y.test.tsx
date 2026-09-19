import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NotificationDropdown from "../../components/common/NotificationDropdown";

const mocks = vi.hoisted(() => ({
  markAllAsRead: vi.fn(),
  markAsRead: vi.fn(),
  markSystemMessageAsRead: vi.fn(),
  removeNotification: vi.fn(),
}));

vi.mock("../../contexts/NotificationContext", () => ({
  useNotifications: () => ({
    allNotifications: [
      {
        createdAt: "2026-09-18T12:00:00.000Z",
        id: "notice-1",
        isRead: false,
        message: "Review the latest ministry update.",
        systemMessage: { type: "announcement" },
        title: "Ministry update",
        type: "system",
      },
    ],
    markAllAsRead: mocks.markAllAsRead,
    markAsRead: mocks.markAsRead,
    markSystemMessageAsRead: mocks.markSystemMessageAsRead,
    removeNotification: mocks.removeNotification,
    totalUnreadCount: 1,
  }),
}));

describe("NotificationDropdown accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes unread and expanded state and returns focus after Escape", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>,
    );
    const bell = screen.getByRole("button", {
      name: "Notifications, 1 unread",
    });
    expect(bell).toHaveAttribute("aria-expanded", "false");

    await user.click(bell);
    expect(bell).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("dialog", { name: "Notifications" }),
    ).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(bell).toHaveFocus());
  });

  it("makes each notification keyboard actionable with an unread name", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>,
    );
    await user.click(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Notifications" }),
      ).toHaveFocus(),
    );
    const notification = screen.getByRole("button", {
      name: /Ministry update.*Unread/i,
    });
    notification.focus();
    await user.keyboard("{Enter}");

    expect(mocks.markSystemMessageAsRead).toHaveBeenCalledWith("notice-1");
  });
});
