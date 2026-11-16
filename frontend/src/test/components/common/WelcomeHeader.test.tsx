import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WelcomeHeader from "../../../components/common/WelcomeHeader";

// Mock the useCurrentTime hook
vi.mock("../../../hooks/useCurrentTime", () => ({
  useCurrentTime: () => ({
    greeting: "Good Morning",
    formattedDate: "Monday, January 15, 2025",
  }),
}));

describe("WelcomeHeader", () => {
  it("renders greeting from useCurrentTime hook", () => {
    render(<WelcomeHeader />);
    expect(
      screen.getByText(/Good Morning, Welcome to @Cloud Events!/)
    ).toBeDefined();
  });

  it("renders formatted date from useCurrentTime hook", () => {
    render(<WelcomeHeader />);
    expect(screen.getByText("Monday, January 15, 2025")).toBeDefined();
  });

  it("renders welcome message", () => {
    render(<WelcomeHeader />);
    expect(
      screen.getByText(
        /Welcome to @Cloud Marketplace Ministry Events Management System/
      )
    ).toBeDefined();
  });

  it("renders ministry description", () => {
    render(<WelcomeHeader />);
    expect(
      screen.getByText(
        /you can create or join events, connect with the community/
      )
    ).toBeDefined();
  });

  it("renders the greeting as the page heading", () => {
    render(<WelcomeHeader />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Good Morning, Welcome to @Cloud Events!",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the decorative clouds out of the accessibility tree", () => {
    const { container } = render(<WelcomeHeader />);
    const decorations = container.querySelectorAll("section > [aria-hidden='true']");
    expect(decorations.length).toBeGreaterThan(0);
    decorations.forEach((node) => expect(node.textContent).not.toMatch(/Welcome/));
  });
});
