import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CommunityLayout from "../../layouts/CommunityLayout";

const mocks = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../contexts/AlumniHelpContext", () => ({
  useAlumniHelp: () => ({ helpActionRequiredCount: mocks.count }),
}));

function renderCommunity(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/community" element={<CommunityLayout />}>
          <Route path="alumni/*" element={<div>Directory content</div>} />
          <Route path="help-requests/*" element={<div>Help content</div>} />
          <Route path="members" element={<div>Members content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("CommunityLayout", () => {
  beforeEach(() => {
    mocks.count = 0;
  });
  it("provides canonical Directory and Members navigation", () => {
    renderCommunity("/dashboard/community/members");

    const navigation = screen.getByRole("navigation", {
      name: "Community sections",
    });
    expect(navigation).toHaveClass("overflow-x-auto");
    expect(navigation.firstElementChild).toHaveClass("min-w-max");
    expect(screen.getByRole("link", { name: "Alumni Directory" })).toHaveAttribute(
      "href",
      "/dashboard/community/alumni",
    );
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute(
      "href",
      "/dashboard/community/members",
    );
    expect(
      screen.getByRole("link", { name: "My Alumni Profile" }),
    ).toHaveAttribute("href", "/dashboard/community/alumni/me");
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Members content")).toBeInTheDocument();
  });

  it("keeps Directory selected on a profile detail route", () => {
    renderCommunity("/dashboard/community/alumni/profile-123");

    expect(
      screen.getByRole("link", { name: "Alumni Directory" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Directory content")).toBeInTheDocument();
  });

  it("selects only My Alumni Profile on the own-profile route", () => {
    renderCommunity("/dashboard/community/alumni/me");

    expect(
      screen.getByRole("link", { name: "My Alumni Profile" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Alumni Directory" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("selects Help Requests on list/detail routes and caps its visible badge", () => {
    mocks.count = 123;
    renderCommunity("/dashboard/community/help-requests/64b000000000000000000001");

    const link = screen.getByRole("link", {
      name: "Help Requests, 123 actions required",
    });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveTextContent("99+");
    expect(screen.getByText("Help content")).toBeInTheDocument();
  });
});
