import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import ProfileCompletionNotice from "../../components/profile/ProfileCompletionNotice";

const completeProfile = {
  phone: "+14155552671",
  birthYear: 1990,
  residenceCountryCode: "US",
  residenceRegion: "US-WA",
  residenceCity: "Seattle",
  employmentStatus: "employed",
  company: "Example Co",
  occupation: "Engineer",
} as const;

describe("ProfileCompletionNotice", () => {
  it("shows human field names and a completion entry without exposing values", () => {
    render(
      <MemoryRouter>
        <ProfileCompletionNotice
          profile={{
            ...completeProfile,
            phone: "private-invalid-phone",
            birthYear: undefined,
          }}
        />
      </MemoryRouter>,
    );

    const banner = screen.getByTestId("profile-completion-banner");
    expect(banner).toHaveTextContent("Phone, Birth year");
    expect(banner).not.toHaveTextContent("private-invalid-phone");
    expect(screen.getByRole("link", { name: "Complete profile" })).toHaveAttribute(
      "href",
      "/dashboard/profile?mode=complete",
    );
  });

  it("renders nothing for a complete profile", () => {
    render(
      <MemoryRouter>
        <ProfileCompletionNotice profile={completeProfile} />
      </MemoryRouter>,
    );

    expect(
      screen.queryByTestId("profile-completion-banner"),
    ).not.toBeInTheDocument();
  });
});
