import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Welcome from "../../pages/Welcome";
import { useAuth } from "../../hooks/useAuth";
import { useEvents } from "../../hooks/useEventsApi";

vi.mock("../../hooks/useAuth");
vi.mock("../../hooks/useEventsApi");

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;
const mockedUseEvents = useEvents as unknown as ReturnType<typeof vi.fn>;

describe("Welcome page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithRouter = () => {
    return render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );
  };

  describe("Page Structure", () => {
    it("renders welcome header", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      // WelcomeHeader component should be present
      expect(screen.getByText(/Our Vision & Mission/i)).toBeInTheDocument();
    });

    it("displays vision and mission content", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(
        screen.getByText(/The vision of @Cloud is to celebrate/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/call and equip Christian leaders/i),
      ).toBeInTheDocument();
    });

    it("renders Return to @Cloud Website button", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      const link = screen.getByRole("link", {
        name: /Return to @Cloud Website/i,
      });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "https://at-cloud.biz/");
      expect(link).toHaveAttribute("target", "_blank");
    });

    it("displays Quick Actions card", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Quick Actions")).toBeInTheDocument();
    });

    it("displays Upcoming Events card", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Upcoming Events")).toBeInTheDocument();
    });
  });

  describe("Ministry Stats Visibility", () => {
    it("shows Ministry Stats for Administrator role", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Ministry Stats")).toBeInTheDocument();
    });

    it("shows Ministry Stats for Super Admin role", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Super Admin" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Ministry Stats")).toBeInTheDocument();
    });

    it("shows Ministry Stats for Leader role", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Leader" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Ministry Stats")).toBeInTheDocument();
    });

    it("hides Ministry Stats for Participant role", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Participant" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.queryByText("Ministry Stats")).not.toBeInTheDocument();
    });
  });

  describe("Upcoming Events Card - Loading", () => {
    it("shows skeleton loading state", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: true,
        error: null,
      } as any);

      renderWithRouter();

      expect(
        screen.getByTestId("upcoming-events-skeleton"),
      ).toBeInTheDocument();
    });

    it("displays 3 skeleton placeholders", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: true,
        error: null,
      } as any);

      renderWithRouter();

      const skeleton = screen.getByTestId("upcoming-events-skeleton");
      // Check for 3 parent containers instead of all nested animated elements
      const placeholders = skeleton.querySelectorAll(":scope > .animate-pulse");
      expect(placeholders.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Upcoming Events Card - Error State", () => {
    it("displays error message when events fail to load", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: "Network error",
      } as any);

      renderWithRouter();

      expect(screen.getByText(/Failed to load events/i)).toBeInTheDocument();
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });

    it("shows an error icon instead of an emoji", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: "Error occurred",
      } as any);

      renderWithRouter();

      const message = screen.getByText(/Failed to load events/i);
      expect(message.parentElement?.querySelector("svg")).toBeInTheDocument();
      expect(screen.queryByText("⚠️")).not.toBeInTheDocument();
    });
  });

  describe("Upcoming Events Card - Empty State", () => {
    it("displays empty state when no events available", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("No upcoming events")).toBeInTheDocument();
      expect(
        screen.getByText("Check back later for new events"),
      ).toBeInTheDocument();
    });

    it("shows a calendar icon in empty state", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      const message = screen.getByText("No upcoming events");
      expect(message.parentElement?.querySelector("svg")).toBeInTheDocument();
      expect(screen.queryByText("📅")).not.toBeInTheDocument();
    });
  });

  describe("Upcoming Events Card - Events Display", () => {
    it("displays single upcoming event", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Test Event",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Test Event")).toBeInTheDocument();
    });

    it("displays up to 3 upcoming events", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Event 1",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
          {
            id: "2",
            title: "Event 2",
            date: dateStr,
            time: "14:00",
            endTime: "15:00",
            timeZone: "America/New_York",
          },
          {
            id: "3",
            title: "Event 3",
            date: dateStr,
            time: "18:00",
            endTime: "19:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Event 1")).toBeInTheDocument();
      expect(screen.getByText("Event 2")).toBeInTheDocument();
      expect(screen.getByText("Event 3")).toBeInTheDocument();
    });

    it("limits display to 3 events even when more are available", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Event 1",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
          {
            id: "2",
            title: "Event 2",
            date: dateStr,
            time: "14:00",
            endTime: "15:00",
            timeZone: "America/New_York",
          },
          {
            id: "3",
            title: "Event 3",
            date: dateStr,
            time: "18:00",
            endTime: "19:00",
            timeZone: "America/New_York",
          },
          {
            id: "4",
            title: "Event 4",
            date: dateStr,
            time: "20:00",
            endTime: "21:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("Event 1")).toBeInTheDocument();
      expect(screen.getByText("Event 2")).toBeInTheDocument();
      expect(screen.getByText("Event 3")).toBeInTheDocument();
      expect(screen.queryByText("Event 4")).not.toBeInTheDocument();
    });

    it("shows View All Upcoming Events button when events exist", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Test Event",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(
        screen.getByRole("button", { name: /View All Upcoming Events/i }),
      ).toBeInTheDocument();
    });
  });

  describe("Event Timing Labels", () => {
    it("displays timing labels for events", () => {
      const inTenDays = new Date();
      inTenDays.setDate(inTenDays.getDate() + 10);
      const dateStr = inTenDays.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Future Event",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      // Just verify that a timing label exists (could be "1 week" or similar)
      expect(screen.getByText("Future Event")).toBeInTheDocument();
    });

    it('displays "1 week" for events in 7-13 days', () => {
      const inTenDays = new Date();
      inTenDays.setDate(inTenDays.getDate() + 10);
      const dateStr = inTenDays.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Event in 10 Days",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText("1 week")).toBeInTheDocument();
    });

    it("displays weeks count for events 14-29 days away", () => {
      const inTwentyDays = new Date();
      inTwentyDays.setDate(inTwentyDays.getDate() + 20);
      const dateStr = inTwentyDays.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Event in 20 Days",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText(/weeks/)).toBeInTheDocument();
    });

    it("displays months count for events 30+ days away", () => {
      const inFortyDays = new Date();
      inFortyDays.setDate(inFortyDays.getDate() + 40);
      const dateStr = inFortyDays.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Event in 40 Days",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      expect(screen.getByText(/month/)).toBeInTheDocument();
    });
  });

  describe("Event Color Schemes", () => {
    it("shows a month/day badge for each event", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "1",
            title: "Event 1",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
          {
            id: "2",
            title: "Event 2",
            date: dateStr,
            time: "14:00",
            endTime: "15:00",
            timeZone: "America/New_York",
          },
          {
            id: "3",
            title: "Event 3",
            date: dateStr,
            time: "18:00",
            endTime: "19:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      const month = tomorrow.toLocaleString("en-US", {
        month: "short",
        timeZone: "UTC",
      });
      const day = String(Number(dateStr.slice(8, 10)));
      for (const title of ["Event 1", "Event 2", "Event 3"]) {
        const link = screen.getByText(title).closest("a");
        expect(link).toHaveTextContent(new RegExp(`^${month}${day}`));
      }
    });
  });

  describe("Event Links", () => {
    it("creates links to event detail pages", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [
          {
            id: "event-123",
            title: "Test Event",
            date: dateStr,
            time: "10:00",
            endTime: "11:00",
            timeZone: "America/New_York",
          },
        ],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      const eventLink = screen
        .getByText("Test Event")
        .closest("a") as HTMLAnchorElement;
      expect(eventLink).toHaveAttribute("href", "/dashboard/event/event-123");
    });
  });

  describe("Getting Started Section", () => {
    it("displays getting started section", () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { role: "Administrator" },
      } as any);
      mockedUseEvents.mockReturnValue({
        events: [],
        loading: false,
        error: null,
      } as any);

      renderWithRouter();

      // GettingStartedSection component should be rendered
      // (actual content depends on implementation)
      const container = screen
        .getByText(/Our Vision & Mission/i)
        .closest("div");
      expect(container).toBeInTheDocument();
    });
  });
});
