// Pure list, safe to import from client components (no db or node imports).
// Mirrors schema.supportViewReasonEnum; the db enum is the only other copy.
export const SUPPORT_VIEW_REASONS = ["support_ticket", "billing_dispute", "other"] as const;
export type SupportViewReason = (typeof SUPPORT_VIEW_REASONS)[number];
