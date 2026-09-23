import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import MobileBottomNavigation from "../../../layouts/dashboard/MobileBottomNavigation";

interface RenderNavigationOptions {
  chatUnreadTotal?: number;
  initialEntry?: string;
  initiallyOpen?: boolean;
}

function NavigationHarness({
  chatUnreadTotal = 0,
  initiallyOpen = false,
}: Omit<RenderNavigationOptions, "initialEntry">) {
  const [menuOpen, setMenuOpen] = useState(initiallyOpen);

  return (
    <MobileBottomNavigation
      chatUnreadTotal={chatUnreadTotal}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
    />
  );
}

function renderNavigation({
  chatUnreadTotal = 0,
  initialEntry = "/dashboard",
  initiallyOpen = false,
}: RenderNavigationOptions = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <NavigationHarness
        chatUnreadTotal={chatUnreadTotal}
        initiallyOpen={initiallyOpen}
      />
    </MemoryRouter>,
  );
}

describe("MobileBottomNavigation", () => {
  it("renders the five destinations in the required order with the correct hrefs", () => {
    renderNavigation();

    const navigation = screen.getByRole("navigation", {
      name: "Mobile primary navigation",
    });
    const interactiveItems = Array.from(
      navigation.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>(
        "button, a",
      ),
    );

    expect(interactiveItems).toHaveLength(5);
    expect(interactiveItems.map((item) => item.textContent?.trim())).toEqual([
      "Menu",
      "Event Calendar",
      "Chat Rooms",
      "Donate",
      "Feedback",
    ]);

    const links = within(navigation).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard/upcoming",
      "/dashboard/chat-rooms",
      "/dashboard/donate",
      "/dashboard/feedback",
    ]);
  });

  it("toggles the controlled menu and exposes its expanded state", async () => {
    const user = userEvent.setup();
    renderNavigation();

    const openButton = screen.getByRole("button", {
      name: "Open navigation menu",
    });
    expect(openButton).toHaveAttribute(
      "aria-controls",
      "dashboard-primary-navigation",
    );
    expect(openButton).toHaveAttribute("aria-expanded", "false");
    expect(openButton).toHaveAttribute("aria-pressed", "false");

    await user.click(openButton);

    const closeButton = screen.getByRole("button", {
      name: "Close navigation menu",
    });
    expect(closeButton).toHaveAttribute("aria-expanded", "true");
    expect(closeButton).toHaveAttribute("aria-pressed", "true");

    await user.click(closeButton);

    expect(
      screen.getByRole("button", { name: "Open navigation menu" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("marks nested Chat Rooms routes as the active destination", () => {
    renderNavigation({
      initialEntry: "/dashboard/chat-rooms/conversation-123",
    });

    const chatRoomsLink = screen.getByRole("link", { name: "Chat Rooms" });
    expect(chatRoomsLink).toHaveAttribute("aria-current", "page");
    expect(chatRoomsLink).toHaveClass("bg-blue-50", "text-blue-700");
    expect(
      screen.getByRole("link", { name: "Event Calendar" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("button", { name: "Open navigation menu" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("announces the full unread count while visually capping the badge at 99+", () => {
    renderNavigation({ chatUnreadTotal: 128 });

    const chatRoomsLink = screen.getByRole("link", {
      name: "Chat Rooms, 128 unread messages",
    });
    const badge = within(chatRoomsLink).getByText("99+");

    expect(badge).toHaveAttribute("aria-hidden", "true");
    expect(badge).toHaveClass("min-h-[1.125rem]", "min-w-[1.125rem]");
  });

  it("gives every bottom action an equal-column, 64px minimum hit area", () => {
    renderNavigation();

    const navigation = screen.getByRole("navigation", {
      name: "Mobile primary navigation",
    });
    const grid = navigation.firstElementChild;
    const interactiveItems = navigation.querySelectorAll("button, a");

    expect(grid).toHaveClass("grid", "grid-cols-5");
    expect(interactiveItems).toHaveLength(5);
    interactiveItems.forEach((item) => {
      expect(item).toHaveClass("min-h-16", "items-center", "justify-center");
    });
  });
});
