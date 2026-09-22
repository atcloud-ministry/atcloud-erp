import { useState, useEffect, useCallback } from "react";
import { yupResolver } from "@hookform/resolvers/yup";
import { useForm, useWatch, type Resolver } from "react-hook-form";
import { useAuth } from "./useAuth";
import { userService, fileService } from "../services/api";
import {
  profileEditSchema,
  type ProfileFormData,
} from "../schemas/profileSchema";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import { formatFileSize } from "../utils/imageCompression";
import { getAvatarUrlWithCacheBust } from "../utils/avatarUtils";
import type { AuthUser } from "../types";
import {
  hasRegistrationProfileFieldChanges,
  getDefaultPhoneCountry,
  isRegistrationProfileComplete,
  prepareRegistrationProfileSubmission,
} from "../utils/registrationProfile";

function profileFormValues(user: AuthUser | null): ProfileFormData {
  return {
    firstName: user?.firstName ?? "",
    lastName: user?.lastName ?? "",
    username: user?.username ?? "",
    email: user?.email ?? "",
    gender: user?.gender ?? "",
    phone: user?.phone ?? "",
    phoneCountryCode: getDefaultPhoneCountry(
      user?.phone,
      user?.residenceCountryCode,
    ),
    birthYear: user?.birthYear ?? "",
    residenceCity: user?.residenceCity ?? "",
    residenceRegion: user?.residenceRegion ?? "",
    residenceCountryCode: user?.residenceCountryCode ?? "",
    employmentStatus: user?.employmentStatus ?? "",
    isAtCloudLeader: user?.isAtCloudLeader ?? "No",
    roleInAtCloud: user?.roleInAtCloud ?? "",
    occupation: user?.occupation ?? "",
    company: user?.company ?? "",
    weeklyChurch: user?.weeklyChurch ?? "",
    churchAddress: user?.churchAddress ?? "",
  } as ProfileFormData;
}

interface UseProfileFormOptions {
  forceRegistrationProfileCompletion?: boolean;
}

