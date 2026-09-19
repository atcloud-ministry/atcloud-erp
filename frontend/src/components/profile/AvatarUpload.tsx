import { getAvatarUrlWithCacheBust } from "../../utils/avatarUtils";
import { AVATAR_UPLOAD_CONFIG } from "../../config/profileConstants";

interface AvatarUploadProps {
  avatarPreview: string;
  isEditing: boolean;
  gender: "male" | "female";
  customAvatar?: string | null;
  userId?: string;
  fullName?: string;
  onAvatarChange: (file: File, previewUrl: string) => void;
}

export default function AvatarUpload({
  avatarPreview,
  isEditing,
  gender,
  customAvatar,
  userId,
  fullName,
  onAvatarChange,
}: AvatarUploadProps) {
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const previewUrl = reader.result as string;
        onAvatarChange(file, previewUrl);
      };
      reader.readAsDataURL(file);
    }
  };

  // Use appropriate avatar: preview > custom avatar > gender-specific default
  // Use cache-busting for uploaded avatars to ensure fresh display
  const displayAvatar =
    avatarPreview || getAvatarUrlWithCacheBust(customAvatar || null, gender);

  return (
    <div className="flex flex-col items-center mb-6">
      <div className="relative mb-4">
        <img
          src={displayAvatar}
          alt={fullName ? `${fullName}'s Profile Avatar` : "Profile Avatar"}
          className="w-32 h-32 rounded-full object-cover border-4 border-gray-200"
        />
        {isEditing && (
          <label
            className="absolute bottom-0 right-0 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full bg-blue-600 p-2 text-white transition-colors hover:bg-blue-700 focus-within:ring-2 focus-within:ring-blue-600 focus-within:ring-offset-2"
            htmlFor="profile-avatar-upload"
          >
            <span className="sr-only">Change profile picture</span>
            <svg
              aria-hidden="true"
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <input
              aria-describedby="profile-avatar-upload-help"
              aria-label="Change profile picture"
              type="file"
              accept={AVATAR_UPLOAD_CONFIG.acceptedTypes}
              id="profile-avatar-upload"
              onChange={handleAvatarChange}
              className="sr-only"
            />
          </label>
        )}
      </div>
      {isEditing && (
        <p className="text-sm text-gray-600 text-center" id="profile-avatar-upload-help">
          Choose the camera button to change your profile picture
        </p>
      )}

      {/* User Info Display - Only shown when not editing */}
      {!isEditing && (userId || fullName) && (
        <div className="text-center space-y-1">
          {fullName && (
            <h3 className="text-lg font-medium text-gray-900">{fullName}</h3>
          )}
          {userId && (
            <p className="text-sm text-gray-500 font-mono">ID: {userId}</p>
          )}
        </div>
      )}
    </div>
  );
}
