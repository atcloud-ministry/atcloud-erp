import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OrganizerSelection from "../../components/events/OrganizerSelection";
import { NotificationProvider } from "../../contexts/NotificationModalContext";
import { AuthProvider } from "../../contexts/AuthContext";

const listOptionsMock = vi.fn();
vi.mock("../../services/api", async () => {
  const actual = await vi.importActual<typeof import("../../services/api")>(
    "../../services/api"
  );
  return {
    ...actual,
    userOptionsService: {
      list: (...args: unknown[]) => listOptionsMock(...args),
    },
  };
});

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>
    <NotificationProvider>{children}</NotificationProvider>
  </AuthProvider>
);

describe("OrganizerSelection — loads all authorized users without search", () => {
  it("loads multiple pages and renders authorized users list when dropdown opens", async () => {
    // Prepare two resource-scoped option pages.
    const page1Leaders = Array.from({ length: 20 }).map((_, i) => ({
      id: `L${i + 1}`,
      username: `leader${i + 1}`,
      firstName: `Leader${i + 1}`,
      lastName: "User",
      role: "Leader",
      avatar: null,
      gender: "male",
      roleInAtCloud: null,
    }));
    const page2Leaders = [
      {
        id: "L21",
        username: "leader21",
        firstName: "Leader21",
        lastName: "User",
        role: "Leader",
        avatar: null,
        gender: "male",
        roleInAtCloud: null,
      },
    ];
    page1Leaders.push(
      {
        id: "A1",
        username: "admin1",
        firstName: "Admin",
        lastName: "One",
        role: "Administrator",
        avatar: null,
        gender: "male",
        roleInAtCloud: null,
      },
    );

    listOptionsMock.mockImplementation(async (params: { page?: number }) => {
      const page = params?.page || 1;
      return {
        options: page === 1 ? page1Leaders : page2Leaders,
        pagination: {
          currentPage: page,
          totalPages: 2,
          totalOptions: 22,
          hasNext: page === 1,
          hasPrev: page > 1,
        },
      };
    });

    const mainOrganizer = {
      id: "owner1",
      firstName: "Owner",
      lastName: "Main",
      systemAuthorizationLevel: "Administrator",
      gender: "male" as const,
      avatar: null,
    };

    render(
      <Wrapper>
        <OrganizerSelection
          mainOrganizer={mainOrganizer as any}
          selectedOrganizers={[]}
          onOrganizersChange={() => {}}
        />
      </Wrapper>
    );

    // Open dropdown; without search it should start loading across pages
    fireEvent.click(screen.getByText(/add co-organizer/i));

    // Loading indicator appears then disappears
    expect(
      await screen.findByText(/loading authorized users/i)
    ).toBeInTheDocument();

    await waitFor(() => {
      // One of the users from page 2 should be visible (proof we traversed pages)
      expect(screen.getByText(/Leader21 User/i)).toBeInTheDocument();
      // And an Administrator should be visible too
      expect(screen.getByText(/Admin One/i)).toBeInTheDocument();
    });
  });
});