export function useProfileForm({
  forceRegistrationProfileCompletion = false,
}: UseProfileFormOptions = {}) {
  const { currentUser, updateUser } = useAuth();
  const notification = useToastReplacement();
  const [isEditing, setIsEditing] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(
    null
  );
  const [loading, setLoading] = useState(false);

  const userData = profileFormValues(currentUser);

  const form = useForm<ProfileFormData>({
    defaultValues: userData,
    mode: "onChange",
    resolver: yupResolver(profileEditSchema) as unknown as Resolver<ProfileFormData>,
  });

  const { reset, control } = form;
  const watchedValues = useWatch({ control });

  // Update form when currentUser changes. 'reset' is stable per RHF docs.
  useEffect(() => {
    if (currentUser) {
      reset(profileFormValues(currentUser));
    }
  }, [currentUser, reset]);

  // Set avatar preview from current user
  useEffect(() => {
    if (currentUser?.avatar) {
      setAvatarPreview(currentUser.avatar);
    }
  }, [currentUser?.avatar]);

  const handleEdit = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleCancel = () => {
    setIsEditing(false);
    reset(userData);
    setAvatarPreview(currentUser?.avatar || null);
    setSelectedAvatarFile(null); // Clear selected file
  };

  const handleAvatarChange = (file: File, previewUrl: string) => {
    // Validate file size (10MB limit to match backend)
    const maxSize = 10 * 1024 * 1024; // 10MB in bytes
    if (file.size > maxSize) {
      notification.error(
        `File is too large. Maximum size is ${Math.round(
          maxSize / (1024 * 1024)
        )}MB.`,
        {
          title: "File Too Large",
        }
      );
      return;
    }

    // Validate file type
    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    if (!allowedTypes.includes(file.type)) {
      notification.error(
        "Please select a valid image file (JPEG, PNG, GIF, or WebP).",
        {
          title: "Invalid File Type",
        }
      );
      return;
    }

    setSelectedAvatarFile(file);
    setAvatarPreview(previewUrl);

    const originalSize = formatFileSize(file.size);
    notification.success(
      `Avatar selected! Size: ${originalSize}. It will be optimized to WebP during upload. Click "Save Changes" to upload.`,
      {
        title: "Avatar Selected",
        autoCloseDelay: 4000,
      }
    );
  };

  const onSubmit = async (data: ProfileFormData) => {
    if (!currentUser) return;

    const shouldSubmitRegistrationProfile =
      forceRegistrationProfileCompletion ||
      isRegistrationProfileComplete(currentUser) ||
      hasRegistrationProfileFieldChanges(data, userData);
    const registrationProfile = shouldSubmitRegistrationProfile
      ? prepareRegistrationProfileSubmission(data)
      : null;

    if (registrationProfile && !registrationProfile.success) {
      for (const issue of registrationProfile.issues) {
        form.setError(issue.field, {
          type: "validate",
          message: issue.message,
        });
      }
      notification.error(
        registrationProfile.issues.find((issue) => issue.field === "phone")
          ?.message ??
          "Please complete the required contact, residence, and employment fields.",
        { title: "Profile Incomplete" },
      );
      return;
    }
    const canonicalRegistrationProfile =
      registrationProfile?.success === true ? registrationProfile.value : null;

    setLoading(true);
    try {
      let avatarUrl = currentUser.avatar;

      // Upload avatar if a new file was selected
      if (selectedAvatarFile) {
        const uploadResult = await fileService.uploadAvatar(selectedAvatarFile);
        avatarUrl = uploadResult.avatarUrl;

        // Clear the preview and update with new avatar URL
        setAvatarPreview(null);
      }

      // Transform data for backend API
      const apiData = {
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        gender: data.gender,
        ...(canonicalRegistrationProfile ?? {}),
        isAtCloudLeader: data.isAtCloudLeader === "Yes",
        roleInAtCloud:
          data.isAtCloudLeader === "Yes" ? data.roleInAtCloud : "",
        weeklyChurch: data.weeklyChurch,
        churchAddress: data.churchAddress,
      };

      // Update user profile via backend API
      const updatedUser = await userService.updateProfile(apiData);

      // Build a normalized patch for AuthContext (AuthUser shape)
      const finalAvatar = getAvatarUrlWithCacheBust(
        avatarUrl || null,
        (updatedUser.gender as "male" | "female") || currentUser.gender
      );

      const normalizedPatch: Partial<AuthUser> = {
        id: updatedUser.id ?? currentUser.id,
        username: updatedUser.username ?? currentUser.username,
        firstName: updatedUser.firstName ?? currentUser.firstName,
        lastName: updatedUser.lastName ?? currentUser.lastName,
        email: updatedUser.email ?? currentUser.email,
        phone:
          updatedUser.phone ??
          canonicalRegistrationProfile?.phone ??
          currentUser.phone,
        birthYear:
          updatedUser.birthYear ??
          canonicalRegistrationProfile?.birthYear ??
          currentUser.birthYear,
        residenceCity:
          updatedUser.residenceCity ??
          canonicalRegistrationProfile?.residenceCity ??
          currentUser.residenceCity,
        residenceRegion:
          updatedUser.residenceRegion === undefined
            ? canonicalRegistrationProfile
              ? canonicalRegistrationProfile.residenceRegion
              : currentUser.residenceRegion
            : updatedUser.residenceRegion,
        residenceCountryCode:
          updatedUser.residenceCountryCode ??
          canonicalRegistrationProfile?.residenceCountryCode ??
          currentUser.residenceCountryCode,
        employmentStatus:
          updatedUser.employmentStatus ??
          canonicalRegistrationProfile?.employmentStatus ??
          currentUser.employmentStatus,
        role: (updatedUser.role as AuthUser["role"]) ?? currentUser.role,
        isAtCloudLeader:
          updatedUser.isAtCloudLeader === undefined
            ? currentUser.isAtCloudLeader
            : updatedUser.isAtCloudLeader
              ? "Yes"
              : "No",
        roleInAtCloud:
          updatedUser.roleInAtCloud ??
          (data.isAtCloudLeader === "Yes" ? data.roleInAtCloud : ""),
        gender: (updatedUser.gender as "male" | "female") ?? currentUser.gender,
        avatar: finalAvatar,
        weeklyChurch: updatedUser.weeklyChurch ?? currentUser.weeklyChurch,
        churchAddress: updatedUser.churchAddress ?? currentUser.churchAddress,
        homeAddress: canonicalRegistrationProfile
          ? undefined
          : updatedUser.homeAddress ?? currentUser.homeAddress,
        occupation:
          updatedUser.occupation === undefined
            ? canonicalRegistrationProfile
              ? canonicalRegistrationProfile.occupation
              : currentUser.occupation
            : updatedUser.occupation,
        company:
          updatedUser.company === undefined
            ? canonicalRegistrationProfile
              ? canonicalRegistrationProfile.company
              : currentUser.company
            : updatedUser.company,
      };

      // Update auth context with normalized values
      updateUser(normalizedPatch);

      // Also immediately sync the form values so UI reflects changes without waiting
      reset(
        profileFormValues({
          ...currentUser,
          ...normalizedPatch,
        }),
      );

      setIsEditing(false);
      setSelectedAvatarFile(null); // Clear selected file
      setAvatarPreview(null); // Clear avatar preview so it uses the new uploaded avatar
      notification.success("Profile updated successfully!", {
        title: "Profile Saved",
        autoCloseDelay: 3000,
      });
    } catch (error: unknown) {
      console.error("Profile update failed:", error);
      notification.error(
        (error as { message?: string })?.message || "Failed to update profile",
        {
          title: "Update Failed",
        }
      );
    } finally {
      setLoading(false);
    }
  };

  return {
    // Form state
    form,
    isEditing,
    userData,
    loading,

    // Avatar state
    avatarPreview,

    // Watched values
    watchedValues,

    // Actions
    onSubmit: form.handleSubmit(onSubmit),
    handleEdit,
    handleCancel,
    handleAvatarChange,
  };
}
