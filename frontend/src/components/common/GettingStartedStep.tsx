import { Link } from "react-router-dom";
import { ArrowRightIcon } from "@heroicons/react/24/outline";

interface GettingStartedStepProps {
  stepNumber: number;
  title: string;
  description: string;
  /** Kept for config compatibility; steps now share the brand color. */
  color: "blue" | "green" | "purple" | "orange";
  to?: string; // optional link target
}

export default function GettingStartedStep({
  stepNumber,
  title,
  description,
  to,
}: GettingStartedStepProps) {
  const content = (
    <div className="flex h-full items-start gap-3.5">
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-brand-200 bg-brand-50 font-display text-sm font-semibold text-brand-700 transition-colors group-hover:border-brand-600 group-hover:bg-brand-600 group-hover:text-white">
        {stepNumber}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="flex items-center gap-1.5 font-medium text-gray-900">
          {title}
          {to && (
            <ArrowRightIcon
              aria-hidden="true"
              className="h-3.5 w-3.5 -translate-x-1 text-gray-400 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
            />
          )}
        </h4>
        <p className="mt-0.5 text-sm leading-relaxed text-gray-600">
          {description}
        </p>
      </div>
    </div>
  );

  return to ? (
    <Link
      to={to}
      className="group -m-3 block rounded-xl p-3 font-normal transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {content}
    </Link>
  ) : (
    content
  );
}
