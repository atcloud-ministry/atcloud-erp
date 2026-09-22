import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Profile from "../../pages/Profile";
import { AuthProvider } from "../../contexts/AuthContext";
import { NotificationProvider } from "../../contexts/NotificationModalContext";
import { fileService } from "../../services/api";

vi.mock("../../services/api", () => {
  const mockGetProfile = vi.fn(async () => ({
    id: "user-1",
    username: "testuser",
    firstName: "Test",
    lastName: "User",
    email: "test@example.com",
    phone: "+12065550123",
    birthYear: 1990,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "AtCloud Test",
    occupation: "Tester",
    role: "Participant",
    isAtCloudLeader: false,
    roleInAtCloud: "",
    gender: "male",
    avatar: null,
  }));

  const mockUpdateProfile = vi.fn(async (updates: any) => ({
    id: "user-1",
    username: updates.username || "testuser",
    firstName: updates.firstName || "Test",
    lastName: updates.lastName || "User",
    email: updates.email || "test@example.com",
    phone: updates.phone || "+12065550123",
    birthYear: updates.birthYear ?? 1990,
    residenceCity: updates.residenceCity || "Seattle",
    residenceRegion: updates.residenceRegion ?? "US-WA",
    residenceCountryCode: updates.residenceCountryCode || "US",
    employmentStatus: updates.employmentStatus || "employed",
    company: updates.company ?? "AtCloud Test",
    occupation: updates.occupation ?? "Tester",
    role: "Participant",
    isAtCloudLeader: updates.isAtCloudLeader ?? false,
    roleInAtCloud: updates.roleInAtCloud || "",
    gender: updates.gender || "male",
    avatar: null,
  }));

  const mockUploadAvatar = vi.fn(async (_file: File) => ({
    avatarUrl: "https://cdn.example.com/avatars/user-1.png",
  }));

  return {
    authService: { getProfile: mockGetProfile },
    userService: { updateProfile: mockUpdateProfile },
    fileService: { uploadAvatar: mockUploadAvatar },
  };
});

function renderProfile() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/profile"]}>
      <NotificationProvider>
        <AuthProvider>
          <Profile />
        </AuthProvider>
      </NotificationProvider>
    </MemoryRouter>
  );
}

describe("Profile avatar protections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("authToken", "test-token");

    // Mock FileReader to immediately trigger onloadend with a data URL
    class MockFileReader {
      public result: string | ArrayBuffer | null = null;
      public onloadend: null | (() => void) = null;
      readAsDataURL(_file: Blob) {
        this.result = "data:image/png;base64,AAAA";
        // trigger immediately so tests don't race against timers
        if (this.onloadend) this.onloadend();
      }
    }
    // Polyfill FileReader in jsdom test environment without ts-ignore
    interface FileReaderCtor {
      new (): FileReader;
    }
    (globalThis as unknown as { FileReader: FileReaderCtor }).FileReader =
      MockFileReader as unknown as FileReaderCtor;
  });

  it("rejects files larger than 10MB with an error notification", async () => {
    renderProfile();
    await screen.findByText(/my profile/i);

    fireEvent.click(
      await screen.findByRole("button", { name: /edit profile/i })
    );

    // Find hidden file input by label text on the camera icon label
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const bigFile = new File(
      [new Uint8Array(10 * 1024 * 1024 + 1)],
      "big.png",
      {
        type: "image/png",
      }
    );

    // Fire change event
    await waitFor(() => {
      fireEvent.change(fileInput, { target: { files: [bigFile] } });
    });

    // Error modal should open with our title/message
    await screen.findByText(/file too large/i);
    await screen.findByText(/maximum size is 10mb/i);

    // Upload not attempted
    expect(fileService.uploadAvatar as any).not.toHaveBeenCalled();
  });

  it("rejects invalid MIME types with an error notification", async () => {
    renderProfile();
    await screen.findByText(/my profile/i);
    fireEvent.click(
      await screen.findByRole("button", { name: /edit profile/i })
    );

    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const badFile = new File([new Uint8Array(100)], "bad.txt", {
      type: "text/plain",
    });

    await waitFor(() => {
      fireEvent.change(fileInput, { target: { files: [badFile] } });
    });

    await screen.findByText(/invalid file type/i);
    expect(fileService.uploadAvatar as any).not.toHaveBeenCalled();
  });

  it("accepts a valid image, shows success notice, and calls upload on save", async () => {
    renderProfile();
    await screen.findByText(/my profile/i);
    fireEvent.click(
      await screen.findByRole("button", { name: /edit profile/i })
    );

    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const okFile = new File([new Uint8Array(1024)], "ok.png", {
      type: "image/png",
    });

    await waitFor(() => {
      fireEvent.change(fileInput, { target: { files: [okFile] } });
    });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(fileService.uploadAvatar as any).toHaveBeenCalledTimes(1);
    });

    // Final success notification after save
    await screen.findByText(/profile saved/i);
  });
});
