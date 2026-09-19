import type { UseFormRegister, FieldErrors } from "react-hook-form";

interface BaseInputProps<
  TForm extends Record<string, unknown> = Record<string, unknown>
> {
  label: string;
  name: string;
  register: UseFormRegister<TForm>;
  errors: FieldErrors<TForm>;
  placeholder?: string;
  required?: boolean;
  className?: string;
  disabled?: boolean;
  helperText?: string;
}

// Enhanced FormField with better styling
interface FormFieldProps<
  TForm extends Record<string, unknown> = Record<string, unknown>
> extends BaseInputProps<TForm> {
  type?: "text" | "email" | "tel" | "url" | "number";
}

export function FormField<
  TForm extends Record<string, unknown> = Record<string, unknown>
>({
  label,
  name,
  register,
  errors,
  type = "text",
  placeholder,
  required = false,
  className = "",
  disabled = false,
  helperText,
}: FormFieldProps<TForm>) {
  const errorId = `${name}-error`;
  const helperId = `${name}-helper`;
  const hasError = Boolean((errors as Record<string, unknown>)[name]);

  return (
    <div className={className}>
      <label
        htmlFor={name}
        className="block text-sm font-medium text-gray-700 mb-2"
      >
        {label}{" "}
        {required && (
          <>
            <span aria-hidden="true" className="text-red-600">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      <input
        {...register(name as unknown as Parameters<typeof register>[0])}
        id={name}
        type={type}
        disabled={disabled}
        required={required}
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : helperText ? helperId : undefined}
        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors ${
          disabled ? "bg-gray-50 text-gray-500 cursor-not-allowed" : "bg-white"
        } ${
          (errors as Record<string, unknown>)[name]
            ? "border-red-500 focus:ring-red-500"
            : "border-gray-500"
        }`}
        placeholder={placeholder}
      />
      {helperText && !(errors as Record<string, unknown>)[name] && (
        <p id={helperId} className="mt-1 text-sm text-gray-500">
          {helperText}
        </p>
      )}
      {typeof (errors as Record<string, { message?: unknown }>)[name]
        ?.message === "string" && (
        <p id={errorId} className="mt-1 text-sm text-red-700" role="alert">
          {
            (errors as Record<string, { message?: unknown }>)[name]
              ?.message as string
          }
        </p>
      )}
    </div>
  );
}

// Enhanced TextareaField
interface TextareaFieldProps<
  TForm extends Record<string, unknown> = Record<string, unknown>
> extends BaseInputProps<TForm> {
  rows?: number;
}

export function TextareaField<
  TForm extends Record<string, unknown> = Record<string, unknown>
>({
  label,
  name,
  register,
  errors,
  placeholder,
  required = false,
  className = "",
  disabled = false,
  helperText,
  rows = 3,
}: TextareaFieldProps<TForm>) {
  const errorId = `${name}-error`;
  const helperId = `${name}-helper`;
  const hasError = Boolean((errors as Record<string, unknown>)[name]);

  return (
    <div className={className}>
      <label
        htmlFor={name}
        className="block text-sm font-medium text-gray-700 mb-2"
      >
        {label}{" "}
        {required && (
          <>
            <span aria-hidden="true" className="text-red-600">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      <textarea
        {...register(name as unknown as Parameters<typeof register>[0])}
        id={name}
        rows={rows}
        disabled={disabled}
        required={required}
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : helperText ? helperId : undefined}
        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors resize-vertical ${
          disabled ? "bg-gray-50 text-gray-500 cursor-not-allowed" : "bg-white"
        } ${
          (errors as Record<string, unknown>)[name]
            ? "border-red-500 focus:ring-red-500"
            : "border-gray-500"
        }`}
        placeholder={placeholder}
      />
      {helperText && !(errors as Record<string, unknown>)[name] && (
        <p id={helperId} className="mt-1 text-sm text-gray-500">
          {helperText}
        </p>
      )}
      {typeof (errors as Record<string, { message?: unknown }>)[name]
        ?.message === "string" && (
        <p id={errorId} className="mt-1 text-sm text-red-700" role="alert">
          {
            (errors as Record<string, { message?: unknown }>)[name]
              ?.message as string
          }
        </p>
      )}
    </div>
  );
}

// Enhanced SelectField
interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps<
  TForm extends Record<string, unknown> = Record<string, unknown>
> extends BaseInputProps<TForm> {
  options: readonly SelectOption[];
}

export function SelectField<
  TForm extends Record<string, unknown> = Record<string, unknown>
>({
  label,
  name,
  register,
  errors,
  placeholder = "Select an option",
  required = false,
  className = "",
  disabled = false,
  helperText,
  options,
}: SelectFieldProps<TForm>) {
  const hasEmptyOption = options.some((o) => o.value === "");
  const errorId = `${name}-error`;
  const helperId = `${name}-helper`;
  const hasError = Boolean(errors[name]);

  return (
    <div className={className}>
      <label
        htmlFor={name}
        className="block text-sm font-medium text-gray-700 mb-2"
      >
        {label}{" "}
        {required && (
          <>
            <span aria-hidden="true" className="text-red-600">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      <select
        {...register(name as unknown as Parameters<typeof register>[0])}
        id={name}
        disabled={disabled}
        required={required}
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : helperText ? helperId : undefined}
        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors invalid:text-gray-600 ${
          disabled ? "bg-gray-50 text-gray-500 cursor-not-allowed" : "bg-white"
        } ${
          (errors as Record<string, unknown>)[name]
            ? "border-red-500 focus:ring-red-500"
            : "border-gray-500"
        }`}
      >
        {!hasEmptyOption && (
          <option value="" disabled className="text-gray-600">
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {helperText && !errors[name] && (
        <p id={helperId} className="mt-1 text-sm text-gray-500">
          {helperText}
        </p>
      )}
      {typeof errors[name]?.message === "string" && (
        <p id={errorId} className="mt-1 text-sm text-red-700" role="alert">
          {errors[name]?.message}
        </p>
      )}
    </div>
  );
}
