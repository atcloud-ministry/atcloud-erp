/**
 * CreateNewProgram Component
 *
 * Orchestrator component for program creation workflow.
 * Delegates to specialized components and hooks:
 * - ProgramFormFields: Core form fields (type, title, dates, mentors, etc.)
 * - PricingSection: Tuition and pricing configuration
 * - useProgramCreation: Submission logic and API integration
 * - useProgramValidation: Real-time form validation
 * - RestrictedAccessOverlay: Access control for unauthorized users
 *
 * Architecture: Thin orchestrator pattern - minimal logic, maximum delegation
 */

import { useState, useMemo } from "react";
import { useForm } from "react-hook-form";
import { useAuth } from "../hooks/useAuth";
import { useProgramValidation } from "../hooks/useProgramValidation";
import { useProgramCreation } from "../hooks/useProgramCreation";
import ValidationIndicator from "../components/events/ValidationIndicator";
import RestrictedAccessOverlay from "../components/common/RestrictedAccessOverlay";
import ProgramFormFields from "../components/EditProgram/ProgramFormFields";
import type { Organizer as Mentor } from "../components/events/OrganizerSelection";
import PricingSection from "../components/EditProgram/PricingSection";
import type { ProgramStudentRoleForm } from "../types/program";
import {
  DEFAULT_STUDENT_ROLES,
  DEFAULT_TEACHER_ROLE_NAME,
} from "../utils/programRoles";

/**
 * Program form data interface - matches react-hook-form structure
 */
interface ProgramFormData {
  programType: string;
  title: string;
  startYear: string;
  startMonth: string;
  endYear: string;
  endMonth: string;
  hostedBy: string;
  introduction: string;
  flyerUrl?: string;
  flyer?: FileList;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  teacherRoleName?: string;
  studentRoles?: ProgramStudentRoleForm[];
  // Early Bird deadline (optional)
  earlyBirdDeadline?: string; // YYYY-MM-DD
  // Free program toggle
  isFree?: string; // Radio buttons return strings
  // Pricing (Phase 3)
  fullPriceTicket: number | undefined;
  classRepDiscount?: number | undefined;
  classRepLimit?: number | undefined;
  earlyBirdDiscount?: number | undefined;
}

// Generate years from current year to 5 years in the future
const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => (currentYear + i).toString());

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function CreateNewProgram() {
  const { currentUser } = useAuth();
  const { isSubmitting, createProgram, cancelCreation } = useProgramCreation();

  // Mentor state - managed locally, passed to hook on submission
  const [mentors, setMentors] = useState<Mentor[]>([]);

  // Form management with react-hook-form

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ProgramFormData>({
    defaultValues: {
      programType: "", // Start with placeholder (no selection)
      hostedBy: "@Cloud Marketplace Ministry",
      teacherRoleName: DEFAULT_TEACHER_ROLE_NAME,
      studentRoles: DEFAULT_STUDENT_ROLES,
      zoomLink: "",
      meetingId: "",
      passcode: "",
      startYear: currentYear.toString(),
      endYear: currentYear.toString(),
      fullPriceTicket: 0,
      classRepDiscount: 0,
      classRepLimit: 0, // 0 means unlimited
      earlyBirdDiscount: 0,
      earlyBirdDeadline: "",
      isFree: "true", // Default to free program
    },
  });

  const isFreeProgram = watch("isFree");

  // Real-time validation for program form fields
  const { validations, overallStatus } = useProgramValidation(watch);

  // Watch pricing fields for validation
  const fullPrice = watch("fullPriceTicket");
  const earlyBirdDiscountValue = watch("earlyBirdDiscount");
  const earlyBirdDeadline = watch("earlyBirdDeadline");

  /**
   * Pricing validation logic
   * Only validates when program is paid (isFree === "false")
   * Ensures full price is set and early bird deadline is provided if discount exists
   */
  const pricingValidation = useMemo(() => {
    if (isFreeProgram === "true") return { isValid: true, invalidCount: 0 };

    const earlyBirdDiscount = Number(earlyBirdDiscountValue || 0);

    // Validate Full Price Ticket (must be > 0)
    const isFullPriceValid =
      fullPrice !== undefined &&
      fullPrice !== null &&
      fullPrice > 0 &&
      fullPrice <= 100000;

    // Validate Early Bird Deadline (required if Early Bird Discount > 0)
    const isEarlyBirdDeadlineValid =
      earlyBirdDiscount > 0 ? !!earlyBirdDeadline : true;

    const invalidCount =
      (isFullPriceValid ? 0 : 1) + (isEarlyBirdDeadlineValid ? 0 : 1);

    return {
      isValid: isFullPriceValid && isEarlyBirdDeadlineValid,
      invalidCount,
    };
  }, [isFreeProgram, fullPrice, earlyBirdDiscountValue, earlyBirdDeadline]);

  /**
   * Combined validation status
   * Merges program field validation with pricing validation
   * Provides unified feedback to user
   */
  const combinedValidation = useMemo(() => {
    const baseInvalidCount = Object.values(validations).filter(
      (v) => !v.isValid
    ).length;
    const totalInvalidCount = baseInvalidCount + pricingValidation.invalidCount;

    return {
      isValid: overallStatus.isValid && pricingValidation.isValid,
      message:
        totalInvalidCount > 0
          ? `${totalInvalidCount} field(s) need attention before creating program`
          : overallStatus.message,
      color: totalInvalidCount > 0 ? "text-red-500" : overallStatus.color,
    };
  }, [validations, overallStatus, pricingValidation]);

  /**
   * Event Handlers
   */

  // Handle mentor selection changes
  const handleMentorsChange = (newMentors: Mentor[]) => {
    setMentors(newMentors);
  };

  // Submit form data to useProgramCreation hook
  const onSubmit = async (data: ProgramFormData) => {
    await createProgram(data, mentors);
  };

  // Cancel and navigate back to programs list
  const handleCancel = () => {
    cancelCreation();
  };

  /**
   * Access Control
   * Participants and Guest Experts cannot create programs
   */
  const shouldShowRestrictedOverlay =
    currentUser?.role === "Participant" || currentUser?.role === "Guest Expert";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div
        className={`relative bg-white rounded-lg shadow-sm p-6 ${
          shouldShowRestrictedOverlay ? "bg-gray-50" : ""
        }`}
      >
        <RestrictedAccessOverlay show={shouldShowRestrictedOverlay} />

        <h1 className="text-2xl font-bold text-gray-900 mb-6">
          Create New Program
        </h1>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <ProgramFormFields
            register={register}
            watch={watch}
            setValue={setValue}
            errors={errors}
            validations={validations}
            currentUser={currentUser}
            mentors={mentors}
            onMentorsChange={handleMentorsChange}
            originalFlyerUrl={null}
            YEARS={YEARS}
            MONTHS={MONTHS}
          />

          {/* Tuition (formerly Pricing Phase 3) */}
          <PricingSection
            register={register}
            watch={watch}
            setValue={setValue}
            errors={errors}
          />

          {/* Overall Validation Status */}
          <div className="mb-4 border-b pb-4">
            <ValidationIndicator
              validation={combinedValidation}
              showWhenEmpty={true}
            />
          </div>

          {/* Form Actions */}
          <div className="flex flex-col sm:flex-row gap-3 sm:justify-end pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Creating..." : "Create Program"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
