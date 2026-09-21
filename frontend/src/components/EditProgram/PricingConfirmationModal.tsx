import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useAccessibleDialog } from "../../hooks/useAccessibleDialog";
import { formatCurrency } from "../../utils/currency";
import type { ProgramRoles } from "../../types/program";

interface PricingChange {
  isFree?: boolean;
  fullPriceTicket?: number;
  classRepDiscount?: number;
  earlyBirdDiscount?: number;
  earlyBirdDeadline?: string;
  programRoles?: ProgramRoles;
}

interface PricingConfirmationModalProps {
  show: boolean;
  step: number;
  isSubmitting: boolean;
  originalPricing: PricingChange;
  currentIsFree: boolean;
  currentFullPrice: number | undefined;
  currentClassRepDiscount: number | undefined;
  currentEarlyBirdDiscount: number | undefined;
  currentEarlyBirdDeadline?: string;
  currentProgramRoles?: ProgramRoles;
  onNext: () => void;
  onCancel: () => void;
}

export default function PricingConfirmationModal({
  show,
  step,
  isSubmitting,
  originalPricing,
  currentIsFree,
  currentFullPrice,
  currentClassRepDiscount,
  currentEarlyBirdDiscount,
  currentEarlyBirdDeadline,
  currentProgramRoles,
  onNext,
  onCancel,
}: PricingConfirmationModalProps) {
  const descriptionId = useId();
  const closeDialog = () => {
    if (!isSubmitting) onCancel();
  };
  const dialogRef = useAccessibleDialog(show, closeDialog);

  useEffect(() => {
    if (!show) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialogRef, show, step]);

  if (!show) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center">
        {/* Background overlay */}
        <div
          aria-hidden="true"
          className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
          onClick={closeDialog}
        ></div>

        {/* Modal panel */}
        <div
          role="dialog"
          aria-busy={isSubmitting}
          aria-describedby={descriptionId}
          aria-modal="true"
          aria-labelledby={
            step === 1 ? "pricing-confirmation-title" : "pricing-final-title"
          }
          className="relative inline-block bg-white rounded-lg px-4 pt-5 pb-4 text-left overflow-hidden shadow-xl transform transition-all max-w-lg w-full mx-4 sm:p-6"
          ref={dialogRef}
          tabIndex={-1}
        >
          {step === 1 ? (
            <>
              <div className="sm:flex sm:items-start">
                <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-yellow-100 sm:mx-0 sm:h-10 sm:w-10">
                  <svg
                    aria-hidden="true"
                    className="h-6 w-6 text-yellow-700"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.12 16.5c-.77.833.192 2.5 1.732 2.5z"
                    />
                  </svg>
                </div>
                <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                  <h3
                    id="pricing-confirmation-title"
                    className="text-lg leading-6 font-medium text-gray-900"
                  >
                    Tuition Changes Detected
                  </h3>
                  <div className="mt-2">
                    <p className="text-sm text-gray-700" id={descriptionId}>
                      You have made changes to the program's tuition section.
                      This will affect how participants are charged for this
                      program.
                    </p>
                    <div className="mt-3 p-3 bg-gray-50 rounded-md">
                      <h4 className="text-sm font-medium text-gray-900 mb-2">
                        Changes detected:
                      </h4>
                      <ul className="text-sm text-gray-600 space-y-1">
                        {originalPricing.isFree !== currentIsFree && (
                          <li>
                            • Program type:{" "}
                            {originalPricing.isFree ? "Free" : "Paid"} →{" "}
                            {currentIsFree ? "Free" : "Paid"}
                          </li>
                        )}
                        {originalPricing.fullPriceTicket !==
                          Math.round((currentFullPrice ?? 0) * 100) && (
                          <li>
                            • Full price:{" "}
                            {formatCurrency(
                              originalPricing.fullPriceTicket || 0
                            )}{" "}
                            → {formatCurrency((currentFullPrice ?? 0) * 100)}
                          </li>
                        )}
                        {originalPricing.classRepDiscount !==
                          Math.round((currentClassRepDiscount ?? 0) * 100) && (
                          <li>
                            • Student role discount:{" "}
                            {formatCurrency(
                              originalPricing.classRepDiscount || 0
                            )}{" "}
                            →{" "}
                            {formatCurrency(
                              (currentClassRepDiscount ?? 0) * 100
                            )}
                          </li>
                        )}
                        {originalPricing.earlyBirdDiscount !==
                          Math.round((currentEarlyBirdDiscount ?? 0) * 100) && (
                          <li>
                            • Early bird discount:{" "}
                            {formatCurrency(
                              originalPricing.earlyBirdDiscount || 0
                            )}{" "}
                            →{" "}
                            {formatCurrency(
                              (currentEarlyBirdDiscount ?? 0) * 100
                            )}
                          </li>
                        )}
                        {originalPricing.earlyBirdDeadline !==
                          (currentEarlyBirdDeadline ?? "") && (
                          <li>
                            • Early bird deadline:{" "}
                            {originalPricing.earlyBirdDeadline || "None"} →{" "}
                            {currentEarlyBirdDeadline || "None"}
                          </li>
                        )}
                        {JSON.stringify(originalPricing.programRoles) !==
                          JSON.stringify(currentProgramRoles) && (
                          <li>• Student role settings changed</li>
                        )}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  className="min-h-11 w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-yellow-700 text-base font-medium text-white hover:bg-yellow-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-600 sm:ml-3 sm:w-auto sm:text-sm"
                  onClick={onNext}
                >
                  Continue
                </button>
                <button
                  type="button"
                  className="mt-3 min-h-11 w-full inline-flex justify-center rounded-md border border-gray-500 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-600 sm:mt-0 sm:w-auto sm:text-sm"
                  data-dialog-initial-focus
                  onClick={closeDialog}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="sm:flex sm:items-start">
                <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                  <svg
                    aria-hidden="true"
                    className="h-6 w-6 text-red-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.12 16.5c-.77.833.192 2.5 1.732 2.5z"
                    />
                  </svg>
                </div>
                <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                  <h3
                    id="pricing-final-title"
                    className="text-lg leading-6 font-medium text-gray-900"
                  >
                    Final Confirmation
                  </h3>
                  <div className="mt-2">
                    <p className="text-sm text-gray-700" id={descriptionId}>
                      Are you absolutely sure you want to update the tuition for
                      this program? This action cannot be undone and will
                      immediately affect all future registrations.
                    </p>
                    <div className="mt-3 p-3 bg-red-50 rounded-md">
                      <p className="text-sm font-medium text-red-800">
                        ⚠️ This will change how participants are charged
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  className="min-h-11 w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-700 text-base font-medium text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-600 sm:ml-3 sm:w-auto sm:text-sm"
                  onClick={onNext}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Updating..." : "Yes, Update Tuition"}
                </button>
                <button
                  type="button"
                  className="mt-3 min-h-11 w-full inline-flex justify-center rounded-md border border-gray-500 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-600 sm:mt-0 sm:w-auto sm:text-sm"
                  data-dialog-initial-focus
                  onClick={closeDialog}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
