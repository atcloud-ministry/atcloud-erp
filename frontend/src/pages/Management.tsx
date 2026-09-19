import { useManagement } from "../hooks/useManagement";
import { useEnhancedManagement } from "../hooks/useEnhancedManagement";
import ManagementHeader from "../components/management/ManagementHeader";
import UserTable from "../components/management/UserTable";
import CommunityMemberTable from "../components/management/CommunityMemberTable";
import UserPagination from "../components/management/UserPagination";
import UserSearchAndFilter from "../components/management/UserSearchAndFilter";
import { Card, CardContent } from "../components/ui";
import ConfirmationModal from "../components/common/ConfirmationModal";
import UserDeleteModal from "../components/management/UserDeleteModal";
import type { ManagementDirectoryScope } from "../hooks/useManagementFilters";

interface ManagementProps {
  scope?: ManagementDirectoryScope;
}

export default function Management({ scope }: ManagementProps = {}) {
  // Enhanced management hook provides search/filter functionality
  const {
    users: enhancedUsers,
    communityMembers,
    isAdminView,
    currentUserRole: enhancedCurrentUserRole,
    roleStats: enhancedRoleStats,
    roleStatsLoading: enhancedRoleStatsLoading,
    pagination: enhancedPagination,
    loading: enhancedLoading,
    error: enhancedError,

    // Search and filtering
    onFiltersChange,
    onPageChange: handleEnhancedPageChange,
  } = useEnhancedManagement(scope);

  // Original management hook provides action handling
  // Pass the enhancedUsers so handlers can find users correctly
  const {
    // User actions
    getActionsForUser,

    // Dropdown state
    openDropdown,
    toggleDropdown,

    // Confirmation modal state
    confirmationAction,
    isProcessing,
    handleConfirmAction,
    handleCancelConfirmation,
  } = useManagement(isAdminView ? enhancedUsers : []);

  // Use enhanced data when available, fallback to original
  const users = enhancedUsers;
  const currentUserRole = enhancedCurrentUserRole;
  const roleStats = enhancedRoleStats;
  const roleStatsLoading = enhancedRoleStatsLoading;
  const pagination = enhancedPagination;
  const loading = enhancedLoading;
  const error = enhancedError;
  const canBrowseWithFilters = isAdminView || currentUserRole === "Leader";
  const hasResultSnapshot =
    users.length > 0 ||
    communityMembers.length > 0 ||
    pagination.totalPages > 0 ||
    pagination.totalUsers > 0;

  return (
    <div className="mx-auto max-w-[1280px] space-y-6 px-0 sm:px-4 lg:px-6 xl:max-w-[1360px] 2xl:max-w-[1440px]">
      {/* Header Section with Statistics */}
      <ManagementHeader
        currentUserRole={currentUserRole}
        roleStats={roleStats}
        loadingStats={roleStatsLoading}
        scope={scope}
      />

      {canBrowseWithFilters && (
        <UserSearchAndFilter
          onFiltersChange={onFiltersChange}
          loading={loading}
          totalResults={pagination.totalUsers}
          currentUserRole={currentUserRole}
          mode={isAdminView ? "admin" : "community"}
        />
      )}

      {/* User Management Table */}
      <Card className="overflow-visible" padding="sm">
        <CardContent className="overflow-visible">
          <div aria-busy={loading}>
          {loading && !hasResultSnapshot ? (
            <div aria-live="polite" className="flex justify-center items-center py-8" role="status">
              <div className="text-gray-500">Loading users...</div>
            </div>
          ) : (
            <>
              {error && (
                <div className="flex justify-center items-center py-4" role="alert">
                  <div className="text-red-700">Error loading users: {error}</div>
                </div>
              )}
              {(!error || hasResultSnapshot) && (
                <>
                  {isAdminView ? (
                    <UserTable
                      users={users}
                      getActionsForUser={getActionsForUser}
                      openDropdown={openDropdown}
                      onToggleDropdown={toggleDropdown}
                      currentUserRole={currentUserRole}
                    />
                  ) : (
                    <CommunityMemberTable
                      members={communityMembers}
                      currentUserRole={currentUserRole}
                    />
                  )}
                  <UserPagination
                    currentPage={pagination.currentPage}
                    totalPages={pagination.totalPages}
                    hasNext={pagination.hasNext}
                    hasPrev={pagination.hasPrev}
                    busy={loading}
                    onPageChange={handleEnhancedPageChange}
                  />
                </>
              )}
            </>
          )}
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Modals */}
      {confirmationAction && confirmationAction.type === "delete" && (
        <UserDeleteModal
          isOpen={!!confirmationAction}
          onClose={handleCancelConfirmation}
          onConfirm={handleConfirmAction}
          userName={`${confirmationAction.user.firstName} ${confirmationAction.user.lastName}`}
          title={confirmationAction.title}
          message={confirmationAction.message}
          isLoading={isProcessing}
        />
      )}

      {confirmationAction && confirmationAction.type !== "delete" && (
        <ConfirmationModal
          isOpen={!!confirmationAction}
          onClose={handleCancelConfirmation}
          onConfirm={handleConfirmAction}
          title={confirmationAction.title}
          message={confirmationAction.message}
          confirmText={confirmationAction.confirmText}
          type={confirmationAction.actionType}
          isLoading={isProcessing}
        />
      )}
    </div>
  );
}
