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
  useNavigate,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MyAlumniProfile from "../../pages/MyAlumniProfile";
import type { OwnAlumniProfileDTO } from "../../services/api";

const mocks = vi.hoisted(() => {
  const error = vi.fn();
  const success = vi.fn();
  return {
    claim: vi.fn(),
    createIdempotencyKey: vi.fn(),
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
    previewOwn: mocks.previewOwn,
    publishOwn: mocks.publishOwn,
    updateOwn: mocks.updateOwn,
    withdrawOwn: mocks.withdrawOwn,
  },
  alumniInvitationsService: { claim: mocks.claim },
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
  invitation: "64b000000000000000000003",
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
  };
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button
        onClick={() =>
          navigate(
            `/dashboard/community/alumni/me?invitation=${IDS.invitation}&claim=second-secret&source=email`,
          )
        }
        type="button"
      >
        Open another invitation
      </button>
    </>
  );
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
    mocks.claim.mockResolvedValue({ status: "claimed" });
    mocks.getOwn.mockResolvedValue(ownProfile());
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
        consentVersion: "directory-v0",
        hasCurrentPublicationConsent: false,
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
    await user.click(screen.getByRole("button", { name: "Confirm Withdrawal" }));

    await waitFor(() =>
      expect(mocks.withdrawOwn).toHaveBeenCalledWith(3, IDEMPOTENCY_KEYS[0]),
    );
    expect(await screen.findByText("Withdrawn")).toBeInTheDocument();
    expect(mocks.success).toHaveBeenCalledWith(
      "Your alumni profile has been withdrawn.",
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

  it("claims a deep link with one stable key and removes only secret query fields", async () => {
    renderProfile(
      `/dashboard/community/alumni/me?invitation=${IDS.invitation}&claim=secret-token&source=email`,
    );

    await screen.findByRole("heading", { name: "My Alumni Profile" });
    await waitFor(() => expect(mocks.claim).toHaveBeenCalled());
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.claim.mock.calls.map((call) => call[1]))).toEqual(
      new Set([IDEMPOTENCY_KEYS[0]]),
    );
    expect(mocks.claim.mock.calls.every((call) => call[0] === "secret-token")).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/dashboard/community/alumni/me?source=email",
      ),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("secret-token");
  });

  it("replaces an aborted claim load under React StrictMode", async () => {
    renderProfile(
      `/dashboard/community/alumni/me?invitation=${IDS.invitation}&claim=secret-token&source=email`,
      true,
    );

    expect(
      await screen.findByRole("heading", { name: "My Alumni Profile" }),
    ).toBeInTheDocument();
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(new Set(mocks.claim.mock.calls.map((call) => call[1]))).toEqual(
      new Set([IDEMPOTENCY_KEYS[0]]),
    );
    expect((mocks.claim.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    expect((mocks.claim.mock.calls[1][2] as AbortSignal).aborted).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/dashboard/community/alumni/me?source=email",
      ),
    );
  });

  it("claims a new invitation query without remounting the owner page", async () => {
    const user = userEvent.setup();
    renderProfile();
    await screen.findByRole("heading", { name: "My Alumni Profile" });

    await user.click(
      screen.getByRole("button", { name: "Open another invitation" }),
    );
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledTimes(1));
    expect(mocks.claim).toHaveBeenCalledWith(
      "second-secret",
      IDEMPOTENCY_KEYS[0],
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/dashboard/community/alumni/me?source=email",
      ),
    );
  });

  it("shows a retryable claim error after an earlier owner-profile 404", async () => {
    const user = userEvent.setup();
    mocks.getOwn.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    mocks.claim.mockRejectedValue(new Error("Temporary claim failure"));
    renderProfile();
    expect(
      await screen.findByRole("heading", { name: "Alumni profile not available" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Open another invitation" }),
    );

    expect(await screen.findByText("Temporary claim failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeEnabled();
    expect(
      screen.queryByRole("heading", { name: "Alumni profile not available" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a failed claim in memory so Try Again can reuse the secure token and key", async () => {
    const user = userEvent.setup();
    mocks.claim
      .mockRejectedValueOnce(new Error("Temporary claim failure"))
      .mockResolvedValueOnce({ status: "claimed" });
    renderProfile(
      `/dashboard/community/alumni/me?invitation=${IDS.invitation}&claim=secret-token&source=email`,
    );

    expect(await screen.findByText("Temporary claim failure")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/dashboard/community/alumni/me?source=email",
      ),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("secret-token");

    await user.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("heading", { name: "My Alumni Profile" })).toBeInTheDocument();
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(mocks.claim.mock.calls.map((call) => call[0])).toEqual([
      "secret-token",
      "secret-token",
    ]);
    expect(mocks.claim.mock.calls.map((call) => call[1])).toEqual([
      IDEMPOTENCY_KEYS[0],
      IDEMPOTENCY_KEYS[0],
    ]);
    expect(mocks.claim.mock.calls.every((call) => call[2] instanceof AbortSignal)).toBe(
      true,
    );
    expect(mocks.createIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it("does not claim in read-only mode and explains how an unclaimed user can retry", async () => {
    mocks.writable = false;
    mocks.getOwn.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    renderProfile(
      `/dashboard/community/alumni/me?invitation=${IDS.invitation}&claim=secret-token&source=email`,
    );

    expect(await screen.findByText(/Profile claiming is temporarily paused/i)).toBeInTheDocument();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.getOwn).toHaveBeenCalledWith(expect.any(AbortSignal));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/dashboard/community/alumni/me?source=email",
      ),
    );
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
