/**
 * useProgramCreation Hook
 *
 * Custom hook that encapsulates program creation logic including:
 * - Form submission handling
 * - Month name to code conversion
 * - Mentor data transformation
 * - Payload preparation with pricing conversions
 * - API calls and error handling
 * - Navigation after success
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { programService } from "../services/api";
import {
  toProgramMentorPayloads,
  type ProgramMentorPayload,
} from "../utils/programMentorPayload";
import type { ProgramRoles, ProgramStudentRoleForm } from "../types/program";
import { buildProgramRolesPayload } from "../utils/programRoles";

interface Mentor {
  id: string;
  firstName: string;
  lastName: string;
  systemAuthorizationLevel: string;
  roleInAtCloud?: string;
  gender: "male" | "female";
  avatar: string | null;
}

type ProgramPayload = {
  programType: string;
  title: string;
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
  earlyBirdDeadline?: string;
  isFree?: boolean;
  programRoles?: ProgramRoles;
  mentors?: ProgramMentorPayload[];
  fullPriceTicket: number;
  classRepDiscount?: number;
  classRepLimit?: number;
  earlyBirdDiscount?: number;
};

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
  earlyBirdDeadline?: string;
  isFree?: string;
  fullPriceTicket: number | undefined;
  classRepDiscount?: number | undefined;
  classRepLimit?: number | undefined;
  earlyBirdDiscount?: number | undefined;
}

// Map month names to 2-digit codes
const MONTH_NAME_TO_CODE: Record<string, string> = {
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

/**
 * Custom hook for program creation
 */
export function useProgramCreation() {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Submit program creation form
   */
  const createProgram = async (
    data: ProgramFormData,
    mentors: Mentor[]
  ): Promise<void> => {
    try {
      setIsSubmitting(true);

      // Prepare program payload
      const programRoles = buildProgramRolesPayload({
        teacherRoleName: data.teacherRoleName,
        studentRoles: data.studentRoles,
      });
      const discountRole = programRoles.studentRoles.find(
        (role) => role.discountEligible
      );
      const payload: ProgramPayload = {
        title: data.title,
        programType: data.programType,
        hostedBy: data.hostedBy,
        period: {
          startYear: data.startYear,
          startMonth:
            MONTH_NAME_TO_CODE[data.startMonth] || data.startMonth?.slice(0, 2),
          endYear: data.endYear,
          endMonth:
            MONTH_NAME_TO_CODE[data.endMonth] || data.endMonth?.slice(0, 2),
        },
        introduction: data.introduction,
        flyerUrl: data.flyerUrl,
        zoomLink: data.zoomLink,
        meetingId: data.meetingId,
        passcode: data.passcode,
        programRoles,
        earlyBirdDeadline: data.earlyBirdDeadline
          ? data.earlyBirdDeadline
          : undefined,
        isFree: data.isFree === "true",
        // Pricing from form - convert dollars to cents
        fullPriceTicket: Number.isFinite(data.fullPriceTicket as number)
          ? Math.round((data.fullPriceTicket as number) * 100)
          : 0,
        classRepDiscount: discountRole?.discountAmount ?? 0,
        classRepLimit: discountRole?.limit ?? 0,
        earlyBirdDiscount: Number.isFinite(data.earlyBirdDiscount as number)
          ? Math.round((data.earlyBirdDiscount as number) * 100)
          : 0,
      };

      // Add unified mentors for all program types
      payload.mentors = toProgramMentorPayloads(mentors);

      // Create the program via API
      await programService.createProgram(payload);

      navigate("/dashboard/programs");
    } catch (error) {
      console.error("Error creating program:", error);
      // TODO: Show user-friendly error message
      alert("Failed to create program. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Cancel program creation
   */
  const cancelCreation = () => {
    navigate("/dashboard/programs");
  };

  return {
    isSubmitting,
    createProgram,
    cancelCreation,
  };
}
