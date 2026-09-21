import { body, param, query, validationResult } from "express-validator";
import { Request, Response, NextFunction } from "express";
import { ROLES } from "../utils/roleUtils";

// Middleware to handle validation errors
export const handleValidationErrors = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Emit detailed validation diagnostics in test environment when explicitly enabled
    if (
      process.env.NODE_ENV === "test" &&
      process.env.TEST_VALIDATION_LOG === "1"
    ) {
      try {
        // Avoid logging potentially large bodies; pick key fields when available
        const payloadPreview: Record<string, unknown> = {};
        const keysToPeek = [
          "title",
          "type",
          "date",
          "endDate",
          "time",
          "endTime",
          "location",
          "format",
          "purpose",
          "agenda",
          "organizer",
        ];
        for (const k of keysToPeek) {
          if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
            payloadPreview[k] = (req.body as Record<string, unknown>)[k];
          }
        }
        const bodyAny = req.body as unknown;
        if (
          bodyAny &&
          typeof bodyAny === "object" &&
          Array.isArray((bodyAny as { roles?: unknown[] }).roles)
        ) {
          const roles = (bodyAny as { roles: unknown[] }).roles;
          (payloadPreview as Record<string, unknown>).roles = roles.map((r) => {
            const role = r as Record<string, unknown>;
            const desc = role.description;
            return {
              name: role.name as unknown as string | undefined,
              maxParticipants: role.maxParticipants as unknown as
                | number
                | undefined,
              descriptionLen:
                typeof desc === "string" ? (desc as string).length : 0,
            };
          });
        }
        console.error(
          "[VALIDATION]",
          req.method,
          req.originalUrl,
          JSON.stringify({ payloadPreview, errors: errors.array() }, null, 2),
        );
      } catch {
        // ignore logging errors
      }
    }
    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array(),
    });
    return;
  }
  next();
};

// User validation rules
export const validateUserRegistration = [
  body("username")
    .isLength({ min: 3, max: 20 })
    .withMessage("Username must be between 3 and 20 characters")
    .custom((value) => {
      if (typeof value !== "string") throw new Error("Invalid username");
      // Option C rules
      if (value !== value.toLowerCase())
        throw new Error("Username must be lowercase");
      if (!/^[a-z]/.test(value))
        throw new Error("Username must start with a letter");
      if (!/^[a-z0-9_]+$/.test(value))
        throw new Error(
          "Username can only contain lowercase letters, numbers, and underscores",
        );
      if (/__/.test(value))
        throw new Error("Username cannot contain consecutive underscores");
      if (/^_|_$/.test(value))
        throw new Error("Username cannot start or end with an underscore");
      const reserved = new Set([
        // Keep a minimal reserved set to avoid clashing with system routes.
        "root",
        "system",
        "support",
        "help",
        "staff",
        "moderator",
        "owner",
        "api",
        "auth",
        "cloud",
        "jesus",
        "god",
        "null",
        "undefined",
      ]);
      if (reserved.has(value)) {
        throw new Error("This username is reserved. Please choose another.");
      }
      return true;
    }),

  body("email").isEmail().withMessage("Please provide a valid email address"),

  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters long")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d@$!%*?&]/)
    .withMessage(
      "Password must contain at least one uppercase letter, one lowercase letter, and one number",
    ),

  body("firstName")
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage("First name is required and must be less than 50 characters"),

  body("lastName")
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage("Last name is required and must be less than 50 characters"),

  body("gender")
    .notEmpty()
    .withMessage("Gender is required")
    .isIn(["male", "female"])
    .withMessage("Gender must be either 'male' or 'female'"),

  body("isAtCloudLeader")
    .isBoolean()
    .withMessage("isAtCloudLeader must be a boolean value"),

  body("roleInAtCloud")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Role in @Cloud must be less than 100 characters"),

  body("acceptTerms")
    .custom((value) => value === true)
    .withMessage("The registration privacy notice must be accepted"),

  body("registrationNoticeVersion")
    .isString()
    .isLength({ min: 1, max: 80 })
    .withMessage("registrationNoticeVersion is invalid"),

  handleValidationErrors,
];

