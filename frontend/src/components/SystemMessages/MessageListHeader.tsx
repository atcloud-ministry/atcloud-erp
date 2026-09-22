import { Icon } from "../common";

interface MessageListHeaderProps {
  hasCreatePermission: boolean;
  onCreateClick: () => void;
}

/**
 * Header component for the System Messages page.
 * Displays the page title, description, and a create button for authorized users.
 */
export default function MessageListHeader({
  hasCreatePermission,
  onCreateClick,
}: MessageListHeaderProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <svg
            className="w-8 h-8 text-blue-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              System Messages
            </h1>
            <p className="text-gray-600">
              Important announcements and system updates
            </p>
          </div>
        </div>

        {/* Create Button - Available to Super Admin and Administrator only */}
        {hasCreatePermission && (
          <button
            onClick={onCreateClick}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2"
          >
            <Icon name="plus" className="w-5 h-5" />
            <span>Create New System Message</span>
          </button>
        )}
      </div>
    </div>
  );
}
