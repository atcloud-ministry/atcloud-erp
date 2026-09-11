import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import {
  EmploymentFields,
  ResidenceFields,
} from "../../components/forms/RegistrationProfileFields";
import type { RegistrationProfileFormValues } from "../../schemas/common/registrationProfileSchema";

function InteractionHarness() {
  const {
    register,
    formState: { errors },
    setValue,
    watch,
  } = useForm<RegistrationProfileFormValues>({
    defaultValues: {
      phoneCountryCode: "US",
      phone: "4155552671",
      birthYear: 1990,
      residenceCountryCode: "US",
      residenceRegion: "US-CA",
      residenceCity: "San Francisco",
      employmentStatus: "employed",
      company: "Example Co",
      occupation: "Engineer",
    },
  });

  return (
    <>
      <ResidenceFields
        register={register}
        errors={errors}
        watch={watch}
        setValue={setValue}
      />
      <EmploymentFields
        register={register}
        errors={errors}
        watch={watch}
        setValue={setValue}
      />
      <output data-testid="region-value">{watch("residenceRegion")}</output>
      <output data-testid="company-value">{watch("company")}</output>
    </>
  );
}

describe("RegistrationProfileFields interactions", () => {
  it("clears a stale region when country changes", async () => {
    render(<InteractionHarness />);

    expect(screen.getByTestId("region-value")).toHaveTextContent("US-CA");
    fireEvent.change(screen.getByLabelText(/Country of Residence/i), {
      target: { value: "CA" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("region-value")).toBeEmptyDOMElement(),
    );
  });

  it("hides and clears company when employment no longer requires it", async () => {
    render(<InteractionHarness />);

    expect(screen.getByLabelText(/Company or Organization/i)).toHaveValue(
      "Example Co",
    );
    fireEvent.change(screen.getByLabelText(/Employment Status/i), {
      target: { value: "retired" },
    });

    await waitFor(() => {
      expect(
        screen.queryByLabelText(/Company or Organization/i),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("company-value")).toBeEmptyDOMElement();
    });
  });
});
