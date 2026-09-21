import Pagination from "../common/Pagination";

interface UserPaginationProps {
  currentPage: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  busy?: boolean;
  onPageChange: (page: number) => void;
}

export default function UserPagination({
  currentPage,
  totalPages,
  hasNext,
  hasPrev,
  busy = false,
  onPageChange,
}: UserPaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="mt-4">
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        hasNext={hasNext}
        hasPrev={hasPrev}
        busy={busy}
        onPageChange={onPageChange}
        showPageNumbers={totalPages <= 10}
        size="md"
      />
    </div>
  );
}
