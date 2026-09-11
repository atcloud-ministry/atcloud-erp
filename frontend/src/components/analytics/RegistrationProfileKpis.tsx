import {
  ISO_COUNTRY_OPTIONS,
  ISO_SUBDIVISION_OPTIONS,
} from "@atcloud/shared-time/registration-profile-options";
import type { RegistrationProfileKpis as RegistrationProfileKpisDTO } from "../../services/api/analytics.api";
import { EMPLOYMENT_STATUS_OPTIONS } from "../../utils/registrationProfile";

type DisplayBucket = {
  key: string;
  label: string;
  count: number;
};

const countryLabels = new Map(
  ISO_COUNTRY_OPTIONS.map(({ code, name }) => [code, name]),
);
const regionLabels = new Map(
  ISO_SUBDIVISION_OPTIONS.map(({ code, name }) => [code, name]),
);
const employmentStatusLabels = new Map(
  EMPLOYMENT_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);

function countryLabel(countryCode: string): string {
  return countryLabels.get(countryCode) ?? countryCode;
}

function regionLabel(regionCode: string): string {
  return regionLabels.get(regionCode) ?? regionCode;
}

function sortedBuckets(buckets: DisplayBucket[]): DisplayBucket[] {
  return [...buckets].sort(
    (left, right) =>
      right.count - left.count || left.label.localeCompare(right.label),
  );
}

function KpiCard({
  title,
  buckets,
}: {
  title: string;
  buckets: DisplayBucket[];
}) {
  const displayBuckets = sortedBuckets(buckets);

  return (
    <section className="rounded-lg border bg-white p-5">
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      {displayBuckets.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">
          No groups meet the privacy threshold.
        </p>
      ) : (
        <div
          aria-label={`${title} groups`}
          className="mt-3 max-h-72 overflow-y-auto rounded-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          role="region"
          tabIndex={0}
        >
          <ul className="space-y-2">
            {displayBuckets.map((bucket) => (
              <li
                key={bucket.key}
                className="flex items-start justify-between gap-4 text-sm"
              >
                <span className="min-w-0 break-words text-gray-600">
                  {bucket.label}
                </span>
                <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-800">
                  {bucket.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function RegistrationProfileKpis({
  analytics,
}: {
  analytics: RegistrationProfileKpisDTO;
}) {
  const suppressionApplied = [
    analytics.birthYearDecades,
    analytics.residenceCountries,
    analytics.residenceRegions,
    analytics.residenceCities,
    analytics.employmentStatuses,
    analytics.companies,
    analytics.occupations,
  ].some((distribution) => distribution.suppressionApplied);

  return (
    <section
      aria-labelledby="registration-profile-kpis-title"
      className="space-y-4"
      data-testid="registration-profile-kpis"
    >
      <div>
        <h2
          id="registration-profile-kpis-title"
          className="text-lg font-semibold text-gray-900"
        >
          Registration Profile KPIs
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Only groups with {analytics.minimumGroupSize} or more people are
          shown.
          {suppressionApplied ? " Smaller groups have been hidden." : ""}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          title="Birth-year Decades"
          buckets={analytics.birthYearDecades.buckets.map((bucket) => ({
            key: String(bucket.startYear),
            label: `${bucket.startYear}\u2013${bucket.endYear}`,
            count: bucket.count,
          }))}
        />
        <KpiCard
          title="Residence Countries"
          buckets={analytics.residenceCountries.buckets.map((bucket) => ({
            key: bucket.countryCode,
            label: countryLabel(bucket.countryCode),
            count: bucket.count,
          }))}
        />
        <KpiCard
          title="Residence Regions"
          buckets={analytics.residenceRegions.buckets.map((bucket) => ({
            key: bucket.regionCode,
            label: `${regionLabel(bucket.regionCode)}, ${countryLabel(
              bucket.countryCode,
            )}`,
            count: bucket.count,
          }))}
        />
        <KpiCard
          title="Residence Cities"
          buckets={analytics.residenceCities.buckets.map((bucket) => ({
            key: `${bucket.countryCode}:${bucket.regionCode ?? ""}:${bucket.city}`,
            label: [
              bucket.city,
              bucket.regionCode ? regionLabel(bucket.regionCode) : null,
              countryLabel(bucket.countryCode),
            ]
              .filter(Boolean)
              .join(", "),
            count: bucket.count,
          }))}
        />
        <KpiCard
          title="Employment Status"
          buckets={analytics.employmentStatuses.buckets.map((bucket) => ({
            key: bucket.employmentStatus,
            label:
              employmentStatusLabels.get(bucket.employmentStatus) ??
              bucket.employmentStatus,
            count: bucket.count,
          }))}
        />
        <KpiCard
          title="Companies"
          buckets={analytics.companies.buckets.map((bucket) => ({
            key: bucket.company,
            label: bucket.company,
            count: bucket.count,
          }))}
        />
        <KpiCard
          title="Occupations"
          buckets={analytics.occupations.buckets.map((bucket) => ({
            key: bucket.occupation,
            label: bucket.occupation,
            count: bucket.count,
          }))}
        />
      </div>
    </section>
  );
}
