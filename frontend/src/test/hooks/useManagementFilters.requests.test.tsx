import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UserSearchAndFilter from "../../components/management/UserSearchAndFilter";
import { useManagementFilters } from "../../hooks/useManagementFilters";

const mocks = vi.hoisted(() => ({
  fetchUsersWithFilters: vi.fn().mockResolvedValue(undefined),
  fetchMembers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../hooks/useUsersApi", () => ({
  useUsers: () => ({
    users: [],
    loading: false,
    error: null,
    pagination: {
      currentPage: 1,
      totalPages: 0,
      totalUsers: 0,
      hasNext: false,
      hasPrev: false,
    },
    fetchUsersWithFilters: mocks.fetchUsersWithFilters,
  }),
  useCommunityMembers: () => ({
    members: [],
    loading: false,
    error: null,
    pagination: {
      currentPage: 1,
      totalPages: 0,
      totalMembers: 0,
      hasNext: false,
      hasPrev: false,
    },
    fetchMembers: mocks.fetchMembers,
  }),
}));

vi.mock("../../hooks/useSocket", () => ({ useSocket: vi.fn() }));
vi.mock("../../services/socketService", () => ({
  socketService: { on: vi.fn(() => () => undefined) },
}));

function AdminFilterHarness() {
  const { handleFiltersChange } = useManagementFilters("admin");
  return (
    <UserSearchAndFilter
      currentUserRole="Administrator"
      loading={false}
      onFiltersChange={handleFiltersChange}
    />
  );
}

describe("Management initial user request", () => {
  beforeEach(() => {
    mocks.fetchUsersWithFilters.mockClear();
    mocks.fetchMembers.mockClear();
  });

  it("loads the default page once despite the filter control's initial callback", async () => {
    render(<StrictMode><AdminFilterHarness /></StrictMode>);

    await waitFor(() => expect(mocks.fetchUsersWithFilters).toHaveBeenCalledOnce());
    expect(mocks.fetchUsersWithFilters).toHaveBeenCalledWith({
      q: undefined,
      role: undefined,
      gender: undefined,
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: "Sort & Filter" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort By" }), {
      target: { value: "gender" },
    });
    await waitFor(() => expect(mocks.fetchUsersWithFilters).toHaveBeenCalledTimes(2));
    expect(mocks.fetchUsersWithFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "gender", page: 1 }),
    );
  });
});
