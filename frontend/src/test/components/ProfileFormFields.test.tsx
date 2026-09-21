import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useForm } from "react-hook-form";
import ProfileFormFields from "../../components/profile/ProfileFormFields";
import type { ProfileFormData } from "../../schemas/profileSchema";

function IncompleteProfileHarness() {
  const form = useForm<ProfileFormData>({
    defaultValues: {
      username: "legacy-user",
      firstName: "Legacy",
      lastName: "User",
      email: "legacy@example.com",
      gender: "female",
      phoneCountryCode: "",
      phone: "",
      birthYear: "",
      residenceCountryCode: "",
      residenceRegion: "",
      residenceCity: "",
      employmentStatus: "",
      company: "Legacy Company",
      occupation: "",
      isAtCloudLeader: "No",
      roleInAtCloud: "",
      weeklyChurch: "",
      churchAddress: "",
    } as unknown as ProfileFormData,
  });

  return <ProfileFormFields form={form} isEditing />;
}

describe("ProfileFormFields", () => {
  it("lets an incomplete existing user select employed without losing a legacy company", async () => {
    render(<IncompleteProfileHarness />);

    expect(screen.queryByText(/^home address$/i)).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("combobox", { name: /employment status/i }),
      { target: { value: "employed" } },
    );

    expect(
      await screen.findByRole("textbox", {
        name: /company or organization/i,
      }),
    ).toHaveValue("Legacy Company");
  });
});
