import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RegistrationProfileKpis } from "../../components/analytics/RegistrationProfileKpis";
import { createRegistrationProfileKpis } from "../fixtures/registrationProfileKpis";

describe("RegistrationProfileKpis", () => {
  it("renders only aggregate buckets with friendly labels", () => {
    const analytics = createRegistrationProfileKpis();
    Object.assign(analytics, {
      phone: "+12065550123",
      birthYear: 1987,
    });

    render(<RegistrationProfileKpis analytics={analytics} />);

    expect(
      screen.getByRole("heading", { name: "Registration Profile KPIs" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1980–1989")).toBeInTheDocument();
    expect(screen.getByText("United States of America")).toBeInTheDocument();
    expect(
      screen.getByText("Washington, United States of America"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Seattle, Washington, United States of America"),
    ).toBeInTheDocument();
    expect(screen.getByText("Self-employed")).toBeInTheDocument();
    expect(screen.getByText("Contoso")).toBeInTheDocument();
    expect(screen.getByText("Software Engineer")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only groups with 5 or more people are shown. Smaller groups have been hidden.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("+12065550123")).not.toBeInTheDocument();
    expect(screen.queryByText("1987")).not.toBeInTheDocument();
  });

  it("shows a privacy-threshold empty state without suppressed counts", () => {
    const analytics = createRegistrationProfileKpis();
    for (const distribution of [
      analytics.birthYearDecades,
      analytics.residenceCountries,
      analytics.residenceRegions,
      analytics.residenceCities,
      analytics.employmentStatuses,
      analytics.companies,
      analytics.occupations,
    ]) {
      distribution.buckets = [];
      distribution.suppressionApplied = true;
    }

    render(<RegistrationProfileKpis analytics={analytics} />);

    expect(
      screen.getAllByText("No groups meet the privacy threshold."),
    ).toHaveLength(7);
    expect(screen.queryByText(/suppressed people/i)).not.toBeInTheDocument();
  });
});
