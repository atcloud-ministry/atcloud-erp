import { useState, useEffect, useMemo, useRef } from "react";
import { deriveFlyerUrlForUpdate } from "../utils/flyerUrl";
import { useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { useAuth } from "../hooks/useAuth";
import { useProgramValidation } from "../hooks/useProgramValidation";
import ValidationIndicator from "../components/events/ValidationIndicator";
import PricingSection from "../components/EditProgram/PricingSection";
import PricingConfirmationModal from "../components/EditProgram/PricingConfirmationModal";
import ProgramFormFields from "../components/EditProgram/ProgramFormFields";
import ProgramCommunitySettingsSection, {
  buildProgramCommunitySettingsInput,
  createProgramCommunitySettingsDraft,
  programCommunitySettingsChanged,
  type ProgramCommunitySettingsDraft,
} from "../components/EditProgram/ProgramCommunitySettingsSection";
import type { Organizer as Mentor } from "../components/events/OrganizerSelection";
import LoadingSpinner from "../components/common/LoadingSpinner";
import { programService, purchaseService } from "../services/api";
import { type ProgramType } from "../constants/programTypes";
import {
  getProgramMentorUserId,
  toProgramMentorPayloads,
  type ProgramMentorPayload,
} from "../utils/programMentorPayload";
import type {
  ProgramRoles,
  ProgramStudentRoleForm,
} from "../types/program";
import {
  buildProgramRolesPayload,
  DEFAULT_STUDENT_ROLES,
  DEFAULT_TEACHER_ROLE_NAME,
  rolesToFormRoles,
} from "../utils/programRoles";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import { createIdempotencyKey } from "../utils/idempotencyKey";
import type {
  ProgramCommunitySettingsDTO,
  UpdateProgramCommunitySettingsInput,
} from "../services/api/programCommunitySettings.contracts";

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
  // Free program toggle
  isFree?: string; // "true" or "false"
  // Early Bird deadline (optional)
  earlyBirdDeadline?: string; // YYYY-MM-DD
  // Pricing (Phase 3)
  fullPriceTicket: number | undefined;
  classRepDiscount?: number | undefined;
  earlyBirdDiscount?: number | undefined;
  classRepLimit?: number | undefined;
}

// Payload types sent to backend
type ProgramUpdatePayload = {
  title: string;
  programType: ProgramType;
  hostedBy?: string;
  period: {
    startYear?: string;
    startMonth?: string;
    endYear?: string;
    endMonth?: string;
  };
  introduction?: string;
  // flyerUrl can be string | null (explicit null signals removal)
  flyerUrl?: string | null;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  isFree?: boolean;
  earlyBirdDeadline?: string;
  mentors?: ProgramMentorPayload[];
  programRoles?: ProgramRoles;
  // Pricing fields
  fullPriceTicket: number;
  classRepDiscount?: number;
  earlyBirdDiscount?: number;
  classRepLimit?: number;
};

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

