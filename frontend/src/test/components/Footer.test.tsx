import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Footer from "../../components/common/Footer";

const originalAppVersion = Object.getOwnPropertyDescriptor(
  globalThis,
  "__APP_VERSION__",
);

beforeAll(() => {
  Object.defineProperty(globalThis, "__APP_VERSION__", {
    configurable: true,
    value: "1.0.0",
  });
});

afterAll(() => {
  if (originalAppVersion) {
    Object.defineProperty(globalThis, "__APP_VERSION__", originalAppVersion);
  } else {
    Reflect.deleteProperty(globalThis, "__APP_VERSION__");
  }
});

describe("Footer component", () => {
  it("renders @Cloud branding and logo", () => {
    render(<Footer />);

    expect(screen.getByAltText("@Cloud")).toBeInTheDocument();
    expect(screen.getByText("@Cloud")).toBeInTheDocument();
    expect(
      screen.getByText("Events Resource Planning System")
    ).toBeInTheDocument();
  });

  it("displays current year in copyright", () => {
    render(<Footer />);

    const currentYear = new Date().getFullYear();
    expect(screen.getByText(`© ${currentYear}`)).toBeInTheDocument();
  });

  it("shows author and team information", () => {
    render(<Footer />);

    expect(screen.getByText("Travis Fan @Cloud IT Team")).toBeInTheDocument();
    expect(
      screen.getByText("Built with God's help for managing events")
    ).toBeInTheDocument();
  });

  it("displays version information", () => {
    render(<Footer />);

    expect(screen.getByText(/version/i)).toBeInTheDocument();
    expect(screen.getByText("Dashboard v2025")).toBeInTheDocument();
  });

  it("shows rights and access information", () => {
    render(<Footer />);

    expect(screen.getByText(/all rights reserved/i)).toBeInTheDocument();
    expect(
      screen.getByText(/unauthorized access is prohibited/i)
    ).toBeInTheDocument();
  });

  it("renders with proper structure and separators", () => {
    const { container } = render(<Footer />);

    // Check footer tag exists
    const footer = container.querySelector("footer");
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveClass("bg-white", "border-t", "border-gray-200");
  });
});
