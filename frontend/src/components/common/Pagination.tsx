import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef } from "react";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  onPageChange: (page: number) => void;
  showPageNumbers?: boolean;
  busy?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "default" | "minimal" | "rounded";
  layout?: "center" | "between";
}

export default function Pagination({
  currentPage,
  totalPages,
  hasNext,
  hasPrev,
  onPageChange,
  busy = false,
  size = "md",
  variant = "default",
  layout = "center",
}: PaginationProps) {
  const pageStatusRef = useRef<HTMLDivElement>(null);
  const activatedDirectionRef = useRef<"previous" | "next" | null>(null);

  useEffect(() => {
    if (busy || !activatedDirectionRef.current) return;
    const reachedBoundary =
      (activatedDirectionRef.current === "previous" && !hasPrev) ||
      (activatedDirectionRef.current === "next" && !hasNext);
    activatedDirectionRef.current = null;
    if (reachedBoundary) pageStatusRef.current?.focus();
  }, [busy, currentPage, hasNext, hasPrev]);

  if (totalPages <= 1) return null;

  const sizeClasses = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-3 text-base",
  };

  const baseButtonClasses = {
    default:
      "border border-gray-500 bg-white hover:bg-blue-50 hover:border-blue-600 hover:text-blue-700 disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed disabled:border-gray-200 transition-all duration-200 shadow-sm hover:shadow-md font-medium min-h-11 min-w-11 flex items-center justify-center text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2",
    minimal:
      "bg-transparent hover:bg-blue-50 hover:text-blue-700 disabled:text-gray-300 disabled:cursor-not-allowed transition-all duration-200 font-medium min-h-11 min-w-11 flex items-center justify-center text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2",
    rounded:
      "border border-gray-500 bg-white hover:bg-blue-50 hover:border-blue-600 hover:text-blue-700 disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed disabled:border-gray-200 transition-all duration-200 shadow-sm hover:shadow-md font-medium rounded-full min-h-11 min-w-11 flex items-center justify-center text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2",
  };

  // Generate page numbers to show (now unused since we use simple text format)
  // const getVisiblePages = () => {
  //   if (!showPageNumbers) return [];
  //   const pages = [];
  //   const half = Math.floor(maxVisiblePages / 2);
  //   let start = Math.max(1, currentPage - half);
  //   let end = Math.min(totalPages, start + maxVisiblePages - 1);
  //   if (end - start + 1 < maxVisiblePages) {
  //     start = Math.max(1, end - maxVisiblePages + 1);
  //   }
  //   for (let i = start; i <= end; i++) {
  //     pages.push(i);
  //   }
  //   return pages;
  // };
  // const visiblePages = getVisiblePages();

  const layoutClasses = {
    center: "justify-center",
    left: "justify-start",
    right: "justify-end",
    between: "justify-between",
  };

  return (
    <nav
      aria-label="Pagination"
      className={`flex items-center space-x-2 ${layoutClasses[layout]}`}
    >
      {/* Previous Button */}
      <button
        disabled={!hasPrev}
        onClick={() => {
          if (!hasPrev || busy) return;
          activatedDirectionRef.current = "previous";
          onPageChange(currentPage - 1);
        }}
        className={`
          ${sizeClasses[size]} 
          ${baseButtonClasses[variant]}
          ${
            variant === "default"
              ? "rounded-lg"
              : variant === "rounded"
              ? "rounded-full"
              : "rounded-lg"
          }
          flex items-center space-x-1.5 text-gray-600
        `}
        aria-disabled={!hasPrev || busy}
        aria-label="Previous page"
        type="button"
      >
        <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
        <span className="hidden sm:inline">Prev</span>
      </button>

      {/* Page Numbers */}
      <div
        aria-atomic="true"
        aria-live="polite"
        className="rounded text-sm text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        ref={pageStatusRef}
        tabIndex={-1}
      >
        Page {currentPage} of {totalPages}
        {busy && <span className="sr-only">. Loading page.</span>}
      </div>

      {/* Next Button */}
      <button
        disabled={!hasNext}
        onClick={() => {
          if (!hasNext || busy) return;
          activatedDirectionRef.current = "next";
          onPageChange(currentPage + 1);
        }}
        className={`
          ${sizeClasses[size]} 
          ${baseButtonClasses[variant]}
          ${
            variant === "default"
              ? "rounded-lg"
              : variant === "rounded"
              ? "rounded-full"
              : "rounded-lg"
          }
          flex items-center space-x-1.5 text-gray-600
        `}
        aria-disabled={!hasNext || busy}
        aria-label="Next page"
        type="button"
      >
        <span className="hidden sm:inline">Next</span>
        <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
      </button>
    </nav>
  );
}
