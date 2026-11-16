import React from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}

export default function PageHeader({
  title,
  subtitle,
  action,
  breadcrumb,
}: PageHeaderProps) {
  return (
    <div className="pb-1 pt-1">
      {breadcrumb && <div className="mb-3">{breadcrumb}</div>}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-gray-900">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 max-w-2xl text-[0.9375rem] text-gray-500">
              {subtitle}
            </p>
          )}
        </div>

        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
    </div>
  );
}
