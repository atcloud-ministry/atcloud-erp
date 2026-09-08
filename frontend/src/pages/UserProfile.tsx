import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { PageHeader, Card, CardContent, Button } from "../components/ui";
import { Link } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import {
  adminUsersService,
  communityMembersService,
  type AdminUserDTO,
  type CommunityMemberDTO,
} from "../services/api";
import { getAvatarUrlWithCacheBust, getAvatarAlt } from "../utils/avatarUtils";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import { safeFormatDate } from "../utils/eventStatsUtils";
import { useAdminProfileEdit } from "../hooks/useAdminProfileEdit";
import AvatarUpload from "../components/profile/AvatarUpload";

type ProfileRead =
  | { scope: "admin"; user: AdminUserDTO }
  | { scope: "community"; user: CommunityMemberDTO };

export default function UserProfile() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { currentUser, isLoading: authLoading } = useAuth();
  const notification = useToastReplacement();
  const [profile, setProfile] = useState<ProfileRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editFormData, setEditFormData] = useState({
    avatar: "",
    phone: "",
    isAtCloudLeader: false,
    roleInAtCloud: "",
  });

  // Check if current user can edit this profile
  const canEdit =
    currentUser?.role === "Super Admin" ||
    currentUser?.role === "Administrator";

  // Check if the current user is viewing their own profile
  const isOwnProfile = currentUser?.id === userId;

  // Fetch profile data function (to be called on mount and after save)
  const fetchProfile = useCallback(async () => {
    if (authLoading) return;
    if (!userId) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    // If viewing own profile, redirect
    if (isOwnProfile) {
      navigate("/dashboard/profile", { replace: true });
      return;
    }

    try {
      setLoading(true);
      const fetchedUser = canEdit
        ? await adminUsersService.get(userId)
        : await communityMembersService.get(userId);

      if (!fetchedUser) {
        setNotFound(true);
        return;
      }

      if (canEdit) {
        const adminUser = fetchedUser as AdminUserDTO;
        setProfile({ scope: "admin", user: adminUser });
        setEditFormData({
          avatar: adminUser.avatar || "",
          phone: adminUser.phone || "",
          isAtCloudLeader: adminUser.isAtCloudLeader,
          roleInAtCloud: adminUser.roleInAtCloud || "",
        });
      } else {
        setProfile({
          scope: "community",
          user: fetchedUser as CommunityMemberDTO,
        });
      }
      setNotFound(false);
    } catch (error: unknown) {
      console.error("UserProfile: Error fetching user", error);
      setNotFound(true);
      notification.error(
        "Unable to load the user profile. The user may not exist or there may be a connection issue.",
        {
          title: "Profile Loading Failed",
          actionButton: {
            text: "Retry",
            onClick: () => {
              fetchProfile();
            },
            variant: "primary",
          },
        }
      );
    } finally {
      setLoading(false);
    }
  }, [authLoading, canEdit, isOwnProfile, navigate, notification, userId]);

  // Use the admin profile edit hook
  const {
    isEditMode,
    isSaving,
    avatarPreview,
    handleEditToggle,
    handleAvatarChange,
    handleSave,
  } = useAdminProfileEdit(userId || "", fetchProfile);

  // Single useEffect to handle all logic
  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Loading state
  if (loading) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <PageHeader title="Loading Profile..." />
        <Card>
          <CardContent>
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <span className="ml-2 text-gray-500">
                Loading user profile...
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // If user is not found, show error
  if (notFound || !profile) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <PageHeader title="User Not Found" />
        <Card>
          <CardContent>
            <p className="text-gray-500">
              The user profile you're looking for doesn't exist.
            </p>
            <Link
              to="/dashboard/management"
              className="text-blue-600 hover:text-blue-800 mt-4 inline-block"
            >
              ← Back to {canEdit ? "Administration" : "Community"}
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (profile.scope === "community") {
    const member = profile.user;
    const fullName =
      `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() ||
      member.username;

    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <PageHeader title={`${fullName}'s Profile`} />
        <Card>
          <CardContent>
            <div className="flex flex-col items-center gap-5 py-4 text-center">
              <img
                className="w-32 h-32 rounded-full object-cover"
                src={getAvatarUrlWithCacheBust(
                  member.avatar,
                  member.gender ?? "male",
                )}
                alt={getAvatarAlt(
                  member.firstName ?? "",
                  member.lastName ?? "",
                  Boolean(member.avatar),
                )}
              />
              <div>
                <h2 className="text-xl font-semibold text-gray-900">
                  {fullName}
                </h2>
                <p className="text-sm text-gray-500">@{member.username}</p>
              </div>
              {member.roleInAtCloud && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                    Role in @Cloud
                  </p>
                  <p className="mt-1 text-sm text-gray-900">
                    {member.roleInAtCloud}
                  </p>
                </div>
              )}
              <Link
                to="/dashboard/management"
                className="text-blue-600 hover:text-blue-800"
              >
                ← Back to Community
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const profileUser = profile.user;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHeader
        title={`${profileUser.firstName} ${profileUser.lastName}'s Profile`}
        action={
          canEdit && !isEditMode ? (
            <Button onClick={handleEditToggle} variant="primary">
              Edit Profile
            </Button>
          ) : undefined
        }
      />

      {/* Profile Form - Same layout as Profile.tsx */}
      <Card>
        <CardContent>
          <div className="space-y-6">
            {/* Avatar and Form Layout - Same as Profile.tsx */}
            <div className="flex flex-col lg:flex-row lg:space-x-8 space-y-6 lg:space-y-0">
              {/* Avatar Section - Left Side */}
              <div className="lg:w-1/4 flex-shrink-0">
                {isEditMode ? (
                  <AvatarUpload
                    avatarPreview={avatarPreview || profileUser.avatar || ""}
                    isEditing={true}
                    gender={(profileUser.gender as "male" | "female") || "male"}
                    customAvatar={profileUser.avatar}
                    userId={profileUser.id}
                    fullName={`${profileUser.firstName} ${profileUser.lastName}`}
                    onAvatarChange={handleAvatarChange}
                  />
                ) : (
                  <div className="text-center">
                    <div className="mb-4">
                      <img
                        className="w-32 h-32 rounded-full mx-auto object-cover"
                        src={getAvatarUrlWithCacheBust(
                          profileUser.avatar || null,
                          profileUser.gender || "male"
                        )}
                        alt={getAvatarAlt(
                          profileUser.firstName || "",
                          profileUser.lastName || "",
                          !!profileUser.avatar
                        )}
                      />
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {profileUser.firstName} {profileUser.lastName}
                    </h3>
                    <p className="text-sm text-gray-500">
                      @{profileUser.username}
                    </p>
                    <span
                      className={`inline-flex px-3 py-1 text-sm font-medium rounded-full mt-2 ${
                        profileUser.role === "Super Admin"
                          ? "bg-purple-100 text-purple-800"
                          : profileUser.role === "Administrator"
                          ? "bg-red-100 text-red-800"
                          : profileUser.role === "Leader"
                          ? "bg-yellow-100 text-yellow-800"
                          : "bg-green-100 text-green-800"
                      }`}
                    >
                      {profileUser.role}
                    </span>
                  </div>
                )}
              </div>

              {/* Form Section - Right Side */}
              <div className="lg:w-3/4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      First Name
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.firstName}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Last Name
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.lastName}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Username
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.username}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.email}
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="user-phone"
                      className="block text-sm font-medium text-gray-700 mb-1"
                    >
                      Phone
                    </label>
                    {isEditMode ? (
                      <input
                        id="user-phone"
                        type="tel"
                        value={editFormData.phone}
                        onChange={(e) =>
                          setEditFormData({
                            ...editFormData,
                            phone: e.target.value,
                          })
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="Enter phone number"
                      />
                    ) : (
                      <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                        {profileUser.phone || "Not provided"}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Gender
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md capitalize">
                      {profileUser.gender || "Not specified"}
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="user-atcloud-coworker"
                      className="block text-sm font-medium text-gray-700 mb-1"
                    >
                      @Cloud Co-worker
                    </label>
                    {isEditMode ? (
                      <div className="flex items-center space-x-4">
                        <label className="flex items-center cursor-pointer">
                          <input
                            id="user-atcloud-coworker"
                            type="checkbox"
                            checked={editFormData.isAtCloudLeader}
                            onChange={(e) =>
                              setEditFormData({
                                ...editFormData,
                                isAtCloudLeader: e.target.checked,
                                // Clear role if unchecking
                                roleInAtCloud: e.target.checked
                                  ? editFormData.roleInAtCloud
                                  : "",
                              })
                            }
                            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                          />
                          <span className="ml-2 text-sm text-gray-700">
                            Yes
                          </span>
                        </label>
                      </div>
                    ) : (
                      <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                        {profileUser.isAtCloudLeader ? "Yes" : "No"}
                      </div>
                    )}
                  </div>

                  {(isEditMode
                    ? editFormData.isAtCloudLeader
                    : profileUser.isAtCloudLeader) && (
                    <div className="md:col-span-2">
                      <label
                        htmlFor="user-role-in-atcloud"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        Role in @Cloud{" "}
                        {isEditMode && <span className="text-red-500">*</span>}
                      </label>
                      {isEditMode ? (
                        <input
                          id="user-role-in-atcloud"
                          type="text"
                          value={editFormData.roleInAtCloud}
                          onChange={(e) =>
                            setEditFormData({
                              ...editFormData,
                              roleInAtCloud: e.target.value,
                            })
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Enter role in @Cloud"
                          required={editFormData.isAtCloudLeader}
                        />
                      ) : (
                        <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                          {profileUser.roleInAtCloud}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Home Address
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.homeAddress || "Not provided"}
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Occupation
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.occupation || "Not provided"}
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Company
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.company || "Not provided"}
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Weekly Church
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.weeklyChurch || "Not provided"}
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Church Address
                    </label>
                    <div className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-md">
                      {profileUser.churchAddress || "Not provided"}
                    </div>
                  </div>
                </div>

                {/* Action Buttons in Edit Mode */}
                {isEditMode && (
                  <div className="flex justify-end gap-3 mt-6 pt-6 border-t">
                    <Button
                      type="button"
                      onClick={handleEditToggle}
                      disabled={isSaving}
                      className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        // Validate: roleInAtCloud is required if isAtCloudLeader is true
                        if (
                          editFormData.isAtCloudLeader &&
                          !editFormData.roleInAtCloud?.trim()
                        ) {
                          alert(
                            "Role in @Cloud is required when user is marked as @Cloud Co-worker"
                          );
                          return;
                        }

                        handleSave(editFormData);
                      }}
                      disabled={isSaving}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isSaving ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* System Authorization Level Display */}
            <div className="border-t pt-6">
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-900 mb-2">
                  System Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <p className="text-sm text-gray-600">
                    System Authorization Level:{" "}
                    <span className="font-medium">{profileUser.role}</span>
                  </p>
                  {/* Show Database ID only to Super Admin and Administrator */}
                  {(currentUser?.role === "Super Admin" ||
                    currentUser?.role === "Administrator") && (
                    <p className="text-sm text-gray-600">
                      Database ID:{" "}
                      <span className="font-mono text-xs font-medium bg-gray-200 px-2 py-1 rounded">
                        {profileUser.id}
                      </span>
                    </p>
                  )}
                  {profileUser.createdAt && (
                    <p className="text-sm text-gray-600">
                      Join Date:{" "}
                      <span className="font-medium">
                        {safeFormatDate(profileUser.createdAt)}
                      </span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
