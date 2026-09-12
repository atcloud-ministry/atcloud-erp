import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AlumniDirectory from "../../pages/AlumniDirectory";
import AlumniDirectoryDetail from "../../pages/AlumniDirectoryDetail";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  readable: true,
  status: "ready" as "loading" | "ready" | "error",
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  alumniDirectoryService: {
    list: mocks.list,
    get: mocks.get,
  },
}));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: mocks.status,
    config: {
      version: 1,
      revision: 1,
      alumniNetwork: {
        mode: mocks.readable ? "read_only" : "off",
        readable: mocks.readable,
        writable: false,
      },
    },
  }),
}));

const card = {
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

function directoryPage(
  currentPage = 1,
  totalPages = 2,
  profiles = [card],
) {
  return {
    profiles,
    pagination: {
      currentPage,
      totalPages,
      totalProfiles: totalPages * 24,
      hasNext: currentPage < totalPages,
      hasPrev: currentPage > 1,
    },
  };
}

describe("AlumniDirectory page", () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.get.mockReset();
    mocks.readable = true;
    mocks.status = "ready";
    mocks.list.mockResolvedValue(directoryPage());
  });

  it("loads a responsive 24-item page and applies every approved filter", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AlumniDirectory />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Amy Chen")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(
      {
        page: 1,
        limit: 24,
        q: undefined,
        company: undefined,
        industry: undefined,
        skill: undefined,
        location: undefined,
        cohort: undefined,
        offering: undefined,
      },
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId("alumni-directory-grid")).toHaveClass(
      "grid-cols-1",
      "sm:grid-cols-2",
      "xl:grid-cols-3",
    );
    const filters = screen.getByRole("form", {
      name: "Search and filter alumni",
    });
    expect(screen.getByLabelText("Search alumni")).toHaveClass(
      "min-h-11",
      "w-full",
    );
    expect(screen.getByLabelText("Company").parentElement?.parentElement).toHaveClass(
      "grid-cols-1",
      "sm:grid-cols-2",
      "xl:grid-cols-3",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toHaveClass(
      "min-h-11",
      "w-full",
      "sm:w-auto",
    );
    expect(filters.lastElementChild).toHaveClass(
      "flex-col-reverse",
      "sm:flex-row",
    );

    await user.type(screen.getByLabelText("Search alumni"), "  Amy  ");
    await user.type(screen.getByLabelText("Company"), " Microsoft ");
    await user.type(screen.getByLabelText("Industry"), "Technology");
    await user.type(screen.getByLabelText("Skill"), "Product strategy");
    await user.type(screen.getByLabelText("General location"), "Seattle");
    await user.type(screen.getByLabelText("Cohort"), "EMBA 2022");
    await user.selectOptions(
      screen.getByLabelText("Help offering"),
      "formal_employee_referral",
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        {
          page: 1,
          limit: 24,
          q: "Amy",
          company: "Microsoft",
          industry: "Technology",
          skill: "Product strategy",
          location: "Seattle",
          cohort: "EMBA 2022",
          offering: "formal_employee_referral",
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it("requests the next page and aborts the in-flight request on unmount", async () => {
    const { unmount } = render(
      <MemoryRouter>
        <AlumniDirectory />
      </MemoryRouter>,
    );
    await screen.findByText("Page 1 of 2");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, limit: 24 }),
        expect.any(AbortSignal),
      ),
    );
    const signal = mocks.list.mock.calls.at(-1)?.[1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("returns to the last available page when data shrinks between requests", async () => {
    mocks.list
      .mockResolvedValueOnce(directoryPage(1, 2))
      .mockResolvedValueOnce(directoryPage(2, 1, []))
      .mockResolvedValueOnce(directoryPage(1, 1));
    render(
      <MemoryRouter>
        <AlumniDirectory />
      </MemoryRouter>,
    );

    await screen.findByText("Page 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, limit: 24 }),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("Amy Chen")).toBeInTheDocument();
    expect(screen.queryByText("No alumni found")).not.toBeInTheDocument();
  });

  it("fails closed without calling the Directory API", () => {
    mocks.readable = false;
    render(
      <MemoryRouter>
        <AlumniDirectory />
      </MemoryRouter>,
    );

    expect(screen.getByText("Alumni Directory unavailable")).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe("AlumniDirectoryDetail page", () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.get.mockReset();
    mocks.readable = true;
    mocks.status = "ready";
    mocks.get.mockResolvedValue({
      ...card,
      industry: "Technology",
      skills: ["Product strategy", "Mentoring"],
      bio: "Happy to help fellow alumni.",
    });
  });

  it("renders published detail fields and keeps Request Help inactive for M2", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/dashboard/community/alumni/64b000000000000000000001",
        ]}
      >
        <Routes>
          <Route
            element={<AlumniDirectoryDetail />}
            path="/dashboard/community/alumni/:profileId"
          />
        </Routes>
      </MemoryRouter>,
    );

    const heading = await screen.findByRole("heading", { name: "Amy Chen" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText("Happy to help fellow alumni.")).toBeInTheDocument();
    expect(screen.getByText("Technology")).toBeInTheDocument();
    expect(screen.getByText("Product strategy")).toBeInTheDocument();
    const requestHelp = screen.getByRole("button", { name: "Request Help" });
    expect(requestHelp).toBeDisabled();
    expect(requestHelp).toHaveAccessibleDescription(
      "Request Help is not available yet.",
    );
    expect(heading.closest("header")).toHaveClass(
      "flex-col",
      "sm:flex-row",
      "sm:items-start",
    );
    expect(
      screen.getByRole("heading", { name: "About" }).parentElement
        ?.parentElement?.parentElement,
    ).toHaveClass(
      "grid-cols-1",
      "md:grid-cols-[minmax(0,1fr)_minmax(15rem,0.7fr)]",
    );
    expect(mocks.get).toHaveBeenCalledWith(
      "64b000000000000000000001",
      expect.any(AbortSignal),
    );
  });

  it("does not query the API for a malformed profile id", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/community/alumni/not-an-id"]}>
        <Routes>
          <Route
            element={<AlumniDirectoryDetail />}
            path="/dashboard/community/alumni/:profileId"
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Profile not found")).toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("never displays the previous profile under a newly navigated profile id", async () => {
    const secondId = "64b000000000000000000004";
    let resolveSecond: ((value: typeof card & {
      industry: string;
      skills: string[];
      bio: string;
    }) => void) | undefined;
    const secondProfile = {
      ...card,
      id: secondId,
      displayName: "Jordan Lee",
      industry: "Education",
      skills: ["Teaching"],
      bio: "Supporting alumni educators.",
    };
    mocks.get
      .mockResolvedValueOnce({
        ...card,
        industry: "Technology",
        skills: ["Product strategy"],
        bio: "Happy to help fellow alumni.",
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    function SwitchProfile() {
      const navigate = useNavigate();
      return (
        <button
          onClick={() => navigate(`/dashboard/community/alumni/${secondId}`)}
          type="button"
        >
          Open Jordan
        </button>
      );
    }

    render(
      <MemoryRouter
        initialEntries={[
          "/dashboard/community/alumni/64b000000000000000000001",
        ]}
      >
        <Routes>
          <Route
            element={
              <>
                <AlumniDirectoryDetail />
                <SwitchProfile />
              </>
            }
            path="/dashboard/community/alumni/:profileId"
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Amy Chen" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Jordan" }));
    expect(screen.queryByRole("heading", { name: "Amy Chen" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading alumni profile...")).toBeInTheDocument();

    resolveSecond?.(secondProfile);
    expect(await screen.findByRole("heading", { name: "Jordan Lee" })).toBeInTheDocument();
  });
});
