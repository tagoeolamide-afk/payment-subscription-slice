/**
 * Reasons offered in the optional prompt after cancelling. The code is what's stored in
 * subscriptions.cancellation_reason; the label is what the customer sees.
 */
export const CANCELLATION_REASONS = [
  { code: "too_expensive", label: "Too expensive" },
  { code: "not_using_enough", label: "Not using it enough" },
  { code: "missing_features", label: "Missing features I need" },
  { code: "switching_product", label: "Switching to another product" },
  { code: "technical_problems", label: "Technical problems" },
  { code: "temporary_break", label: "Just taking a break" },
  { code: "other", label: "Other" },
] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number]["code"];

export const CANCELLATION_NOTE_MAX = 500;

export function isCancellationReason(value: unknown): value is CancellationReason {
  return CANCELLATION_REASONS.some((r) => r.code === value);
}

/** Trimmed, length-capped note; empty becomes null. */
export function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim().slice(0, CANCELLATION_NOTE_MAX);
  return note || null;
}
