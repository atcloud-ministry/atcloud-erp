import { Link } from "react-router-dom";
import { motion } from "motion/react";

export interface SegmentedNavItem {
  id: string;
  label: string;
  to: string;
}

interface SegmentedNavProps {
  items: readonly SegmentedNavItem[];
  activeId: string;
  label: string;
  /** Distinguishes the sliding highlight when several controls share a page. */
  layoutId: string;
}

/** Link-based filter control; each option is its own URL. */
export default function SegmentedNav({
  items,
  activeId,
  label,
  layoutId,
}: SegmentedNavProps) {
  return (
    <nav aria-label={label} className="overflow-x-auto [scrollbar-width:none]">
      <div className="inline-flex min-w-max gap-0.5 rounded-full bg-gray-200/60 p-1">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`relative inline-flex min-h-9 items-center rounded-full px-3.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                active ? "text-gray-900" : "text-gray-500 hover:text-gray-800"
              }`}
              key={item.id}
              to={item.to}
            >
              {active && (
                <motion.span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-white shadow-sm ring-1 ring-gray-900/5"
                  layoutId={layoutId}
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
