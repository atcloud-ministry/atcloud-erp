import {
  AdjustmentsHorizontalIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useState, type FormEvent } from "react";
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

  const activeFilterCount = TEXT_FILTERS.filter(
    ({ key }) => value[key] !== "",
  ).length + (value.offering ? 1 : 0);
  const [filtersOpen, setFiltersOpen] = useState(activeFilterCount > 0);
  const panelId = useId();

  return (
    <form
      aria-label="Search and filter alumni"
      className="rounded-2xl border border-gray-200/80 bg-white p-3 shadow-sm"
      onSubmit={submit}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="directory-search">
          Search alumni
        </label>
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
          />
          <input
            className="block min-h-11 w-full rounded-xl border border-gray-200 bg-gray-50/60 py-2 pl-10 pr-3 text-base placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 sm:text-sm"
            disabled={loading}
            id="directory-search"
            maxLength={100}
            onChange={(event) => update("q", event.target.value)}
            placeholder="Name, company, industry, skill, location, or cohort"
            type="search"
            value={draft.q}
          />
        </div>
        <div className="flex gap-2">
          <button
            aria-controls={panelId}
            aria-expanded={filtersOpen}
            className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:flex-none ${
              filtersOpen
                ? "border-brand-200 bg-brand-50 text-brand-800"
                : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            }`}
            onClick={() => setFiltersOpen((open) => !open)}
            type="button"
          >
            <AdjustmentsHorizontalIcon aria-hidden="true" className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold leading-5 text-white tabular-nums">
                {activeFilterCount}
              </span>
            )}
          </button>
          <Button
            className="min-h-11 w-full flex-1 rounded-xl sm:w-auto sm:flex-none"
            disabled={loading}
            type="submit"
          >
            Apply
          </Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {filtersOpen && (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            className="overflow-hidden"
            exit={{ height: 0, opacity: 0 }}
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <fieldset className="mt-3 border-t border-gray-100 px-1 pt-4">
              <legend className="sr-only">Filters</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {TEXT_FILTERS.map(({ key, label, placeholder }) => (
                  <label className="block min-w-0" key={key}>
                    <span className="text-sm font-medium text-gray-700">{label}</span>
                    <input
                      className="mt-1 block min-h-11 w-full rounded-xl border border-gray-200 px-3 py-2 text-base placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:text-sm"
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
                    className="mt-1 block min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-base focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:text-sm"
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
              <div className="mt-3 flex justify-end">
                <button
                  className="min-h-9 rounded-lg px-3 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  disabled={loading || !hasValue}
                  onClick={reset}
                  type="button"
                >
                  Reset
                </button>
              </div>
            </fieldset>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

export { normalizedFilters };
