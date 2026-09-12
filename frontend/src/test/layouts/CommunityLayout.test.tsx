import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import CommunityLayout from "../../layouts/CommunityLayout";

function renderCommunity(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/community" element={<CommunityLayout />}>
          <Route path="alumni/*" element={<div>Directory content</div>} />
          <Route path="members" element={<div>Members content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("CommunityLayout", () => {
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
});
