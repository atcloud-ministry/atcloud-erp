import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useEffect, useState, type FormEvent } from "react";
import type { DirectoryOffering } from "../../services/api";
import { Button } from "../ui";

export interface DirectoryFiltersValue {
  q: string;
  company: string;
  industry: string;
  skill: string;
  location: string;
  cohort: string;
  offering: DirectoryOffering | "";
}

export const EMPTY_DIRECTORY_FILTERS: DirectoryFiltersValue = Object.freeze({
  q: "",
  company: "",
  industry: "",
  skill: "",
  location: "",
  cohort: "",
  offering: "",
});

const TEXT_FILTERS = [
  { key: "company", label: "Company", placeholder: "e.g. Microsoft" },
  { key: "industry", label: "Industry", placeholder: "e.g. Technology" },
  { key: "skill", label: "Skill", placeholder: "e.g. Product strategy" },
  { key: "location", label: "General location", placeholder: "e.g. Seattle" },
  { key: "cohort", label: "Cohort", placeholder: "e.g. EMBA 2022" },
] as const;

function normalizedFilters(value: DirectoryFiltersValue): DirectoryFiltersValue {
  return {
    q: value.q.trim(),
    company: value.company.trim(),
    industry: value.industry.trim(),
    skill: value.skill.trim(),
    location: value.location.trim(),
    cohort: value.cohort.trim(),
    offering: value.offering,
  };
}

export default function AlumniDirectoryFilters({
  value,
  loading,
  onApply,
}: {
  value: DirectoryFiltersValue;
  loading: boolean;
  onApply: (value: DirectoryFiltersValue) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const update = <K extends keyof DirectoryFiltersValue>(
    key: K,
    nextValue: DirectoryFiltersValue[K],
  ) => setDraft((current) => ({ ...current, [key]: nextValue }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizedFilters(draft);
    setDraft(normalized);
    onApply(normalized);
  };

  const reset = () => {
    setDraft(EMPTY_DIRECTORY_FILTERS);
    onApply(EMPTY_DIRECTORY_FILTERS);
  };

  const hasValue =
    Object.values(draft).some((entry) => entry !== "") ||
    Object.values(value).some((entry) => entry !== "");

  return (
    <form
      aria-label="Search and filter alumni"
      className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
      onSubmit={submit}
    >
      <div>
        <label className="block text-sm font-medium text-gray-800" htmlFor="directory-search">
          Search alumni
        </label>
        <div className="relative mt-1.5">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
          />
          <input
            className="block min-h-11 w-full rounded-md border border-gray-300 py-2 pl-10 pr-3 text-base placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm"
            disabled={loading}
            id="directory-search"
            maxLength={100}
            onChange={(event) => update("q", event.target.value)}
            placeholder="Name, company, industry, skill, location, or cohort"
            type="search"
            value={draft.q}
          />
        </div>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold text-gray-900">Filters</legend>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {TEXT_FILTERS.map(({ key, label, placeholder }) => (
            <label className="block min-w-0" key={key}>
              <span className="text-sm font-medium text-gray-700">{label}</span>
              <input
                className="mt-1 block min-h-11 w-full rounded-md border border-gray-300 px-3 py-2 text-base placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm"
                disabled={loading}
                maxLength={100}
                onChange={(event) => update(key, event.target.value)}
                placeholder={placeholder}
                type="text"
                value={draft[key]}
              />
            </label>
          ))}
          <label className="block min-w-0">
            <span className="text-sm font-medium text-gray-700">Help offering</span>
            <select
              className="mt-1 block min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm"
              disabled={loading}
              onChange={(event) =>
                update(
                  "offering",
                  event.target.value as DirectoryFiltersValue["offering"],
                )
              }
              value={draft.offering}
            >
              <option value="">Any offering</option>
              <option value="career_advice">Career Advice</option>
              <option value="warm_introduction">Warm Introduction</option>
              <option value="formal_employee_referral">
                Formal Employee Referral
              </option>
            </select>
          </label>
        </div>
      </fieldset>

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          className="min-h-11 w-full sm:w-auto"
          disabled={loading || !hasValue}
          onClick={reset}
          type="button"
          variant="secondary"
        >
          Reset
        </Button>
        <Button
          className="min-h-11 w-full sm:w-auto"
          disabled={loading}
          type="submit"
        >
          Apply
        </Button>
      </div>
    </form>
  );
}

export { normalizedFilters };
