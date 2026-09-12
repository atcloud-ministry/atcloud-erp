import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import AlumniDirectoryCard from "../../components/directory/AlumniDirectoryCard";
import DirectoryAvatar, {
  initialsFor,
  safeAvatarUrl,
} from "../../components/directory/DirectoryAvatar";

const profile = {
  id: "64b000000000000000000001",
  displayName: "Amy Chen",
  avatar: null,
  professionalHeadline: "Building useful products",
  company: "Microsoft",
  occupation: "Product Manager",
  generalLocation: "Seattle",
  affiliations: [
    {
      id: "64b000000000000000000002",
      programName: "EMBA",
      cohortLabel: "2022",
    },
  ],
  helpOfferings: {
    careerAdvice: true,
    warmIntroduction: true,
    formalEmployeeReferral: false,
  },
};

describe("AlumniDirectoryCard", () => {
  it("shows the published professional card and all three offering states", () => {
    render(
      <MemoryRouter>
        <AlumniDirectoryCard profile={profile} />
      </MemoryRouter>,
    );

    const profileLink = screen.getByRole("link", { name: "Amy Chen" });
    expect(profileLink).toHaveAttribute(
      "href",
      "/dashboard/community/alumni/64b000000000000000000001",
    );
    expect(screen.getByText("Product Manager · Microsoft")).toBeInTheDocument();
    expect(screen.getByText("Seattle")).toBeInTheDocument();
    expect(screen.getByText("EMBA 2022")).toBeInTheDocument();
    const offerings = screen.getByRole("list", { name: "Help offerings" });
    expect(offerings).toHaveTextContent("Available: Career Advice");
    expect(offerings).toHaveTextContent("Available: Warm Introduction");
    expect(offerings).toHaveTextContent(
      "Not available: Formal Employee Referral",
    );
    const requestHelp = screen.getByRole("button", { name: "Request Help" });
    expect(requestHelp).toBeDisabled();
    expect(requestHelp).toHaveAccessibleDescription(
      "Request Help is not available yet.",
    );
    expect(screen.getByRole("article")).toHaveClass("min-w-0");
    expect(
      screen.getByRole("link", { name: "View Profile" }).parentElement,
    ).toHaveClass("grid-cols-1", "sm:grid-cols-2");
  });

  it("uses stable initials and rejects unsafe avatar schemes", () => {
    expect(initialsFor("Amy Chen")).toBe("AC");
    expect(initialsFor("陈 小 明")).toBe("陈明");
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(safeAvatarUrl("//untrusted.example/avatar.png")).toBeNull();
    expect(safeAvatarUrl("/uploads/avatar.png")).toBe("/uploads/avatar.png");
  });

  it("falls back to initials when a permitted image fails", () => {
    render(
      <DirectoryAvatar
        avatar="https://cdn.example/avatar.png"
        displayName="Amy Chen"
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Amy Chen avatar" }));
    expect(screen.getByRole("img", { name: "Amy Chen avatar" })).toHaveTextContent(
      "AC",
    );
  });
});
