// Sign up form field options
export const GENDER_OPTIONS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
] as const;

export const AT_CLOUD_LEADER_OPTIONS = [
  { value: "false", label: "No, I'm a Regular Participant" },
  { value: "true", label: "Yes, I'm an @Cloud Co-worker" },
] as const;

// Form section titles and descriptions
export const FORM_SECTIONS = {
  account: {
    title: "Account Information",
    description: "Create your login credentials",
  },
  personal: {
    title: "Personal Information",
    description: "Tell us about yourself",
  },
  contact: {
    title: "Contact and Residence",
    description: "How we can reach you and where you live",
  },
  ministry: {
    title: "Ministry Information",
    description: "Your role and involvement",
  },
  optional: {
    title: "Work and Community",
    description: "Your current work status and optional church information",
  },
} as const;

// Form validation messages
export const VALIDATION_MESSAGES = {
  passwordMismatch: "Passwords must match",
  emailInvalid: "Please enter a valid email address",
  phoneInvalid: "Please enter a valid phone number",
  usernameRequired: "Username is required",
  passwordRequired: "Password is required",
} as const;

// Co-worker request notification text (label kept for compatibility)
export const LEADER_ROLE_NOTIFICATION =
  "Note: By selecting 'Yes', you're requesting @Cloud Co-worker privileges. The Owner will review your request and may contact you for verification.";
