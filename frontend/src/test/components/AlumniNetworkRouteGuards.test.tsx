import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlumniNetworkReadableRoute,
  LegacyManagementEntry,
  UserManagementAccessRoute,
} from "../../components/common/AlumniNetworkRouteGuards";

const state = vi.hoisted(() => ({
  status: "ready" as "loading" | "ready" | "error",
  readable: false,
  canManageUsers: false,
}));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: state.status,
    config: {
      alumniNetwork: {
        mode: state.readable ? "read_only" : "off",
        readable: state.readable,
        writable: false,
      },
    },
  }),
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ canManageUsers: state.canManageUsers }),
}));

vi.mock("../../components/common/LoadingSpinner", () => ({
  default: () => <div>Runtime configuration loading</div>,
}));

describe("Alumni Network route guards", () => {
  beforeEach(() => {
    state.status = "ready";
    state.readable = false;
    state.canManageUsers = false;
  });

  it.each(["loading", "error"] as const)(
    "keeps the legacy Management page while runtime status is %s",
    (status) => {
      state.status = status;

      render(
        <MemoryRouter initialEntries={["/dashboard/management"]}>
          <Routes>
            <Route
              path="/dashboard/management"
              element={
                <LegacyManagementEntry>
                  <div>Legacy Management</div>
                </LegacyManagementEntry>
              }
            />
          </Routes>
        </MemoryRouter>,
      );

      expect(screen.getByText("Legacy Management")).toBeInTheDocument();
    },
  );

  it("keeps the legacy Management page when Alumni Network is off", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/management"]}>
        <Routes>
          <Route
            path="/dashboard/management"
            element={
              <LegacyManagementEntry>
                <div>Legacy Management</div>
              </LegacyManagementEntry>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Legacy Management")).toBeInTheDocument();
  });

  it("redirects a member from legacy Management to Members", () => {
    state.readable = true;

    render(
      <MemoryRouter initialEntries={["/dashboard/management"]}>
        <Routes>
          <Route
            path="/dashboard/management"
            element={
              <LegacyManagementEntry>
                <div>Legacy Management</div>
              </LegacyManagementEntry>
            }
          />
          <Route
            path="/dashboard/community/members"
            element={<div>Community Members</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Community Members")).toBeInTheDocument();
    expect(screen.queryByText("Legacy Management")).not.toBeInTheDocument();
  });

  it("redirects an account manager from legacy Management to User Management", () => {
    state.readable = true;
    state.canManageUsers = true;

    render(
      <MemoryRouter initialEntries={["/dashboard/management"]}>
        <Routes>
          <Route
            path="/dashboard/management"
            element={
              <LegacyManagementEntry>
                <div>Legacy Management</div>
              </LegacyManagementEntry>
            }
          />
          <Route
            path="/dashboard/admin/users"
            element={<div>User Management</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("User Management")).toBeInTheDocument();
  });

  it("waits for runtime configuration before entering a new route", () => {
    state.status = "loading";

    render(
      <MemoryRouter>
        <AlumniNetworkReadableRoute>
          <div>New Community</div>
        </AlumniNetworkReadableRoute>
      </MemoryRouter>,
    );

    expect(screen.getByText("Runtime configuration loading")).toBeInTheDocument();
    expect(screen.queryByText("New Community")).not.toBeInTheDocument();
  });

  it("returns a new route to legacy Management when reads are disabled", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/community"]}>
        <Routes>
          <Route
            path="/dashboard/community"
            element={
              <AlumniNetworkReadableRoute>
                <div>New Community</div>
              </AlumniNetworkReadableRoute>
            }
          />
          <Route
            path="/dashboard/management"
            element={<div>Legacy Management</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Legacy Management")).toBeInTheDocument();
  });

  it("renders a new Community route when Alumni Network reads are enabled", () => {
    state.readable = true;

    render(
      <MemoryRouter>
        <AlumniNetworkReadableRoute>
          <div>New Community</div>
        </AlumniNetworkReadableRoute>
      </MemoryRouter>,
    );

    expect(screen.getByText("New Community")).toBeInTheDocument();
  });

  it("denies User Management without the existing permission", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/admin/users"]}>
        <Routes>
          <Route
            path="/dashboard/admin/users"
            element={
              <UserManagementAccessRoute>
                <div>Private User Data</div>
              </UserManagementAccessRoute>
            }
          />
          <Route
            path="/dashboard/community/members"
            element={<div>Community Members</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Community Members")).toBeInTheDocument();
    expect(screen.queryByText("Private User Data")).not.toBeInTheDocument();
  });

  it("renders User Management with the existing permission", () => {
    state.canManageUsers = true;

    render(
      <MemoryRouter>
        <UserManagementAccessRoute>
          <div>Private User Data</div>
        </UserManagementAccessRoute>
      </MemoryRouter>,
    );

    expect(screen.getByText("Private User Data")).toBeInTheDocument();
  });
});
