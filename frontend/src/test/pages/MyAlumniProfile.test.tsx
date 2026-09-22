import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  type ReactNode,
} from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MyAlumniProfile from "../../pages/MyAlumniProfile";
import type { OwnAlumniProfileDTO } from "../../services/api";

const mocks = vi.hoisted(() => {
  const error = vi.fn();
  const success = vi.fn();
  return {
    createIdempotencyKey: vi.fn(),
    ensureOwnDraft: vi.fn(),
    error,
    getOwn: vi.fn(),
    previewOwn: vi.fn(),
    publishOwn: vi.fn(),
    success,
    toast: Object.freeze({ error, info: vi.fn(), success, warning: vi.fn() }),
    updateOwn: vi.fn(),
    withdrawOwn: vi.fn(),
    writable: true,
  };
});

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  alumniDirectoryService: {
    getOwn: mocks.getOwn,
    ensureOwnDraft: mocks.ensureOwnDraft,
    previewOwn: mocks.previewOwn,
    publishOwn: mocks.publishOwn,
    updateOwn: mocks.updateOwn,
    withdrawOwn: mocks.withdrawOwn,
  },
}));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      version: 1,
      revision: 1,
      alumniNetwork: {
        mode: mocks.writable ? "on" : "read_only",
        readable: true,
        writable: mocks.writable,
      },
    },
  }),
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => mocks.toast,
}));

vi.mock("../../utils/idempotencyKey", () => ({
  createIdempotencyKey: mocks.createIdempotencyKey,
}));

const IDS = {
  profile: "64b000000000000000000001",
  affiliation: "64b000000000000000000002",
};

