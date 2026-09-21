import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AdminUserManagement from "../../pages/AdminUserManagement";
import CommunityMembers from "../../pages/CommunityMembers";

vi.mock("../../pages/Management", () => ({
  default: ({ scope }: { scope?: string }) => <div>scope:{scope}</div>,
}));

describe("Community and User Management page scopes", () => {
  it("pins Members to the community-safe scope", () => {
    render(<CommunityMembers />);
    expect(screen.getByText("scope:community")).toBeInTheDocument();
  });

  it("pins User Management to the administrative scope", () => {
    render(<AdminUserManagement />);
    expect(screen.getByText("scope:admin")).toBeInTheDocument();
  });
});
