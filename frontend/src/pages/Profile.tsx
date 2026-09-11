import { useProfileForm } from "../hooks/useProfileForm";
import { useAuth } from "../hooks/useAuth";
import AvatarUpload from "../components/profile/AvatarUpload";
import ProfileFormFields from "../components/profile/ProfileFormFields";
import { PageHeader, Card, CardContent, Button } from "../components/ui";
import { FormActions } from "../components/forms/common";
import { Link } from "react-router-dom";

export default function Profile() {
  const {
    // Form state
    form,
    isEditing,

    // Avatar state
    avatarPreview,

    // Watched values
    watchedValues,

    // Actions
    onSubmit,
    handleEdit,
    handleCancel,
    handleAvatarChange,
  } = useProfileForm();

  // Get current user for role information and avatar data
  const { currentUser } = useAuth();

  const currentIsAtCloudLeader = watchedValues.isAtCloudLeader;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHeader
        title="My Profile"
        action={
          !isEditing ? (
            <div className="flex space-x-3">
              <Link
                to="/dashboard/change-password"
                className="bg-orange-600 text-white px-4 py-2 rounded-md hover:bg-orange-700 transition-colors"
              >
                Change Password
              </Link>
              <Button onClick={handleEdit} variant="primary">
                Edit Profile
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* Profile Form */}
      <Card>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="space-y-6">
            {/* Avatar and Form Layout */}
            <div className="flex flex-col lg:flex-row lg:space-x-8 space-y-6 lg:space-y-0">
              {/* Avatar Section - Left Side */}
              <div className="lg:w-1/4 flex-shrink-0">
                <AvatarUpload
                  avatarPreview={avatarPreview || ""}
                  isEditing={isEditing}
                  gender={(currentUser?.gender as "male" | "female") || "male"}
                  customAvatar={currentUser?.avatar}
                  userId={currentUser?.id || ""}
                  fullName={`${currentUser?.firstName} ${currentUser?.lastName}`}
                  onAvatarChange={handleAvatarChange}
                />
              </div>

              {/* Form Fields - Right Side */}
              <div className="lg:w-3/4 flex-grow">
                <ProfileFormFields
                  form={form}
                  isEditing={isEditing}
                  originalIsAtCloudLeader={currentUser?.isAtCloudLeader}
                />
              </div>
            </div>

            {/* Role Change Notification */}
            {isEditing &&
              currentUser?.role === "Participant" &&
              currentUser?.isAtCloudLeader === "No" &&
              currentIsAtCloudLeader === "Yes" && (
                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                  <p className="text-sm text-blue-600">
                    Note: Super Admin and Administrators will be notified of
                    this @Cloud Co-worker request.
                  </p>
                </div>
              )}

            {/* Action Buttons */}
            {isEditing && (
              <FormActions
                isSubmitting={false}
                submitLabel="Save Changes"
                onCancel={handleCancel}
                cancelLabel="Cancel"
              />
            )}

            {/* System Authorization Level Display */}
            {!isEditing && (
              <div className="border-t pt-6">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-gray-900 mb-2">
                    System Information
                  </h3>
                  <div className="space-y-2">
                    <p className="text-sm text-gray-600">
                      System Authorization Level:{" "}
                      <span className="font-medium">{currentUser?.role}</span>
                    </p>
                    {/* Show Database ID only to Super Admin and Administrator */}
                    {(currentUser?.role === "Super Admin" ||
                      currentUser?.role === "Administrator") && (
                      <p className="text-sm text-gray-600">
                        Database ID:{" "}
                        <span className="font-mono text-xs font-medium bg-gray-200 px-2 py-1 rounded">
                          {currentUser?.id}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