export default function EditProgram() {
  const { id } = useParams<{ id: string }>();
  const { currentUser } = useAuth();
  const { config: runtimeConfig, status: runtimeConfigStatus } =
    useRuntimeConfig();
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [communitySettings, setCommunitySettings] =
    useState<ProgramCommunitySettingsDTO | null>(null);
  const [communityDraft, setCommunityDraft] =
    useState<ProgramCommunitySettingsDraft | null>(null);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [communityReloadSequence, setCommunityReloadSequence] = useState(0);
  const communityRetryRef = useRef<{
    readonly fingerprint: string;
    readonly key: string;
  } | null>(null);
  const partialCommunitySaveRef = useRef<{
    readonly programFingerprint: string;
    readonly communityFingerprint: string;
  } | null>(null);

  const communityReadable =
    runtimeConfigStatus === "ready" && runtimeConfig.alumniNetwork.readable;
  const communityWritable =
    runtimeConfigStatus === "ready" && runtimeConfig.alumniNetwork.writable;
  const communitySettingsUnavailable =
    communityReadable && !communityLoading && communitySettings === null;

  // Confirmation modal states
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmationStep, setConfirmationStep] = useState(1);
  const [pendingFormData, setPendingFormData] =
    useState<ProgramFormData | null>(null);

  // Store original pricing values to detect changes
  const [originalPricing, setOriginalPricing] = useState<{
    isFree?: boolean;
    fullPriceTicket?: number;
    classRepDiscount?: number;
    earlyBirdDiscount?: number;
    earlyBirdDeadline?: string;
    programRoles?: ProgramRoles;
  }>({});

  // Unified mentor state for all program types
  const [mentors, setMentors] = useState<Mentor[]>([]);
  // Store original mentor array to detect changes
  const [originalMentors, setOriginalMentors] = useState<Mentor[]>([]);
  // Store original program data including mentors to check permissions
  const [programMentorIds, setProgramMentorIds] = useState<string[]>([]);
  // Track if current user is the program creator
  const [isCreator, setIsCreator] = useState(false);
  // Track if current user is a class rep of this program
  const [isClassRep, setIsClassRep] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<ProgramFormData>({
    defaultValues: {
      hostedBy: "@Cloud Marketplace Ministry",
      teacherRoleName: DEFAULT_TEACHER_ROLE_NAME,
      studentRoles: DEFAULT_STUDENT_ROLES,
      zoomLink: "",
      meetingId: "",
      passcode: "",
      startYear: currentYear.toString(),
      endYear: currentYear.toString(),
      isFree: "true", // Default to free program
      fullPriceTicket: 0,
      classRepDiscount: 0,
      earlyBirdDiscount: 0,
      classRepLimit: 0, // 0 means unlimited
      earlyBirdDeadline: "",
    },
  });

  const isFreeProgram = watch("isFree");

  // Real-time validation
  const { validations, overallStatus } = useProgramValidation(watch);

  // Extract watched values for pricing validation
  const fullPrice = watch("fullPriceTicket");
  const earlyBirdDiscountValue = watch("earlyBirdDiscount");
  const earlyBirdDeadline = watch("earlyBirdDeadline");

  // Pricing validation (only when program is not free)
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

  // Extract validation values for useMemo dependency
  const validationValues = Object.values(validations);

  // Combined validation status
  const combinedValidation = useMemo(() => {
    const baseInvalidCount = validationValues.filter((v) => !v.isValid).length;
    const totalInvalidCount = baseInvalidCount + pricingValidation.invalidCount;

    return {
      isValid: overallStatus.isValid && pricingValidation.isValid,
      message:
        totalInvalidCount > 0
          ? `${totalInvalidCount} field(s) need attention before updating program`
          : overallStatus.message,
      color: totalInvalidCount > 0 ? "text-red-500" : overallStatus.color,
    };
  }, [validationValues, overallStatus, pricingValidation]);

  // Helper function to compare mentor arrays
  const compareMentorArrays = (arr1: Mentor[], arr2: Mentor[]): boolean => {
    if (arr1.length !== arr2.length) return false;
    return arr1.every(
      (mentor, index) =>
        getProgramMentorUserId(mentor) ===
        getProgramMentorUserId(arr2[index]),
    );
  };

  // Check if mentors have changed - unified for all program types
  const mentorsChanged = !compareMentorArrays(mentors, originalMentors);

  const currentCommunityStudentRoles = buildProgramRolesPayload({
    teacherRoleName: watch("teacherRoleName"),
    studentRoles: watch("studentRoles"),
  }).studentRoles;
  let communityDraftDirty = false;
  if (communitySettings && communityDraft) {
    try {
      communityDraftDirty = programCommunitySettingsChanged(
        communitySettings,
        buildProgramCommunitySettingsInput(
          communityDraft,
          currentCommunityStudentRoles,
          communitySettings.revision,
        ),
      );
    } catch {
      communityDraftDirty = true;
    }
  }

  // Custom isDirty that includes mentor changes
  const customIsDirty = isDirty || mentorsChanged || communityDraftDirty;

  // Check if pricing has changed
  const hasPricingChanges = useMemo(() => {
    const currentIsFree = isFreeProgram === "true";
    // Convert current dollar values to cents for comparison
    const currentFullPrice = Math.round((fullPrice ?? 0) * 100);
    const currentProgramRoles = buildProgramRolesPayload({
      teacherRoleName: watch("teacherRoleName"),
      studentRoles: watch("studentRoles"),
    });
    const currentClassRep =
      currentProgramRoles.studentRoles.find((role) => role.discountEligible)
        ?.discountAmount ?? 0;
    const currentEarlyBird = Math.round((earlyBirdDiscountValue ?? 0) * 100);
    const currentDeadline = earlyBirdDeadline ?? "";

    return (
      originalPricing.isFree !== currentIsFree ||
      originalPricing.fullPriceTicket !== currentFullPrice ||
      originalPricing.classRepDiscount !== currentClassRep ||
      originalPricing.earlyBirdDiscount !== currentEarlyBird ||
      originalPricing.earlyBirdDeadline !== currentDeadline ||
      JSON.stringify(originalPricing.programRoles) !==
        JSON.stringify(currentProgramRoles)
    );
  }, [
    originalPricing,
    isFreeProgram,
    fullPrice,
    watch,
    earlyBirdDiscountValue,
    earlyBirdDeadline,
  ]);

  // Handle form submission with pricing confirmation
  const handleFormSubmit = (data: ProgramFormData) => {
    if (hasPricingChanges) {
      // Show confirmation modal for pricing changes
      setPendingFormData(data);
      setConfirmationStep(1);
      setShowConfirmation(true);
    } else {
      // No pricing changes, submit directly
      handleActualSubmit(data);
    }
  };

  // Handle confirmation step progression
  const handleConfirmationNext = () => {
    if (confirmationStep === 1) {
      setConfirmationStep(2);
    } else {
      // Final confirmation, proceed with submission
      setShowConfirmation(false);
      if (pendingFormData) {
        handleActualSubmit(pendingFormData);
      }
    }
  };

  const handleConfirmationCancel = () => {
    setShowConfirmation(false);
    setConfirmationStep(1);
    setPendingFormData(null);
  };

  // Track original flyer to detect removal intent
  const [originalFlyerUrl, setOriginalFlyerUrl] = useState<string | null>(null);

  // Load existing program data
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const program = (await programService.getById(id)) as {
          title?: string;
          programType?: ProgramType;
          hostedBy?: string;
          period?: {
            startYear?: string;
            startMonth?: string;
            endYear?: string;
            endMonth?: string;
          };
          introduction?: string;
          flyerUrl?: string;
          zoomLink?: string;
          meetingId?: string;
          passcode?: string;
          programRoles?: ProgramRoles;
          isFree?: boolean;
          earlyBirdDeadline?: string;
          mentors?: Array<{
            userId?: unknown;
            id?: unknown;
            _id?: unknown;
            firstName?: string;
            lastName?: string;
            email?: string;
            gender?: "male" | "female";
            avatar?: string;
            roleInAtCloud?: string;
          }>;
          fullPriceTicket?: number;
          classRepDiscount?: number;
          earlyBirdDiscount?: number;
          classRepLimit?: number;
          classRepCount?: number;
        };

        if (cancelled) return;

        // Map 2-digit month codes back to full month names
        const monthCodeToName: Record<string, string> = {
          "01": "January",
          "02": "February",
          "03": "March",
          "04": "April",
          "05": "May",
          "06": "June",
          "07": "July",
          "08": "August",
          "09": "September",
          "10": "October",
          "11": "November",
          "12": "December",
        };

        // Pre-fill form with existing data
        setValue("title", program.title || "");
        setValue("programType", program.programType || "");
        setValue("hostedBy", program.hostedBy || "@Cloud Marketplace Ministry");
        setValue(
          "startYear",
          program.period?.startYear || currentYear.toString(),
        );
        setValue(
          "startMonth",
          program.period?.startMonth &&
            monthCodeToName[program.period.startMonth]
            ? monthCodeToName[program.period.startMonth]
            : program.period?.startMonth || "",
        );
        setValue("endYear", program.period?.endYear || currentYear.toString());
        setValue(
          "endMonth",
          program.period?.endMonth && monthCodeToName[program.period.endMonth]
            ? monthCodeToName[program.period.endMonth]
            : program.period?.endMonth || "",
        );
        setValue("introduction", program.introduction || "");
        setValue("flyerUrl", program.flyerUrl || "");
        setValue("zoomLink", program.zoomLink || "");
        setValue("meetingId", program.meetingId || "");
        setValue("passcode", program.passcode || "");
        setValue(
          "teacherRoleName",
          program.programRoles?.teacherRoleName || DEFAULT_TEACHER_ROLE_NAME,
        );
        setValue(
          "studentRoles",
          rolesToFormRoles({
            programRoles: program.programRoles,
            classRepDiscount: program.classRepDiscount,
            classRepLimit: program.classRepLimit,
            classRepCount: program.classRepCount,
          }),
        );
        setOriginalFlyerUrl(program.flyerUrl || null);
        // Set isFree based on backend data (convert boolean to string)
        setValue("isFree", (program.isFree ?? false) ? "true" : "false");
        if (program.earlyBirdDeadline) {
          // Keep as YYYY-MM-DD for input
          setValue(
            "earlyBirdDeadline",
            program.earlyBirdDeadline.split("T")[0],
          );
        } else {
          setValue("earlyBirdDeadline", "");
        }
        // Pricing - convert cents to dollars for display
        setValue(
          "fullPriceTicket",
          ((program.fullPriceTicket as number | undefined) ?? 0) / 100,
        );
        setValue(
          "classRepDiscount",
          ((program.classRepDiscount as number | undefined) ?? 0) / 100,
        );
        setValue(
          "earlyBirdDiscount",
          ((program.earlyBirdDiscount as number | undefined) ?? 0) / 100,
        );
        setValue(
          "classRepLimit",
          (program.classRepLimit as number | undefined) ?? 0,
        );

        // Store original pricing values for change detection (keep in cents)
        setOriginalPricing({
          isFree: program.isFree ?? false,
          fullPriceTicket: (program.fullPriceTicket as number | undefined) ?? 0,
          classRepDiscount:
            (program.classRepDiscount as number | undefined) ?? 0,
          earlyBirdDiscount:
            (program.earlyBirdDiscount as number | undefined) ?? 0,
          earlyBirdDeadline: program.earlyBirdDeadline
            ? program.earlyBirdDeadline.split("T")[0]
            : "",
          programRoles: buildProgramRolesPayload({
            teacherRoleName:
              program.programRoles?.teacherRoleName ||
              DEFAULT_TEACHER_ROLE_NAME,
            studentRoles: rolesToFormRoles({
              programRoles: program.programRoles,
              classRepDiscount: program.classRepDiscount,
              classRepLimit: program.classRepLimit,
              classRepCount: program.classRepCount,
            }),
          }),
        });

        // Transform backend mentors to frontend format
        const transformMentorFromBackend = (m: {
          userId?: unknown;
          id?: unknown;
          _id?: unknown;
          firstName?: string;
          lastName?: string;
          email?: string;
          gender?: "male" | "female";
          avatar?: string;
          roleInAtCloud?: string;
        }): Mentor | null => {
          const userId = getProgramMentorUserId(m);
          if (!userId) return null;

          return {
            id: userId,
            firstName: m.firstName || "",
            lastName: m.lastName || "",
            systemAuthorizationLevel: "Leader", // Default for mentors
            roleInAtCloud: m.roleInAtCloud,
            gender: (m.gender as "male" | "female") || "male",
            avatar: m.avatar || null,
          };
        };

        // Load unified mentors for all program types
        if (program.mentors) {
          const transformedMentors = program.mentors.map(
            transformMentorFromBackend,
          ).filter((mentor): mentor is Mentor => mentor !== null);
          setMentors(transformedMentors);
          setOriginalMentors(transformedMentors);
          // Store mentor user IDs for permission checking
          setProgramMentorIds(
            program.mentors.map(getProgramMentorUserId).filter(Boolean),
          );
        }
      } catch (error) {
        console.error("Error loading program:", error);
        alert("Failed to load program. Please try again.");
        navigate("/dashboard/programs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, setValue, navigate]);

  useEffect(() => {
    if (!id || !communityReadable) {
      setCommunitySettings(null);
      setCommunityDraft(null);
      setCommunityLoading(false);
      setCommunityError(null);
      communityRetryRef.current = null;
      return;
    }

    const controller = new AbortController();
    setCommunityLoading(true);
    setCommunityError(null);
    void programService
      .getCommunitySettings(id, controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return;
        setCommunitySettings(settings);
        setCommunityDraft(createProgramCommunitySettingsDraft(settings));
        communityRetryRef.current = null;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCommunitySettings(null);
        setCommunityDraft(null);
        setCommunityError(
          error instanceof Error
            ? error.message
            : "Failed to load Program Chat Room settings.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setCommunityLoading(false);
      });

    return () => controller.abort();
  }, [communityReadable, communityReloadSequence, id]);

  // Check if current user is the program creator
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await purchaseService.checkProgramAccess(id);
        if (cancelled) return;
        setIsCreator(result.reason === "creator");
        setIsClassRep(result.reason === "class_rep");
      } catch (error) {
        console.error("Failed to check program access:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Unified mentor change handler for all program types
  const handleMentorsChange = (newMentors: Mentor[]) => {
    setMentors(newMentors);
  };

  const handleActualSubmit = async (data: ProgramFormData) => {
    if (!id) return;
    if (runtimeConfigStatus !== "ready") return;
    if (communitySettingsUnavailable) {
      setCommunityError((current) =>
        current || "Reload Program Chat Room settings before updating this Program.",
      );
      return;
    }

    const programRoles = buildProgramRolesPayload({
      teacherRoleName: data.teacherRoleName,
      studentRoles: data.studentRoles,
    });
    let communityPayload: UpdateProgramCommunitySettingsInput | null = null;
    let saveCommunitySettings = false;
    if (communityReadable && communitySettings && communityDraft) {
      try {
        communityPayload = buildProgramCommunitySettingsInput(
          communityDraft,
          programRoles.studentRoles,
          communitySettings.revision,
        );
        saveCommunitySettings = programCommunitySettingsChanged(
          communitySettings,
          communityPayload,
        );
      } catch (error) {
        setCommunityError(
          error instanceof Error
            ? error.message
            : "Review the Program Chat Room settings.",
        );
        return;
      }
      if (saveCommunitySettings && !communityWritable) {
        if (communitySettings.enabled || communityDraft.enabled) {
          setCommunityError(
            "This active Program Chat Room must remain consistent with its student roles while settings are read-only.",
          );
          return;
        }
        communityPayload = null;
        saveCommunitySettings = false;
      }
    }

    try {
      setIsSubmitting(true);
      setCommunityError(null);
      console.log("Form data:", data);

      // Map month name (e.g., "April") to 2-digit code (e.g., "04") for API payload
      const monthNameToCode: Record<string, string> = {
        January: "01",
        February: "02",
        March: "03",
        April: "04",
        May: "05",
        June: "06",
        July: "07",
        August: "08",
        September: "09",
        October: "10",
        November: "11",
        December: "12",
      };

      const discountRole = programRoles.studentRoles.find(
        (role) => role.discountEligible,
      );

      // Prepare program payload based on program type
      const payload: ProgramUpdatePayload = {
        title: data.title,
        programType: data.programType as ProgramType,
        hostedBy: data.hostedBy,
        period: {
          startYear: data.startYear,
          startMonth:
            monthNameToCode[data.startMonth] || data.startMonth?.slice(0, 2),
          endYear: data.endYear,
          endMonth:
            monthNameToCode[data.endMonth] || data.endMonth?.slice(0, 2),
        },
        introduction: data.introduction,
        // Centralized flyer removal/replacement/no-op logic
        flyerUrl: deriveFlyerUrlForUpdate(originalFlyerUrl, data.flyerUrl),
        zoomLink: data.zoomLink,
        meetingId: data.meetingId,
        passcode: data.passcode,
        programRoles,
        isFree: data.isFree === "true",
        earlyBirdDeadline: data.earlyBirdDeadline
          ? data.earlyBirdDeadline
          : undefined,
        // Pricing from form - convert dollars to cents
        fullPriceTicket: Number.isFinite(data.fullPriceTicket as number)
          ? Math.round((data.fullPriceTicket as number) * 100)
          : 0,
        classRepDiscount: discountRole?.discountAmount ?? 0,
        earlyBirdDiscount: Number.isFinite(data.earlyBirdDiscount as number)
          ? Math.round((data.earlyBirdDiscount as number) * 100)
          : 0,
        classRepLimit: discountRole?.limit ?? 0,
      };

      // Add unified mentors for all program types
      payload.mentors = toProgramMentorPayloads(mentors);

      const programFingerprint = JSON.stringify(payload);
      const communityFingerprint = communityPayload
        ? JSON.stringify(communityPayload)
        : "";
      const programAlreadySaved =
        saveCommunitySettings &&
        partialCommunitySaveRef.current?.programFingerprint ===
          programFingerprint &&
        partialCommunitySaveRef.current?.communityFingerprint ===
          communityFingerprint;

      console.log("Updating program with payload:", payload);

      // Update the program via API
      if (!programAlreadySaved) {
        await programService.updateProgram(id, payload);
      }

      if (saveCommunitySettings && communityPayload) {
        const fingerprint = JSON.stringify(communityPayload);
        if (communityRetryRef.current?.fingerprint !== fingerprint) {
          communityRetryRef.current = {
            fingerprint,
            key: createIdempotencyKey(),
          };
        }
        try {
          const updatedSettings = await programService.updateCommunitySettings(
            id,
            communityPayload,
            communityRetryRef.current.key,
          );
          setCommunitySettings(updatedSettings);
          setCommunityDraft(
            createProgramCommunitySettingsDraft(updatedSettings),
          );
          communityRetryRef.current = null;
        } catch (error) {
          partialCommunitySaveRef.current = {
            programFingerprint,
            communityFingerprint,
          };
          setCommunityError(
            `Program details were saved, but Chat Room settings were not saved. ${
              error instanceof Error
                ? error.message
                : "Reload or retry the Chat Room settings."
            }`,
          );
          return;
        }
      }

      partialCommunitySaveRef.current = null;

      console.log("Program updated successfully");
      navigate(`/dashboard/programs/${id}`);
    } catch (error) {
      console.error("Error updating program:", error);
      // TODO: Show user-friendly error message
      alert("Failed to update program. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    navigate(`/dashboard/programs/${id}`);
  };

  // Check if user needs the restricted access overlay
  // Allow Super Admin, Administrator, program mentors, class reps, and program creator to edit
  const isAdmin =
    currentUser?.role === "Super Admin" ||
    currentUser?.role === "Administrator";
  const isMentor = currentUser?.id && programMentorIds.includes(currentUser.id);
  const shouldShowRestrictedOverlay =
    !isAdmin && !isMentor && !isClassRep && !isCreator;

  if (loading) {
    // Standardized dashboard loading: centered, fullscreen, larger spinner
    return <LoadingSpinner size="lg" />;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div
        className={`relative bg-white rounded-lg shadow-sm p-6 ${
          shouldShowRestrictedOverlay ? "bg-gray-50" : ""
        }`}
      >
        {shouldShowRestrictedOverlay && (
          <div className="absolute inset-0 z-10 bg-white/60 backdrop-blur-[1px] rounded-lg flex flex-col items-center justify-center text-center p-6">
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-8 max-w-md mx-auto">
              <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mb-4 mx-auto">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">
                Edit Program access requires authorization
              </h2>
              <p className="text-sm text-gray-600">
                To edit programs, you need Administrator, Super Admin
                privileges, be the program creator, be assigned as a mentor, or
                be a class rep for this program. Please contact your system
                administrators to request access.
              </p>
            </div>
          </div>
        )}

        <h1 className="text-2xl font-bold text-gray-900 mb-6">Edit Program</h1>

        <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
          <ProgramFormFields
            register={register}
            watch={watch}
            setValue={setValue}
            errors={errors}
            validations={validations}
            currentUser={currentUser}
            mentors={mentors}
            onMentorsChange={handleMentorsChange}
            originalFlyerUrl={originalFlyerUrl}
            YEARS={YEARS}
            MONTHS={MONTHS}
            programId={id}
          />

          {/* Tuition (Phase 3) */}
          <PricingSection
            register={register}
            watch={watch}
            setValue={setValue}
            errors={errors}
          />

          {communityReadable && (
            <ProgramCommunitySettingsSection
              settings={communitySettings}
              draft={communityDraft}
              studentRoles={currentCommunityStudentRoles}
              loading={communityLoading}
              writable={communityWritable}
              error={communityError}
              onChange={(draft) => {
                setCommunityDraft(draft);
                setCommunityError(null);
              }}
              onReload={() =>
                setCommunityReloadSequence((sequence) => sequence + 1)
              }
            />
          )}

          {runtimeConfigStatus === "error" && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              Feature settings are unavailable. Reload this page before updating
              the Program.
            </div>
          )}

          {/* Overall Validation Status */}
          <div className="mb-4">
            <ValidationIndicator
              validation={combinedValidation}
              showWhenEmpty={true}
            />
          </div>

          {/* Form Actions */}
          <div className="flex flex-col sm:flex-row gap-3 sm:justify-end pt-6">
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
              disabled={
                isSubmitting ||
                !customIsDirty ||
                runtimeConfigStatus !== "ready" ||
                (communityReadable &&
                  (communityLoading || communitySettingsUnavailable))
              }
            >
              {isSubmitting ? "Updating..." : "Update Program"}
            </button>
          </div>
        </form>
      </div>

      {/* Pricing Confirmation Modal */}
      <PricingConfirmationModal
        show={showConfirmation}
        step={confirmationStep}
        isSubmitting={isSubmitting}
        originalPricing={originalPricing}
        currentIsFree={isFreeProgram === "true"}
        currentFullPrice={fullPrice}
        currentClassRepDiscount={
          watch("studentRoles")?.find((role) => role.discountEligible)
            ?.discountAmount
        }
        currentEarlyBirdDiscount={earlyBirdDiscountValue}
        currentEarlyBirdDeadline={earlyBirdDeadline}
        currentProgramRoles={buildProgramRolesPayload({
          teacherRoleName: watch("teacherRoleName"),
          studentRoles: watch("studentRoles"),
        })}
        onNext={handleConfirmationNext}
        onCancel={handleConfirmationCancel}
      />
    </div>
  );
}
