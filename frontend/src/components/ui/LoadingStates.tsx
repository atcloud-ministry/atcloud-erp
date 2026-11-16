import { getLoadingSkeletonClass, getCardClass } from "../../utils/uiUtils";

interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function LoadingSpinner({
  size = "md",
  className = "",
}: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
  };

  return (
    <svg
      className={`animate-spin ${sizeClasses[size]} ${className}`}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

interface StatsLoadingProps {
  count?: number;
}

export function StatsLoadingState({ count = 4 }: StatsLoadingProps) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex justify-between items-center">
          <div className={`${getLoadingSkeletonClass("text")} w-28 h-4`}></div>
          <div className={`${getLoadingSkeletonClass("text")} w-12 h-5`}></div>
        </div>
      ))}
    </div>
  );
}

export function EventStatsLoadingState() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
      {Array.from({ length: 3 }, (_, i) => (
        <div
          key={i}
          className={`${getCardClass(false, "medium")} animate-pulse`}
        >
          <div className="h-16 bg-gray-200 rounded"></div>
        </div>
      ))}
    </div>
  );
}

// New: Analytics Overview Cards skeleton (4 colored cards with label + number)
export function AnalyticsOverviewLoadingState() {
  const cardColors = [
    "bg-blue-50 border-blue-100",
    "bg-green-50 border-green-100",
    "bg-purple-50 border-purple-100",
    "bg-orange-50 border-orange-100",
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
      {cardColors.map((colorClass, i) => (
        <div key={i} className={`${colorClass} rounded-lg p-6 animate-pulse`}>
          <div
            className={`${getLoadingSkeletonClass("text")} w-20 h-4 mb-2`}
          ></div>
          <div className={`${getLoadingSkeletonClass("text")} w-12 h-8`}></div>
        </div>
      ))}
    </div>
  );
}

// New: Management Statistics Cards skeleton (7 cards in responsive grid)
export function ManagementStatsLoadingState() {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-gray-200/80 bg-gray-200/70 shadow-sm sm:grid-cols-4">
      {Array.from({ length: 7 }).map((_, i) => (
        <div
          key={i}
          className={`animate-pulse bg-white px-5 py-4 ${
            i === 0 ? "col-span-2 sm:col-span-1 sm:row-span-2" : ""
          }`}
        >
          <div
            className={`${getLoadingSkeletonClass("text")} mb-2 h-4 w-20`}
          ></div>
          <div className={`${getLoadingSkeletonClass("text")} h-7 w-8`}></div>
        </div>
      ))}
    </div>
  );
}

// New: Analytics card section skeleton (for event stats, distributions, etc.)
export function AnalyticsCardSectionLoadingState({
  cardCount = 2,
  itemCount = 5,
}: {
  cardCount?: number;
  itemCount?: number;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
      {Array.from({ length: cardCount }).map((_, i) => (
        <div key={i} className="bg-white border rounded-lg p-6 animate-pulse">
          <div
            className={`${getLoadingSkeletonClass("text")} w-40 h-5 mb-4`}
          ></div>
          <div className="space-y-4">
            {Array.from({ length: itemCount }).map((_, j) => (
              <div key={j} className="flex justify-between items-center">
                <div
                  className={`${getLoadingSkeletonClass("text")} w-24 h-4`}
                ></div>
                <div
                  className={`${getLoadingSkeletonClass("text")} w-16 h-4`}
                ></div>
              </div>
            ))}
            {/* Progress bar skeleton for some cards */}
            {i === 0 && (
              <div className="mt-4">
                <div
                  className={`${getLoadingSkeletonClass(
                    "text"
                  )} w-full h-2 rounded-full`}
                ></div>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface TableLoadingProps {
  rows?: number;
  columns?: number;
}

export function TableLoadingState({
  rows = 5,
  columns = 4,
}: TableLoadingProps) {
  return (
    <div className="animate-pulse">
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div key={rowIndex} className="grid grid-cols-4 gap-4">
            {Array.from({ length: columns }, (_, colIndex) => (
              <div
                key={colIndex}
                className={`${getLoadingSkeletonClass("text")} h-4`}
              ></div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface PageLoadingProps {
  message?: string;
}

export function PageLoadingState({ message = "Loading..." }: PageLoadingProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <LoadingSpinner size="lg" className="mb-4" />
      <p className="text-gray-600">{message}</p>
    </div>
  );
}

interface CenterLoadingProps {
  size?: "sm" | "md" | "lg";
  message?: string;
}

export function CenterLoadingState({
  size = "md",
  message,
}: CenterLoadingProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <LoadingSpinner size={size} />
      {message && <p className="text-gray-600 mt-2">{message}</p>}
    </div>
  );
}