export const validateUserLogin = [
  body("emailOrUsername")
    .trim()
    .isLength({ min: 3 })
    .withMessage("Username or email is required"),

  body("password").isLength({ min: 1 }).withMessage("Password is required"),

  handleValidationErrors,
];

export const validateUserUpdate = [
  body("firstName")
    .optional()
    .trim()
    .custom((value) => {
      if (value === "") return true; // Allow empty string
      if (value.length < 1 || value.length > 50) {
        throw new Error("First name must be between 1 and 50 characters");
      }
      return true;
    }),

  body("lastName")
    .optional()
    .trim()
    .custom((value) => {
      if (value === "") return true; // Allow empty string
      if (value.length < 1 || value.length > 50) {
        throw new Error("Last name must be between 1 and 50 characters");
      }
      return true;
    }),

  // Remove email validation for profile updates - email changes should be handled separately

  body("phone")
    .optional()
    .trim()
    .custom((value) => {
      if (!value || value === "") return true; // Allow empty string
      // More flexible phone validation - allow various formats
      const cleanPhone = value.replace(/[\s()+-]/g, "");
      if (!/^\d{7,15}$/.test(cleanPhone)) {
        throw new Error("Please provide a valid phone number");
      }
      return true;
    }),

  body("gender")
    .optional()
    .custom((value) => {
      if (!value || value === "") return true; // Allow empty string
      if (!["male", "female"].includes(value)) {
        throw new Error("Gender must be either 'male' or 'female'");
      }
      return true;
    }),

  // Add validation for other profile fields
  body("occupation")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Occupation must be less than 100 characters"),

  body("company")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Company must be less than 100 characters"),

  body("weeklyChurch")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Weekly church must be less than 100 characters"),

  body("roleInAtCloud")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Role in @Cloud must be less than 100 characters"),

  body("isAtCloudLeader")
    .optional()
    .isBoolean()
    .withMessage("isAtCloudLeader must be a boolean value"),

  handleValidationErrors,
];

