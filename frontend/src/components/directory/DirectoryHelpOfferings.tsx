import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { DirectoryHelpOfferingsDTO } from "../../services/api";

export const DIRECTORY_OFFERING_LABELS = [
  { key: "careerAdvice", label: "Career Advice" },
  { key: "warmIntroduction", label: "Warm Introduction" },
  { key: "formalEmployeeReferral", label: "Formal Employee Referral" },
] as const satisfies readonly {
  key: keyof DirectoryHelpOfferingsDTO;
  label: string;
}[];

export default function DirectoryHelpOfferings({
  offerings,
}: {
  offerings: DirectoryHelpOfferingsDTO;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900">Willing to help</h3>
      <ul aria-label="Help offerings" className="mt-2 space-y-1.5">
        {DIRECTORY_OFFERING_LABELS.map(({ key, label }) => {
          const available = offerings[key];
          return (
            <li className="flex items-start gap-2 text-sm" key={key}>
              {available ? (
                <CheckIcon
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-green-600"
                />
              ) : (
                <XMarkIcon
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
                />
              )}
              <span className={available ? "text-gray-800" : "text-gray-500"}>
                <span className="sr-only">
                  {available ? "Available: " : "Not available: "}
                </span>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