const IDEMPOTENCY_KEYS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function ownProfile(
  overrides: Partial<OwnAlumniProfileDTO> = {},
): OwnAlumniProfileDTO {
  return {
    id: IDS.profile,
    displayName: "Amy Chen",
    avatar: null,
    professionalHeadline: "Building useful products",
    company: "Microsoft",
    occupation: "Product Manager",
    generalLocation: "Seattle",
    affiliations: [
      {
        id: IDS.affiliation,
        programName: "EMBA",
        cohortLabel: "2022",
      },
    ],
    helpOfferings: {
      careerAdvice: true,
      warmIntroduction: true,
      formalEmployeeReferral: false,
    },
    industry: "Technology",
    skills: ["Product strategy", "Mentoring"],
    bio: "Happy to help fellow alumni.",
    publishStatus: "draft",
    consentVersion: null,
    hasCurrentPublicationConsent: false,
    publicationConsent: {
      version: "alumni-profile-publication-v1",
      text: "I consent to publish this profile to active, verified members.",
    },
    publishReadiness: { ready: true, issues: [] },
    revision: 3,
    publishedAt: null,
    withdrawnAt: null,
    updatedAt: "2026-09-12T12:00:00.000Z",
    ...overrides,
    acceptedPublicationConsent: overrides.acceptedPublicationConsent ?? null,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderProfile(
  path = "/dashboard/community/alumni/me",
  strict = false,
) {
  const router: ReactNode = (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/dashboard/community/alumni/me"
          element={
            <>
              <MyAlumniProfile />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{router}</StrictMode> : router);
}

describe("MyAlumniProfile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.writable = true;
    mocks.createIdempotencyKey
      .mockReturnValueOnce(IDEMPOTENCY_KEYS[0])
      .mockReturnValueOnce(IDEMPOTENCY_KEYS[1])
      .mockReturnValue(IDEMPOTENCY_KEYS[2]);
    mocks.getOwn.mockResolvedValue(ownProfile());
    mocks.ensureOwnDraft.mockResolvedValue(ownProfile());
    mocks.previewOwn.mockResolvedValue(ownProfile());
    mocks.updateOwn.mockResolvedValue(ownProfile({ revision: 4 }));
    mocks.publishOwn.mockResolvedValue(
      ownProfile({
        publishStatus: "published",
        consentVersion: "alumni-profile-publication-v1",
        hasCurrentPublicationConsent: true,
        revision: 4,
        publishedAt: "2026-09-12T12:30:00.000Z",
      }),
    );
    mocks.withdrawOwn.mockResolvedValue(
      ownProfile({
        publishStatus: "withdrawn",
        revision: 5,
        withdrawnAt: "2026-09-12T13:00:00.000Z",
      }),
    );
  });

  it("renders the saved privacy-safe preview with narrow-screen-first structure", async () => {
    renderProfile();

    const preview = await screen.findByRole("article", {
      name: "Alumni profile preview",
    });
    expect(within(preview).getByRole("heading", { name: "Amy Chen" })).toBeInTheDocument();
    expect(preview).toHaveTextContent("Product Manager · Microsoft");
    expect(preview).toHaveTextContent("EMBA 2022");
    expect(screen.getByText(/exact phone number, email address, and birth year/i)).toBeInTheDocument();

    const identity = within(preview)
      .getByRole("heading", { name: "Amy Chen" })
      .parentElement?.parentElement;
    expect(identity).toHaveClass("flex-col", "sm:flex-row", "sm:items-start");
    expect(screen.getByRole("button", { name: "Preview" }).parentElement).toHaveClass(
      "grid",
      "grid-cols-2",
    );
  });

  it("announces the selected mode and restores focus after canceling edits", async () => {
    const user = userEvent.setup();
    renderProfile();

    const previewButton = await screen.findByRole("button", { name: "Preview" });
    const editButton = screen.getByRole("button", { name: "Edit" });
    expect(previewButton).toHaveAttribute("aria-pressed", "true");
    expect(editButton).toHaveAttribute("aria-pressed", "false");

    await user.click(editButton);
    expect(previewButton).toHaveAttribute("aria-pressed", "false");
    expect(editButton).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(previewButton).toHaveFocus());
    expect(previewButton).toHaveAttribute("aria-pressed", "true");
  });

  it("replaces an aborted initial load under React StrictMode", async () => {
    renderProfile("/dashboard/community/alumni/me", true);

    expect(
      await screen.findByRole("heading", { name: "My Alumni Profile" }),
    ).toBeInTheDocument();
    expect(mocks.getOwn).toHaveBeenCalledTimes(2);
    expect((mocks.getOwn.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    expect((mocks.getOwn.mock.calls[1][0] as AbortSignal).aborted).toBe(false);
  });

  it("normalizes edits and saves all three offering choices with optimistic revision", async () => {
    const user = userEvent.setup();
    const saved = ownProfile({
      professionalHeadline: "Product and data leader",
      skills: ["Strategy", "Data", "Mentoring"],
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: true,
        formalEmployeeReferral: true,
      },
      revision: 4,
    });
    mocks.updateOwn.mockResolvedValue(saved);
    renderProfile();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Professional headline"), {
      target: { value: "  Product   and data leader  " },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Separate up to 20 skills with commas"),
      {
        target: { value: " Strategy, strategy, Data, Mentoring " },
      },
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Formal Employee Referral" }),
    );
    await user.click(screen.getByRole("button", { name: "Save Profile" }));

    await waitFor(() =>
      expect(mocks.updateOwn).toHaveBeenCalledWith(
        {
          expectedRevision: 3,
          professionalHeadline: "Product and data leader",
          industry: "Technology",
          skills: ["Strategy", "Data", "Mentoring"],
          bio: "Happy to help fellow alumni.",
          helpOfferings: {
            careerAdvice: true,
            warmIntroduction: true,
            formalEmployeeReferral: true,
          },
        },
        IDEMPOTENCY_KEYS[0],
      ),
    );
    expect(mocks.success).toHaveBeenCalledWith(
      "Your alumni profile has been saved.",
    );
    expect(await screen.findByText("Product and data leader")).toBeInTheDocument();
  });

  it("preserves About paragraph breaks in the save request and saved preview", async () => {
    const user = userEvent.setup();
    const bio = "First paragraph.\n\nSecond paragraph.";
    mocks.updateOwn.mockResolvedValue(ownProfile({ bio, revision: 4 }));
    renderProfile();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(
      screen.getByPlaceholderText(
        "Share the experience and perspective you would like alumni to know.",
      ),
      { target: { value: bio } },
    );
    await user.click(screen.getByRole("button", { name: "Save Profile" }));

    await waitFor(() =>
      expect(mocks.updateOwn).toHaveBeenCalledWith(
        expect.objectContaining({ bio }),
        IDEMPOTENCY_KEYS[0],
      ),
    );
    const preview = await screen.findByRole("article", {
      name: "Alumni profile preview",
    });
    const about = within(preview).getByRole("heading", { name: "About" });
    expect(about.nextElementSibling?.textContent).toBe(bio);
    expect(about.nextElementSibling).toHaveClass("whitespace-pre-wrap");
  });

  it("reuses an idempotency key for an unchanged failed save payload", async () => {
    const user = userEvent.setup();
    mocks.updateOwn.mockRejectedValue(new Error("Temporary failure"));
    renderProfile();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Industry"));
    await user.type(screen.getByLabelText("Industry"), "Education");
    const saveButton = screen.getByRole("button", { name: "Save Profile" });

    await user.click(saveButton);
    await waitFor(() => expect(mocks.updateOwn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);
    await waitFor(() => expect(mocks.updateOwn).toHaveBeenCalledTimes(2));

    expect(mocks.updateOwn.mock.calls[0][1]).toBe(IDEMPOTENCY_KEYS[0]);
    expect(mocks.updateOwn.mock.calls[1][1]).toBe(IDEMPOTENCY_KEYS[0]);
    expect(mocks.createIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith("Temporary failure");
  });

  it("loads a server preview and blocks publication while edits are unsaved", async () => {
    const user = userEvent.setup();
    mocks.previewOwn.mockResolvedValue(
      ownProfile({ professionalHeadline: "Saved server preview" }),
    );
    renderProfile();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Professional headline"));
    await user.type(screen.getByLabelText("Professional headline"), "Unsaved title");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("Saved server preview")).toBeInTheDocument();
    expect(screen.getByText(/preview shows the last saved version/i)).toBeInTheDocument();
    expect(mocks.previewOwn).toHaveBeenCalledTimes(1);
    expect(mocks.previewOwn).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Publish Profile" })).toBeDisabled();
  });

  it("discards an aborted preview response when a newer preview finishes first", async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: OwnAlumniProfileDTO) => void) | undefined;
    let resolveSecond: ((value: OwnAlumniProfileDTO) => void) | undefined;
    mocks.previewOwn
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );
    renderProfile();

    const previewButton = await screen.findByRole("button", { name: "Preview" });
    await user.click(previewButton);
    const firstSignal = mocks.previewOwn.mock.calls[0][0] as AbortSignal;
    await user.click(previewButton);
    expect(firstSignal.aborted).toBe(true);

    resolveSecond?.(ownProfile({ professionalHeadline: "Newest preview" }));
    expect(await screen.findByText("Newest preview")).toBeInTheDocument();
    resolveFirst?.(ownProfile({ professionalHeadline: "Stale preview" }));
    await waitFor(() =>
      expect(screen.queryByText("Stale preview")).not.toBeInTheDocument(),
    );
  });

  it("requires current consent and publishes the saved revision", async () => {
    const user = userEvent.setup();
    renderProfile();

    const publishButton = await screen.findByRole("button", {
      name: "Publish Profile",
    });
    expect(publishButton).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: /I consent to publish this profile/i,
      }),
    );
    expect(publishButton).toBeEnabled();
    await user.click(publishButton);

    await waitFor(() =>
      expect(mocks.publishOwn).toHaveBeenCalledWith(
        {
          expectedRevision: 3,
          consentVersion: "alumni-profile-publication-v1",
          consentAccepted: true,
        },
        IDEMPOTENCY_KEYS[0],
      ),
    );
    expect(await screen.findByText("Published")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw Profile" })).toBeEnabled();
  });

  it("lets a published owner accept current consent and republish", async () => {
    const user = userEvent.setup();
    mocks.getOwn.mockResolvedValue(
      ownProfile({
        publishStatus: "published",
        consentVersion: "directory-v1",
        hasCurrentPublicationConsent: false,
        acceptedPublicationConsent: {
          version: "directory-v1",
          text: "Earlier accepted publication consent.",
          documentHash: "a".repeat(64),
          effectiveAt: "2026-09-01T00:00:00.000Z",
          acceptedAt: "2026-09-12T12:30:00.000Z",
        },
        publishedAt: "2026-09-12T12:30:00.000Z",
      }),
    );
    mocks.publishOwn.mockResolvedValue(
      ownProfile({
        publishStatus: "published",
        consentVersion: "alumni-profile-publication-v1",
        hasCurrentPublicationConsent: true,
        revision: 4,
        publishedAt: "2026-09-12T12:30:00.000Z",
      }),
    );
    renderProfile();

    expect(await screen.findByText("Consent update required")).toBeInTheDocument();
    expect(screen.getByText(/profile is hidden from the Directory/i)).toBeInTheDocument();
    expect(
      screen.getByText("Earlier accepted publication consent."),
    ).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: /I consent to publish this profile/i,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Accept and Republish Profile" }),
    );

    await waitFor(() =>
      expect(mocks.publishOwn).toHaveBeenCalledWith(
        {
          expectedRevision: 3,
          consentVersion: "alumni-profile-publication-v1",
          consentAccepted: true,
        },
        IDEMPOTENCY_KEYS[0],
      ),
    );
    expect(await screen.findByText("Published")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw Profile" })).toBeEnabled();
  });

  it("shows readiness issues and keeps publication disabled", async () => {
    const user = userEvent.setup();
    mocks.getOwn.mockResolvedValue(
      ownProfile({
        publishReadiness: {
          ready: false,
          issues: [
            {
              field: "birthYear",
              code: "registration_profile_incomplete",
              message: "Complete your ERP registration profile.",
            },
          ],
        },
      }),
    );
    renderProfile();

    expect(await screen.findByText("Complete your ERP registration profile.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complete My ERP Profile" })).toHaveAttribute(
      "href",
      "/dashboard/profile?mode=complete",
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /I consent to publish this profile/i,
      }),
    );
    expect(screen.getByRole("button", { name: "Publish Profile" })).toBeDisabled();
    expect(mocks.publishOwn).not.toHaveBeenCalled();
  });

  it("requires confirmation and withdraws the published revision", async () => {
    const user = userEvent.setup();
    mocks.getOwn.mockResolvedValue(
      ownProfile({
        publishStatus: "published",
        consentVersion: "alumni-profile-publication-v1",
        hasCurrentPublicationConsent: true,
        publishedAt: "2026-09-12T12:30:00.000Z",
      }),
    );
    renderProfile();

    await user.click(
      await screen.findByRole("button", { name: "Withdraw Profile" }),
    );
    expect(screen.getByText(/Withdraw this profile from the Directory now/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Keep Published" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Confirm Withdrawal" }));

    await waitFor(() =>
      expect(mocks.withdrawOwn).toHaveBeenCalledWith(3, IDEMPOTENCY_KEYS[0]),
    );
    expect(await screen.findByText("Withdrawn")).toBeInTheDocument();
    expect(mocks.success).toHaveBeenCalledWith(
      "Your alumni profile has been withdrawn.",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Directory publication" }),
      ).toHaveFocus(),
    );
  });

  it("keeps every profile mutation disabled in read-only mode", async () => {
    const user = userEvent.setup();
    mocks.writable = false;
    renderProfile();

    expect(await screen.findByText(/currently read-only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish Profile" })).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: /I consent to publish this profile/i }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Professional headline")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Profile" })).toBeDisabled();
    expect(mocks.updateOwn).not.toHaveBeenCalled();
    expect(mocks.publishOwn).not.toHaveBeenCalled();
  });

  it("ignores obsolete invitation links and removes their secret query fields", async () => {
    renderProfile(
      "/dashboard/community/alumni/me?invitation=old-invitation&claim=secret-token&source=email",
    );

    expect(await screen.findByRole("heading", { name: "My Alumni Profile" })).toBeInTheDocument();
    expect(mocks.getOwn).toHaveBeenCalledTimes(1);
    expect(mocks.ensureOwnDraft).not.toHaveBeenCalled();
    expect(mocks.createIdempotencyKey).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/dashboard/community/alumni/me?source=email",
      ),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("secret-token");
  });

  it("does not process obsolete invitation links under React StrictMode", async () => {
    renderProfile(
      "/dashboard/community/alumni/me?invitation=old-invitation&claim=secret-token&source=email",
      true,
    );

    expect(
      await screen.findByRole("heading", { name: "My Alumni Profile" }),
    ).toBeInTheDocument();
    expect(mocks.createIdempotencyKey).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/dashboard/community/alumni/me?source=email",
      ),
    );
  });

  it("offers account completion when owner profile creation is not ready", async () => {
    mocks.getOwn.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    mocks.ensureOwnDraft.mockRejectedValue(
      Object.assign(new Error("Complete your account profile"), { status: 409 }),
    );
    renderProfile();
    expect(
      await screen.findByRole("heading", { name: "Alumni profile not available" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complete account profile" })).toHaveAttribute(
      "href",
      "/dashboard/profile?mode=complete",
    );
    expect(screen.getByRole("button", { name: "Try Again" })).toBeEnabled();
  });

  it("offers account completion when a missing owner draft is not publishable yet", async () => {
    mocks.getOwn.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    mocks.ensureOwnDraft.mockRejectedValueOnce(
      Object.assign(new Error("The alumni profile is not ready to publish."), {
        status: 422,
      }),
    );

    renderProfile();

    expect(
      await screen.findByRole("heading", { name: "Alumni profile not available" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complete account profile" })).toHaveAttribute(
      "href",
      "/dashboard/profile?mode=complete",
    );
    expect(screen.queryByText("The alumni profile is not ready to publish.")).not.toBeInTheDocument();
    expect(mocks.ensureOwnDraft).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("creates a private draft through the writable endpoint when an owner lookup is missing", async () => {
    mocks.getOwn.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    renderProfile();

    expect(await screen.findByRole("heading", { name: "My Alumni Profile" })).toBeInTheDocument();
    expect(mocks.ensureOwnDraft).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("explains when a missing owner profile cannot be created in read-only mode", async () => {
    mocks.writable = false;
    mocks.getOwn.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    renderProfile();

    expect(await screen.findByText(/Alumni Profile updates are temporarily paused/i)).toBeInTheDocument();
    expect(mocks.getOwn).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.ensureOwnDraft).not.toHaveBeenCalled();
  });

  it("aborts the owner read when the page unmounts", async () => {
    mocks.getOwn.mockReturnValue(new Promise(() => undefined));
    const { unmount } = renderProfile();

    await waitFor(() => expect(mocks.getOwn).toHaveBeenCalledTimes(1));
    const signal = mocks.getOwn.mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