// Event validation rules
export const validateEventCreation = [
  body("title")
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage("Event title must be between 3 and 200 characters"),

  body("description")
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage("Description must be less than 1000 characters"),

  body("date").isISO8601().toDate().withMessage("Please provide a valid date"),

  body("time")
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage("Time must be in HH:MM format"),

  body("endTime")
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage("End time must be in HH:MM format"),

  body("location")
    .optional()
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage("Location must be between 3 and 200 characters"),

  body("type")
    .trim()
    .isIn([
      "Conference",
      "Webinar",
      "Effective Communication Workshop",
      "Mentor Circle",
      "Meeting",
      "Office Hour",
      "Hangout",
    ])
    .withMessage(
      "Event type must be one of: Conference, Webinar, Effective Communication Workshop, Mentor Circle, Meeting, Office Hour, Hangout",
    ),

  body("format")
    .isIn(["In-person", "Online", "Hybrid Participation"])
    .withMessage(
      "Format must be 'In-person', 'Online', or 'Hybrid Participation'",
    ),

  body("purpose")
    .optional({ values: "falsy" })
    .trim()
    .custom((value) => {
      // Allow undefined, null, empty string. If provided non-empty, enforce length.
      if (!value || String(value).trim() === "") return true;
      const len = String(value).trim().length;
      if (len < 10 || len > 1000) {
        throw new Error("Purpose must be between 10 and 1000 characters");
      }
      return true;
    }),

  // Agenda is optional; if provided (non-empty after trim) must meet length requirements
  body("agenda")
    .optional({ values: "falsy" })
    .trim()
    .custom((value) => {
      if (!value || String(value).trim() === "") return true; // allow omitted / empty
      const len = String(value).trim().length;
      if (len < 20 || len > 2000) {
        throw new Error("Agenda must be between 20 and 2000 characters");
      }
      return true;
    }),

  body("organizer")
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage("Organizer must be between 3 and 200 characters"),

  body("roles")
    .isArray({ min: 1 })
    .withMessage("Event must have at least one role"),

  body("roles.*.name")
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Role name must be between 2 and 100 characters"),

  body("roles.*.maxParticipants")
    .isInt({ min: 1, max: 100 })
    .withMessage("Max participants must be between 1 and 100"),

  // Optional fields with conditional validation
  body("zoomLink")
    .optional({ values: "falsy" }) // This allows empty strings, null, undefined
    .custom((value) => {
      // If value exists and is not empty, validate as URL
      if (value && value.trim() !== "") {
        const urlRegex = /^https?:\/\/.+/;
        if (!urlRegex.test(value)) {
          throw new Error(
            "Zoom link must be a valid URL starting with http:// or https://",
          );
        }
      }
      return true;
    }),

  body("meetingId")
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Meeting ID cannot exceed 50 characters"),

  body("passcode")
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Passcode cannot exceed 50 characters"),

  // Optional flyer URL (accept /uploads/* or absolute http(s) URLs)
  body("flyerUrl")
    .optional({ values: "falsy" })
    .custom((value) => {
      if (value === undefined || value === null || value === "") return true;
      const v = String(value).trim();
      if (!v) return true;
      if (/^https?:\/\//.test(v)) return true;
      if (v.startsWith("/uploads/")) return true;
      throw new Error(
        "Flyer URL must be an absolute http(s) URL or a path starting with /uploads/",
      );
    }),

  handleValidationErrors,
];

// Search validation rules
export const validateSearch = [
  query("q")
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Search query must be between 2 and 100 characters"),

  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer"),

  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("Limit must be between 1 and 100"),

  handleValidationErrors,
];

// Parameter validation rules
export const validateObjectId = [
  param("id").isMongoId().withMessage("Invalid ID format"),

  handleValidationErrors,
];

// Password reset validation
export const validateForgotPassword = [
  body("email").isEmail().withMessage("Valid email is required"),
];

export const validateResetPassword = [
  body("token").notEmpty().withMessage("Reset token is required"),

  body("newPassword")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters long")
    .matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage(
      "Password must contain at least one lowercase letter, one uppercase letter, and one number",
    ),
];

// System Message validation rules
export const validateSystemMessage = [
  body("title")
    .trim()
    .isLength({ min: 5, max: 200 })
    .withMessage("System message title must be between 5 and 200 characters"),

  body("content")
    .trim()
    .isLength({ min: 5, max: 3500 })
    .withMessage(
      "System message content must be between 5 and 3500 characters",
    ),

  body("type")
    .isIn([
      "announcement",
      "maintenance",
      "update",
      "warning",
      "auth_level_change",
    ])
    .withMessage("Invalid system message type"),

  body("priority")
    .optional()
    .isIn(["low", "medium", "high"])
    .withMessage("Priority must be low, medium, or high"),

  body("targetRoles")
    .optional({ values: "undefined" })
    .isArray({ min: 1, max: Object.values(ROLES).length })
    .withMessage("targetRoles must be a non-empty array of valid roles"),
  body("targetRoles.*")
    .optional({ values: "undefined" })
    .isIn(Object.values(ROLES))
    .withMessage("targetRoles contains an invalid role"),

  body("excludeUserIds")
    .optional({ values: "undefined" })
    .isArray()
    .withMessage("excludeUserIds must be an array of valid user IDs"),
  body("excludeUserIds.*")
    .optional({ values: "undefined" })
    .isMongoId()
    .withMessage("excludeUserIds contains an invalid user ID"),

  body("expiresAt")
    .optional()
    .isISO8601()
    .withMessage("Expiration date must be a valid ISO date")
    .custom((value) => {
      if (value && new Date(value) <= new Date()) {
        throw new Error("Expiration date must be in the future");
      }
      return true;
    }),

  // Presentation flags
  body("includeCreator")
    .optional()
    .isBoolean()
    .withMessage("includeCreator must be a boolean"),
  body("hideCreator")
    .optional()
    .isBoolean()
    .withMessage("hideCreator must be a boolean"),

  handleValidationErrors,
];

// Alias for handleValidationErrors
export const validateError = handleValidationErrors;
