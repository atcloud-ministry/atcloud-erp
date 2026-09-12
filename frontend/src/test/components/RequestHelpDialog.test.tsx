import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RequestHelpDialog from "../../components/alumniHelp/RequestHelpDialog";

const mocks = vi.hoisted(() => ({
  getTerms: vi.fn(),
  create: vi.fn(),
  setCount: vi.fn(),
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  alumniHelpService: {
    getTerms: mocks.getTerms,
    create: mocks.create,
  },
}));

vi.mock("../../contexts/AlumniHelpContext", () => ({
  useAlumniHelp: () => ({ setHelpActionRequiredCount: mocks.setCount }),
}));

const profile = {
  id: "64b000000000000000000001",
  displayName: "Amy Chen",
  avatar: null,
  professionalHeadline: null,
  company: "Microsoft",
  occupation: "Product Manager",
  generalLocation: "Seattle",
  affiliations: [],
  helpOfferings: {
    careerAdvice: true,
    warmIntroduction: true,
    formalEmployeeReferral: false,
  },
  industry: "Technology",
  skills: [],
  bio: null,
};

const created = {
  request: { id: "64b000000000000000000002" },
  helpActionRequiredCount: 2,
};

describe("RequestHelpDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTerms.mockResolvedValue({
      consent: { version: "help-consent-v1", text: "Voluntary help consent." },
      disclaimer: {
        version: "help-disclaimer-v1",
        text: "No employment result is guaranteed.",
      },
    });
    mocks.create.mockResolvedValue(created);
  });

  it("shows only enabled offerings, no job fields, and submits current term versions", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <RequestHelpDialog
        onClose={vi.fn()}
        onCreated={onCreated}
        open
        profile={profile}
        writable
      />,
    );

    expect(await screen.findByRole("dialog", { name: /Request help from Amy Chen/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Career Advice")).toBeInTheDocument();
    expect(screen.getByLabelText("Warm Introduction")).toBeInTheDocument();
    expect(screen.queryByLabelText("Formal Employee Referral")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/^(job|job opening|employer)/i),
    ).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Warm Introduction"));
    await user.type(screen.getByLabelText(/Opening note/), "Could we talk?");
    await user.click(screen.getByLabelText(/agree to the Alumni Help consent/i));
    await user.click(screen.getByLabelText(/acknowledge the Alumni Help disclaimer/i));
    await user.click(screen.getByRole("button", { name: "Send Request" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(mocks.create.mock.calls[0][0]).toEqual({
      alumniProfileId: profile.id,
      requestedHelpType: "warm_introduction",
      openingNote: "Could we talk?",
      consentVersion: "help-consent-v1",
      disclaimerVersion: "help-disclaimer-v1",
    });
    expect(mocks.create.mock.calls[0][1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mocks.setCount).toHaveBeenCalledWith(2);
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it("reuses the same idempotency key after an uncertain retry", async () => {
    const user = userEvent.setup();
    mocks.create
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(created);
    render(
      <RequestHelpDialog
        onClose={vi.fn()}
        onCreated={vi.fn()}
        open
        profile={profile}
        writable
      />,
    );

    await screen.findByText("Voluntary help consent.");
    await user.click(screen.getByLabelText("Career Advice"));
    await user.click(screen.getByLabelText(/agree to the Alumni Help consent/i));
    await user.click(screen.getByLabelText(/acknowledge the Alumni Help disclaimer/i));
    await user.click(screen.getByRole("button", { name: "Send Request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
    await user.click(screen.getByRole("button", { name: "Send Request" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1][1]).toBe(mocks.create.mock.calls[0][1]);
  });

  it("does not fetch terms or expose a write form in read-only mode", () => {
    render(
      <RequestHelpDialog
        onClose={vi.fn()}
        onCreated={vi.fn()}
        open
        profile={profile}
        writable={false}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("currently read-only");
    expect(screen.queryByRole("button", { name: "Send Request" })).not.toBeInTheDocument();
    expect(mocks.getTerms).not.toHaveBeenCalled();
  });
});
