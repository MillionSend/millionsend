import type { schema } from "@millionsend/db";

export type TeamRole = (typeof schema.teamMemberRoleEnum.enumValues)[number];

/**
 * The dashboard's adminProcedure line: owners and admins manage, members
 * read. An allow-list, so a role added later is refused until admitted here.
 * No runtime imports, so the dashboard's client components share it.
 */
export const isAdminRole = (role: string | null | undefined): boolean =>
  role === "owner" || role === "admin";
