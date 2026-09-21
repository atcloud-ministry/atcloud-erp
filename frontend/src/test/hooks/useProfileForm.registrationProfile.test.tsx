import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileForm } from "../../hooks/useProfileForm";

const mocks = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  updateUser: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  currentUser: {
    id: "legacy-user",
    username: "legacy",
    firstName: "Legacy",
    lastName: "User",
    email: "legacy@example.com",
    gender: "female",
    role: "Participant",
    isAtCloudLeader: "No",
    phone: "+14155552671",
    birthYear: 1985,
    residenceCountryCode: "US",
    residenceRegion: "US-WA",
    residenceCity: "Seattle",
    employmentStatus: "employed",
    company: "Legacy Company",
    occupation: "Engineer",
    homeAddress: "legacy private street address",
  } as Record<string, unknown>,
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: mocks.currentUser,
    updateUser: mocks.updateUser,
  }),
}));

vi.mock("../../services/api", () => ({
  userService: { updateProfile: mocks.updateProfile },
  fileService: { uploadAvatar: vi.fn() },
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: mocks.success,
    error: mocks.error,
  }),
}));

describe("useProfileForm registration profile submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.currentUser, {
      id: "legacy-user",
      username: "legacy",
      firstName: "Legacy",
      lastName: "User",
      email: "legacy@example.com",
      gender: "female",
      role: "Participant",
      isAtCloudLeader: "No",
      phone: "+14155552671",
      birthYear: 1985,
      residenceCountryCode: "US",
      residenceRegion: "US-WA",
      residenceCity: "Seattle",
      employmentStatus: "employed",
      company: "Legacy Company",
      occupation: "Engineer",
      homeAddress: "legacy private street address",
    });
    mocks.updateProfile.mockImplementation(async (payload) => ({
      id: "legacy-user",
      role: "Participant",
      avatar: null,
      ...payload,
    }));
  });

  it("submits canonical fields without the form-only country or legacy homeAddress", async () => {
    const { result } = renderHook(() => useProfileForm());

    await waitFor(() => {
      expect(result.current.form.getValues("company")).toBe("Legacy Company");
    });

    act(() => {
      result.current.form.setValue("phone", "415 555 2674");
    });
    await act(async () => {
      await result.current.onSubmit();
    });

    await waitFor(() => {
      expect(mocks.updateProfile).toHaveBeenCalledTimes(1);
    });
    const submitted = mocks.updateProfile.mock.calls[0][0];
    expect(submitted).toMatchObject({
      phone: "+14155552674",
      birthYear: 1985,
      residenceCountryCode: "US",
      residenceRegion: "US-WA",
      residenceCity: "Seattle",
      employmentStatus: "employed",
      company: "Legacy Company",
      occupation: "Engineer",
    });
    expect(submitted).not.toHaveProperty("phoneCountryCode");
    expect(submitted).not.toHaveProperty("homeAddress");
    expect(mocks.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+14155552674",
        homeAddress: undefined,
      }),
    );
  });

  it("allows an incomplete legacy user to save unrelated fields without submitting the eight fields", async () => {
    Object.assign(mocks.currentUser, {
      birthYear: undefined,
      residenceCountryCode: undefined,
      residenceRegion: undefined,
      residenceCity: undefined,
      employmentStatus: undefined,
      occupation: undefined,
    });
    const { result } = renderHook(() => useProfileForm());

    act(() => {
      result.current.form.setValue("weeklyChurch", "Grace Church");
    });
    await act(async () => {
      await result.current.onSubmit();
    });

    await waitFor(() => {
      expect(mocks.updateProfile).toHaveBeenCalledTimes(1);
    });
    const submitted = mocks.updateProfile.mock.calls[0][0];
    expect(submitted).toMatchObject({ weeklyChurch: "Grace Church" });
    for (const field of [
      "phone",
      "birthYear",
      "residenceCity",
      "residenceRegion",
      "residenceCountryCode",
      "employmentStatus",
      "company",
      "occupation",
      "phoneCountryCode",
      "homeAddress",
    ]) {
      expect(submitted).not.toHaveProperty(field);
    }
    expect(mocks.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        homeAddress: "legacy private street address",
      }),
    );
  });
});
