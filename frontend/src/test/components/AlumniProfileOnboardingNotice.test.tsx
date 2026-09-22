import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AlumniProfileOnboardingNotice from "../../components/profile/AlumniProfileOnboardingNotice";
import type { AuthUser } from "../../types";

const mocks = vi.hoisted(() => ({ getOwn: vi.fn(), readable: true, writable: true }));

vi.mock("../../services/api", () => ({
  alumniDirectoryService: { getOwn: mocks.getOwn },
}));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    config: { alumniNetwork: { readable: mocks.readable, writable: mocks.writable } },
  }),
}));

const completeUser: AuthUser = {
  id: "user-1",
  username: "alumna",
  firstName: "Amy",
  lastName: "Chen",
  email: "amy@example.com",
  phone: "+15102581542",
  birthYear: 1985,
  residenceCity: "Seattle",
  residenceRegion: "US-WA",
  residenceCountryCode: "US",
  employmentStatus: "employed",
  company: "Microsoft",
  role: "Participant",
  isAtCloudLeader: "No",
  gender: "female",
};

function renderNotice(user = completeUser) {
  return render(
    <MemoryRouter>
      <AlumniProfileOnboardingNotice user={user} pathname="/dashboard" />
    </MemoryRouter>,
  );
}

describe("AlumniProfileOnboardingNotice", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readable = true;
    mocks.writable = true;
    mocks.getOwn.mockResolvedValue({ publishStatus: "draft" });
  });

  it("guides a complete user with a private draft to their own profile", async () => {
    const user = userEvent.setup();
    renderNotice();

    expect(
      await screen.findByRole("heading", { name: "Complete your Alumni Profile" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to Alumni Profile" })).toHaveAttribute(
      "href",
      "/dashboard/community/alumni/me",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss Alumni Profile reminder" }));
    expect(screen.queryByTestId("alumni-profile-onboarding-notice")).not.toBeInTheDocument();
  });

  it("does not prompt before account completion", () => {
    renderNotice({ ...completeUser, birthYear: undefined });
    expect(mocks.getOwn).not.toHaveBeenCalled();
    expect(screen.queryByTestId("alumni-profile-onboarding-notice")).not.toBeInTheDocument();
  });

  it("does not prompt for a published profile", async () => {
    mocks.getOwn.mockResolvedValue({ publishStatus: "published" });
    renderNotice();
    await vi.waitFor(() => expect(mocks.getOwn).toHaveBeenCalled());
    expect(screen.queryByTestId("alumni-profile-onboarding-notice")).not.toBeInTheDocument();
  });

  it("guides a complete user to create a missing draft when edits are available", async () => {
    mocks.getOwn.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    renderNotice();
    expect(await screen.findByText(/Set up your private draft/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to Alumni Profile" })).toHaveAttribute(
      "href",
      "/dashboard/community/alumni/me",
    );
  });
});
