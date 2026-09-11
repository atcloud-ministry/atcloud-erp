import { useState } from "react";
import { userService, fileService } from "../services/api";
import type { AdminProfileUpdate } from "../services/api/users.api";
import { useToastReplacement } from "../contexts/NotificationModalContext";

export function useAdminProfileEdit(userId: string, onSuccess: () => void) {
  const notification = useToastReplacement();
  const [isEditMode, setIsEditMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  const handleEditToggle = () => {
    setIsEditMode(!isEditMode);
    // Reset avatar changes when canceling
    if (isEditMode) {
      setAvatarFile(null);
      setAvatarPreview(null);
    }
  };

  const handleAvatarChange = (file: File | null, preview: string | null) => {
    setAvatarFile(file);
    setAvatarPreview(preview);
  };

  const handleSave = async (formData: AdminProfileUpdate) => {
    try {
      setIsSaving(true);

      let avatarUrl = formData.avatar;

      // Upload avatar if file was selected
      // Use dedicated admin avatar upload endpoint to store in /avatars/ folder
      if (avatarFile) {
        const uploadResult = await fileService.uploadAvatarForAdmin(avatarFile);
        avatarUrl = uploadResult.avatarUrl;
      }

      // Update profile with admin endpoint
      await userService.adminEditProfile(userId, {
        ...formData,
        avatar: avatarUrl,
      });

      notification.success("Profile updated successfully", {
        title: "Success",
      });

      setIsEditMode(false);
      setAvatarFile(null);
      setAvatarPreview(null);
      onSuccess(); // Refresh the profile data
    } catch (error) {
      console.error("Failed to update profile:", error);
      notification.error(
        error instanceof Error
          ? error.message
          : "Failed to update profile. Please try again.",
        {
          title: "Update Failed",
        }
      );
    } finally {
      setIsSaving(false);
    }
  };

  return {
    isEditMode,
    isSaving,
    avatarFile,
    avatarPreview,
    handleEditToggle,
    handleAvatarChange,
    handleSave,
  };
}
