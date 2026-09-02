/** Contact subscription states the list filter and CSV export accept. */
export const CONTACT_STATUSES = ["subscribed", "unsubscribed"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];
