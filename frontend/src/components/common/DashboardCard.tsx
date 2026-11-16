import type { ReactNode } from "react";

interface DashboardCardProps {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}

export default function DashboardCard({
  title,
  icon,
  children,
}: DashboardCardProps) {
  return (
    <div className="h-full rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-500 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-current">
          {icon}
        </span>
      </div>
      {children}
    </div>
  );
}
