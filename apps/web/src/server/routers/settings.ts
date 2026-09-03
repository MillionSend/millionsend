import { cancelTeamSubscription } from "@millionsend/billing";
import { env, notificationsEmailFrom } from "@millionsend/config";
import {
  createFixedWindowLimiter,
  DAY_MS,
  effectivePlan,
  INVITE_EMAILS_PER_HOUR,
  INVITE_MAX_SENDS,
  INVITE_RESEND_COOLDOWN_MS,
  INVITE_TTL_MS,
  PLAN_DAILY_LIMIT,
  type Plan,
  signInviteToken,
  utcDay,
  verifyInviteToken,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import {
  createSesv2Client,
  deleteDomainIdentity,
  deleteTenant,
  disassociateIdentity,
  SES_REGIONS,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gt, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { isHexColor } from "@/lib/hex-color";
import { isHttpUrl } from "@/lib/http-url";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { getStripe } from "../billing";
import { activeLocale } from "../locale";
import { smtpRelayOffered } from "../smtp";
import { deletePublicObject, keyFromPublicUrl, uploadsEnabled } from "../storage";
import {
  awsCredentialsConfigured,
  buildInvitationEmail,
  defaultSystemMailDeps,
  type SystemMailDeps,
} from "../system-mail";
import { protectedProcedure, publicProcedure, router, teamProcedure } from "../trpc";

/**
 * The API enforces plan caps only when IS_CLOUD; self-host has no daily
 * quota, so the dashboard must report none. env is read lazily (per call)
 * so tests can construct the environment first.
 */
function planDailyLimit(plan: Plan): number | null {
  return env.IS_CLOUD ? PLAN_DAILY_LIMIT[plan] : null;
}

/** Managing members is an owner/admin concern; plain members are read-only. */
function assertCanManageMembers(role: string): void {
  if (role !== "owner" && role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
}

/**
 * External side effects of deleting a team, injectable so tests can observe
 * them without AWS/Stripe. The Stripe cancel runs before the rows go (it
 * reads the team's subscription id); SES and storage cleanup are best-effort
 * after commit.
 */
export interface TeamDeletionDeps {
  cancelSubscription(db: Db, teamId: string): Promise<void>;
  /** `tenant` set = the identity is associated with the team's SES tenant and must be detached first. */
  deleteSesIdentity(domain: {
    name: string;
    region: string;
    tenant?: string | undefined;
  }): Promise<void>;
  /** Drops the team's SES tenant in one region; a tenant already gone is fine. */
  deleteSesTenant(params: { tenantName: string; region: string }): Promise<void>;
  deleteLogo(logoUrl: string): Promise<void>;
}

// Identities live in the domain's region, which may differ from AWS_REGION.
const sesClientFor = (region: string) =>
  createSesv2Client({
    region,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : {}),
  });

const defaultTeamDeletionDeps: TeamDeletionDeps = {
  cancelSubscription: (db, teamId) => cancelTeamSubscription({ stripe: getStripe(), db }, teamId),
  deleteSesIdentity: async ({ name, region, tenant }) => {
    const client = sesClientFor(region);
    if (tenant) await disassociateIdentity(client, { tenantName: tenant, region, identity: name });
    await deleteDomainIdentity(client, { domain: name });
  },
  deleteSesTenant: ({ tenantName, region }) => deleteTenant(sesClientFor(region), { tenantName }),
  deleteLogo: async (logoUrl) => {
    const key = keyFromPublicUrl(logoUrl);
    if (key) await deletePublicObject(key);
  },
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Drops the OAuth grants (and the tokens behind them) bound to a team — for
 * one user when given, else for everyone. All-teams grants are left alone:
 * the auth layer re-checks membership on every token refresh.
 */
async function revokeTeamGrants(tx: Tx, teamId: string, userId?: string): Promise<void> {
  const scope = (
    table:
      | typeof schema.oauthAccessToken
      | typeof schema.oauthRefreshToken
      | typeof schema.oauthConsent,
  ) => and(eq(table.referenceId, teamId), userId ? eq(table.userId, userId) : undefined);
  await tx.delete(schema.oauthAccessToken).where(scope(schema.oauthAccessToken));
  await tx.delete(schema.oauthRefreshToken).where(scope(schema.oauthRefreshToken));
  await tx.delete(schema.oauthConsent).where(scope(schema.oauthConsent));
}

async function findMembership(db: Db | Tx, teamId: string, userId: string) {
  const [row] = await db
    .select({ id: schema.teamMembers.id, role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
  return row ?? null;
}

/** A team must always keep an owner, or nobody could manage or delete it. */
async function assertAnotherOwner(db: Db | Tx, teamId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.teamId, teamId),
        eq(schema.teamMembers.role, "owner"),
        ne(schema.teamMembers.userId, userId),
      ),
    );
  if (!row || row.n === 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The team needs an owner." });
  }
}

async function removeMembership(db: Db, teamId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
    await revokeTeamGrants(tx, teamId, userId);
  });
}

function requireAuthSecret(): string {
  if (!env.BETTER_AUTH_SECRET) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "BETTER_AUTH_SECRET is required",
    });
  }
  return env.BETTER_AUTH_SECRET;
}

function inviteAcceptUrl(inviteId: string): string {
  return `${resolveBaseUrl(env.APP_BASE_URL)}/invite/${signInviteToken(inviteId, requireAuthSecret())}`;
}

/** `h***@example.com`: enough for the invitee to recognise, useless to anyone else. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at <= 0 ? "***" : `${email[0]}***${email.slice(at)}`;
}

/** Invite emails need SES reach and a system sender; without both the link is the only credential. */
function inviteEmailsEnabled(): boolean {
  return awsCredentialsConfigured() && Boolean(notificationsEmailFrom());
}

// Invite spam guard shared by create and resend, keyed by team.
const inviteEmailsLimited = createFixedWindowLimiter(INVITE_EMAILS_PER_HOUR, 3_600_000);

const INVITE_HOURLY_LIMIT_ERROR = new TRPCError({
  code: "TOO_MANY_REQUESTS",
  message: "Too many invitations this hour. Try again later.",
});

/**
 * Hostname a self-hoster points their app's SMTP client at: an explicit
 * override, else the deployment's own APP_BASE_URL host (the relay runs
 * inside the same deployment), else localhost for the quickstart.
 */
function smtpPublicHost(): string {
  if (env.SMTP_PUBLIC_HOST) return env.SMTP_PUBLIC_HOST;
  return new URL(resolveBaseUrl(env.APP_BASE_URL)).hostname;
}

/** Literal shown in the SMTP tab's password field — never a real secret. */
const SMTP_PASSWORD_PLACEHOLDER = "YOUR_API_KEY";

// Trimmed empty strings clear the field. Kept nullable so the client can send
// null explicitly and the get/update round-trip is symmetric.
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable();

// http(s) only: the value becomes a Location header after unsubscribe, so a
// javascript:/data: URL must never be storable.
const nullableHttpUrl = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .refine((v) => v === null || isHttpUrl(v), { message: "must be an http(s) URL" });

// Strict 6-digit hex only: these values land in inline styles on the public
// unsubscribe page, so this validation is a security boundary (a db CHECK
// enforces the same shape as defense in depth).
const nullableHexColor = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .refine((v) => v === null || isHexColor(v), { message: "must be a #rrggbb hex color" });

export function createSettingsRouter(
  deps: TeamDeletionDeps = defaultTeamDeletionDeps,
  mail: SystemMailDeps = defaultSystemMailDeps,
) {
  /**
   * Awaited, unlike the password reset: `emailed` and the per-invite send
   * counters are shown to the operator, so they must reflect a send SES
   * accepted. A failure is logged and reported as false — the dialog still
   * shows the link, and nothing is charged against the invite.
   */
  async function emailInvite(
    ctx: { db: Db; teamId: string; session: { user: { name: string } } },
    invite: { id: string; email: string; role: "member" | "admin" },
  ): Promise<boolean> {
    const [team] = await ctx.db
      .select({ name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.id, ctx.teamId));
    const message = buildInvitationEmail({
      to: invite.email,
      inviterName: ctx.session.user.name,
      teamName: team?.name ?? "",
      role: invite.role,
      url: inviteAcceptUrl(invite.id),
      expiresInDays: Math.round(INVITE_TTL_MS / DAY_MS),
      locale: await activeLocale(),
    });
    try {
      await mail.send(message);
      return true;
    } catch (error) {
      console.error("Invitation email failed to send", error);
      return false;
    }
  }

  return router({
    team: router({
      get: teamProcedure.query(async ({ ctx }) => {
        const [team] = await ctx.db
          .select({
            name: schema.teams.name,
            slug: schema.teams.slug,
            plan: schema.teams.plan,
            currentPeriodEnd: schema.teams.currentPeriodEnd,
            logoUrl: schema.teams.logoUrl,
          })
          .from(schema.teams)
          .where(eq(schema.teams.id, ctx.teamId));
        if (!team) throw new TRPCError({ code: "NOT_FOUND" });
        const { currentPeriodEnd, ...rest } = team;
        const logoUploadsEnabled = uploadsEnabled();
        return {
          ...rest,
          // Storage off ⇒ stored URLs may be dead; the UI falls back to the tile.
          logoUrl: logoUploadsEnabled ? team.logoUrl : null,
          logoUploadsEnabled,
          planDailyLimit: planDailyLimit(effectivePlan(team.plan, currentPeriodEnd)),
        };
      }),

      rename: teamProcedure
        .input(z.object({ name: z.string().trim().min(1).max(80) }))
        .mutation(async ({ ctx, input }) => {
          if (ctx.role === "member") throw new TRPCError({ code: "FORBIDDEN" });
          await ctx.db
            .update(schema.teams)
            .set({ name: input.name })
            .where(eq(schema.teams.id, ctx.teamId));
          return { name: input.name };
        }),

      /**
       * Owner-only, irreversible. Every team-scoped table cascades from the
       * team row; broadcasts and API keys are removed first because their
       * RESTRICT links to segments/topics/domains would otherwise block the
       * cascade. External cleanup (SES identities, logo object) runs after
       * commit and never fails the deletion — an orphaned identity is harmless.
       */
      delete: teamProcedure.mutation(async ({ ctx }) => {
        if (ctx.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
        if (env.IS_CLOUD) await deps.cancelSubscription(ctx.db, ctx.teamId);
        const { domains, logoUrl, name } = await ctx.db.transaction(async (tx) => {
          const [team] = await tx
            .select({ logoUrl: schema.teams.logoUrl, name: schema.teams.name })
            .from(schema.teams)
            .where(eq(schema.teams.id, ctx.teamId));
          if (!team) throw new TRPCError({ code: "NOT_FOUND" });
          const domains = await tx
            .select({
              name: schema.domains.name,
              region: schema.domains.region,
              sesTenantAssociatedAt: schema.domains.sesTenantAssociatedAt,
            })
            .from(schema.domains)
            .where(eq(schema.domains.teamId, ctx.teamId));
          await revokeTeamGrants(tx, ctx.teamId);
          await tx.delete(schema.broadcasts).where(eq(schema.broadcasts.teamId, ctx.teamId));
          await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.teamId, ctx.teamId));
          await tx.delete(schema.teams).where(eq(schema.teams.id, ctx.teamId));
          return { domains, logoUrl: team.logoUrl, name: team.name };
        });
        await Promise.allSettled([
          ...domains.map((domain) =>
            deps.deleteSesIdentity({
              name: domain.name,
              region: domain.region,
              ...(domain.sesTenantAssociatedAt ? { tenant: ctx.teamId } : {}),
            }),
          ),
          ...(logoUrl ? [deps.deleteLogo(logoUrl)] : []),
        ]);
        // Tenants are regional and outlive the domains that created them (a
        // tenant created before a failed association, or in a region whose
        // last domain was deleted earlier), so try every region; a missing
        // tenant is tolerated.
        await Promise.allSettled(
          SES_REGIONS.map((region) => deps.deleteSesTenant({ tenantName: ctx.teamId, region })),
        );
        await recordAudit(ctx, {
          action: "team.deleted",
          target: { type: "team", id: ctx.teamId },
          metadata: { name },
        });
        return { teamId: ctx.teamId };
      }),
    }),

    members: router({
      list: teamProcedure.query(async ({ ctx }) => {
        const rows = await ctx.db
          .select({
            userId: schema.teamMembers.userId,
            name: schema.user.name,
            email: schema.user.email,
            role: schema.teamMembers.role,
          })
          .from(schema.teamMembers)
          .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
          .where(eq(schema.teamMembers.teamId, ctx.teamId))
          .orderBy(asc(schema.teamMembers.createdAt));
        return rows.map((row) => ({ ...row, self: row.userId === ctx.session.user.id }));
      }),

      // Admins manage members and admins; only owners touch the owner role.
      updateRole: teamProcedure
        .input(z.object({ userId: z.string().min(1), role: z.enum(["owner", "admin", "member"]) }))
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          const target = await findMembership(ctx.db, ctx.teamId, input.userId);
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          if ((target.role === "owner" || input.role === "owner") && ctx.role !== "owner") {
            throw new TRPCError({ code: "FORBIDDEN" });
          }
          if (target.role === "owner" && input.role !== "owner") {
            await assertAnotherOwner(ctx.db, ctx.teamId, input.userId);
          }
          await ctx.db
            .update(schema.teamMembers)
            .set({ role: input.role })
            .where(eq(schema.teamMembers.id, target.id));
          await recordAudit(ctx, {
            action: "member.role_changed",
            target: { type: "user", id: input.userId },
            metadata: { from: target.role, to: input.role },
          });
          return { userId: input.userId, role: input.role };
        }),

      remove: teamProcedure
        .input(z.object({ userId: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          if (input.userId === ctx.session.user.id) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Leave the team instead." });
          }
          const target = await findMembership(ctx.db, ctx.teamId, input.userId);
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          if (target.role === "owner") {
            if (ctx.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
            await assertAnotherOwner(ctx.db, ctx.teamId, input.userId);
          }
          await removeMembership(ctx.db, ctx.teamId, input.userId);
          await recordAudit(ctx, {
            action: "member.removed",
            target: { type: "user", id: input.userId },
            metadata: { role: target.role },
          });
          return { userId: input.userId };
        }),

      leave: teamProcedure.mutation(async ({ ctx }) => {
        if (ctx.role === "owner") await assertAnotherOwner(ctx.db, ctx.teamId, ctx.session.user.id);
        await removeMembership(ctx.db, ctx.teamId, ctx.session.user.id);
        await recordAudit(ctx, {
          action: "member.left",
          target: { type: "user", id: ctx.session.user.id },
          metadata: { role: ctx.role },
        });
        return { teamId: ctx.teamId };
      }),
    }),

    invitations: router({
      // Owner/admin only, like create and revoke. The accept link is handed out
      // once, at create time: a listing that could reproduce every pending
      // bearer link would make one admin session worth every open invite.
      list: teamProcedure.query(async ({ ctx }) => {
        assertCanManageMembers(ctx.role);
        return ctx.db
          .select({
            id: schema.teamInvitations.id,
            email: schema.teamInvitations.email,
            role: schema.teamInvitations.role,
            expiresAt: schema.teamInvitations.expiresAt,
            createdAt: schema.teamInvitations.createdAt,
            lastSentAt: schema.teamInvitations.lastSentAt,
            sendCount: schema.teamInvitations.sendCount,
          })
          .from(schema.teamInvitations)
          .where(
            and(
              eq(schema.teamInvitations.teamId, ctx.teamId),
              isNull(schema.teamInvitations.acceptedAt),
            ),
          )
          .orderBy(desc(schema.teamInvitations.createdAt));
      }),

      create: teamProcedure
        .input(
          z.object({
            email: z.email().trim().toLowerCase(),
            role: z.enum(["member", "admin"]).default("member"),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          if (inviteEmailsLimited(ctx.teamId)) throw INVITE_HOURLY_LIMIT_ERROR;
          try {
            const [row] = await ctx.db
              .insert(schema.teamInvitations)
              .values({
                teamId: ctx.teamId,
                email: input.email,
                role: input.role,
                invitedByUserId: ctx.session.user.id,
                expiresAt: new Date(Date.now() + INVITE_TTL_MS),
              })
              .returning({ id: schema.teamInvitations.id });
            if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
            const emailed =
              inviteEmailsEnabled() &&
              (await emailInvite(ctx, { id: row.id, email: input.email, role: input.role }));
            if (emailed) {
              await ctx.db
                .update(schema.teamInvitations)
                .set({ lastSentAt: new Date(), sendCount: 1 })
                .where(eq(schema.teamInvitations.id, row.id));
            }
            await recordAudit(ctx, {
              action: "member.invited",
              target: { type: "invitation", id: row.id },
              metadata: { email: input.email, role: input.role, emailed },
            });
            return {
              id: row.id,
              email: input.email,
              role: input.role,
              acceptUrl: inviteAcceptUrl(row.id),
              emailed,
            };
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new TRPCError({ code: "CONFLICT", message: "Already invited." });
            }
            throw error;
          }
        }),

      // Hard delete: a revoked invite should stop resolving entirely, and the
      // partial unique index only guards un-accepted rows, so re-inviting works.
      revoke: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
        assertCanManageMembers(ctx.role);
        const [row] = await ctx.db
          .delete(schema.teamInvitations)
          .where(
            and(
              eq(schema.teamInvitations.id, input.id),
              eq(schema.teamInvitations.teamId, ctx.teamId),
              isNull(schema.teamInvitations.acceptedAt),
            ),
          )
          .returning({ id: schema.teamInvitations.id });
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        await recordAudit(ctx, {
          action: "invitation.revoked",
          target: { type: "invitation", id: row.id },
        });
        return { id: row.id };
      }),

      /**
       * Emails the invite again and renews its expiry. Throttled three ways:
       * a per-invite cooldown, a lifetime send cap per invite (past it, revoke
       * and re-invite), and the team's hourly invite-email budget.
       */
      resend: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
        assertCanManageMembers(ctx.role);
        if (!inviteEmailsEnabled()) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "No email sender is configured; share the invitation link instead.",
          });
        }
        const [invite] = await ctx.db
          .select({
            id: schema.teamInvitations.id,
            email: schema.teamInvitations.email,
            role: schema.teamInvitations.role,
            lastSentAt: schema.teamInvitations.lastSentAt,
            sendCount: schema.teamInvitations.sendCount,
          })
          .from(schema.teamInvitations)
          .where(
            and(
              eq(schema.teamInvitations.id, input.id),
              eq(schema.teamInvitations.teamId, ctx.teamId),
              isNull(schema.teamInvitations.acceptedAt),
            ),
          );
        if (!invite) throw new TRPCError({ code: "NOT_FOUND" });
        if (invite.sendCount >= INVITE_MAX_SENDS) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `This invitation was already sent ${INVITE_MAX_SENDS} times. Revoke it and invite again.`,
          });
        }
        if (
          invite.lastSentAt &&
          Date.now() - invite.lastSentAt.getTime() < INVITE_RESEND_COOLDOWN_MS
        ) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "This invitation was just sent. Wait a couple of minutes before resending.",
          });
        }
        if (inviteEmailsLimited(ctx.teamId)) throw INVITE_HOURLY_LIMIT_ERROR;
        const now = new Date();
        // The cooldown and the cap live in the same conditional update as the
        // counter bump, so two concurrent resends cannot both pass the pre-read.
        const [renewed] = await ctx.db
          .update(schema.teamInvitations)
          .set({
            expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
            lastSentAt: now,
            sendCount: sql`${schema.teamInvitations.sendCount} + 1`,
          })
          .where(
            and(
              eq(schema.teamInvitations.id, invite.id),
              isNull(schema.teamInvitations.acceptedAt),
              lt(schema.teamInvitations.sendCount, INVITE_MAX_SENDS),
              or(
                isNull(schema.teamInvitations.lastSentAt),
                lt(
                  schema.teamInvitations.lastSentAt,
                  new Date(now.getTime() - INVITE_RESEND_COOLDOWN_MS),
                ),
              ),
            ),
          )
          .returning({ expiresAt: schema.teamInvitations.expiresAt });
        if (!renewed) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "This invitation was just sent. Wait a couple of minutes before resending.",
          });
        }
        const emailed = await emailInvite(ctx, {
          id: invite.id,
          email: invite.email,
          role: invite.role === "admin" ? "admin" : "member",
        });
        if (!emailed) {
          // Give the slot back: a send SES refused must not count against the
          // cap or start a cooldown. The renewed expiry is harmless to keep.
          await ctx.db
            .update(schema.teamInvitations)
            .set({ lastSentAt: invite.lastSentAt, sendCount: invite.sendCount })
            .where(eq(schema.teamInvitations.id, invite.id));
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The invitation email could not be sent. Try again in a moment.",
          });
        }
        await recordAudit(ctx, {
          action: "invitation.resent",
          target: { type: "invitation", id: invite.id },
          metadata: { email: invite.email },
        });
        return { id: invite.id, expiresAt: renewed.expiresAt };
      }),

      /**
       * What the accept page shows before the visitor signs in: who invited
       * them where, and whether the link is still good. The signed token is
       * the credential, so no session is required.
       */
      preview: publicProcedure
        .input(z.object({ token: z.string().min(1) }))
        .query(async ({ ctx, input }) => {
          const inviteId = verifyInviteToken(input.token, requireAuthSecret());
          if (!inviteId)
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });
          const [row] = await ctx.db
            .select({
              email: schema.teamInvitations.email,
              role: schema.teamInvitations.role,
              expiresAt: schema.teamInvitations.expiresAt,
              acceptedAt: schema.teamInvitations.acceptedAt,
              teamName: schema.teams.name,
              inviterName: schema.user.name,
            })
            .from(schema.teamInvitations)
            .innerJoin(schema.teams, eq(schema.teams.id, schema.teamInvitations.teamId))
            .leftJoin(schema.user, eq(schema.user.id, schema.teamInvitations.invitedByUserId))
            .where(eq(schema.teamInvitations.id, inviteId));
          if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });
          const state = row.acceptedAt
            ? ("accepted" as const)
            : row.expiresAt.getTime() <= Date.now()
              ? ("expired" as const)
              : ("valid" as const);
          // On cloud the address is masked and never prefilled: sign-up needs
          // no verification, so a leaked link plus the plain address would let
          // anyone register as the invitee and take the seat. Self-host keeps
          // the link as the credential by design, so the address shows.
          const cloud = Boolean(env.IS_CLOUD);
          return {
            teamName: row.teamName,
            inviterName: row.inviterName ?? null,
            role: row.role,
            email: cloud ? maskEmail(row.email) : row.email,
            prefillEmail: cloud ? null : row.email,
            expiresAt: row.expiresAt,
            state,
          };
        }),

      /**
       * The authenticated caller joins the invite's team with its role. teamId
       * comes only from the invite row. On cloud the caller's account email must
       * match the invited address, so a forwarded or leaked link is worthless to
       * anyone else. Self-host keeps the signed link as the sole credential:
       * operators routinely invite an address the new user then signs up under
       * verbatim, and there is no email verification to lean on. Single-use is
       * atomic — acceptedAt is stamped in the same conditional update, so a
       * second accept finds nothing to stamp.
       */
      accept: protectedProcedure
        .input(z.object({ token: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          const inviteId = verifyInviteToken(input.token, requireAuthSecret());
          if (!inviteId)
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });

          if (env.IS_CLOUD) {
            const [invite] = await ctx.db
              .select({ email: schema.teamInvitations.email })
              .from(schema.teamInvitations)
              .where(eq(schema.teamInvitations.id, inviteId));
            if (invite && invite.email.toLowerCase() !== ctx.session.user.email.toLowerCase()) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: "This invitation was sent to a different email address.",
              });
            }
          }

          const joined = await ctx.db.transaction(async (tx) => {
            const [claimed] = await tx
              .update(schema.teamInvitations)
              .set({ acceptedAt: new Date() })
              .where(
                and(
                  eq(schema.teamInvitations.id, inviteId),
                  isNull(schema.teamInvitations.acceptedAt),
                  gt(schema.teamInvitations.expiresAt, new Date()),
                ),
              )
              .returning({
                teamId: schema.teamInvitations.teamId,
                role: schema.teamInvitations.role,
              });
            if (!claimed)
              throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });

            await tx
              .insert(schema.teamMembers)
              .values({ teamId: claimed.teamId, userId: ctx.session.user.id, role: claimed.role })
              .onConflictDoNothing({
                target: [schema.teamMembers.teamId, schema.teamMembers.userId],
              });
            return claimed;
          });

          ctx.setActiveTeamCookie?.(joined.teamId);
          await recordAudit(
            { ...ctx, teamId: joined.teamId },
            {
              action: "member.joined",
              target: { type: "user", id: ctx.session.user.id },
              metadata: { role: joined.role, invitationId: inviteId },
            },
          );
          return { teamId: joined.teamId };
        }),
    }),

    smtp: router({
      // Read-only connection facts. The password is deliberately the literal
      // placeholder, never a real key: the SMTP relay authenticates with any
      // ms_ API key, which the operator mints on the API keys screen.
      get: teamProcedure.query(() => {
        // Same gate as the tab and the page: on cloud an unexposed relay has no
        // connection details to hand out, only a hostname that cannot answer.
        if (!smtpRelayOffered()) throw new TRPCError({ code: "NOT_FOUND" });
        return {
          host: smtpPublicHost(),
          // Raw process.env carries no zod default under SKIP_ENV_VALIDATION, so
          // fall back to the relay's default listen port.
          port: Number(env.SMTP_PORT) || 2587,
          user: "millionsend",
          passwordPlaceholder: SMTP_PASSWORD_PLACEHOLDER,
          // Mirrors the relay's AUTH gate (apps/smtp/src/server.ts): AUTH needs
          // STARTTLS (cert+key both set) unless the insecure escape hatch is on.
          // Booleans only — the cert paths never reach the client. Raw process.env
          // for the flag because under SKIP_ENV_VALIDATION the env proxy carries
          // strings, not zod-parsed booleans.
          tlsConfigured: Boolean(env.SMTP_TLS_CERT_PATH && env.SMTP_TLS_KEY_PATH),
          allowInsecureAuth:
            process.env.SMTP_ALLOW_INSECURE_AUTH === "true" ||
            process.env.SMTP_ALLOW_INSECURE_AUTH === "1",
        };
      }),
    }),

    unsubscribe: router({
      get: teamProcedure.query(async ({ ctx }) => {
        const [team] = await ctx.db
          .select({
            // The page falls back to the team name when no brand name is set;
            // the editor shows it as the placeholder rather than a stored value
            // so a later team rename keeps flowing through.
            teamName: schema.teams.name,
            brandName: schema.teams.unsubscribeBrandName,
            message: schema.teams.unsubscribeMessage,
            successMessage: schema.teams.unsubscribeSuccessMessage,
            redirectUrl: schema.teams.unsubscribeRedirectUrl,
            backgroundColor: schema.teams.unsubscribeBackgroundColor,
            textColor: schema.teams.unsubscribeTextColor,
            accentColor: schema.teams.unsubscribeAccentColor,
            hideBranding: schema.teams.unsubscribeHideBranding,
          })
          .from(schema.teams)
          .where(eq(schema.teams.id, ctx.teamId));
        if (!team) throw new TRPCError({ code: "NOT_FOUND" });
        return team;
      }),

      update: teamProcedure
        .input(
          z.object({
            brandName: nullableText(80),
            message: nullableText(500),
            successMessage: nullableText(500),
            redirectUrl: nullableHttpUrl,
            backgroundColor: nullableHexColor,
            textColor: nullableHexColor,
            accentColor: nullableHexColor,
            hideBranding: z.boolean(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          await ctx.db
            .update(schema.teams)
            .set({
              unsubscribeBrandName: input.brandName,
              unsubscribeMessage: input.message,
              unsubscribeSuccessMessage: input.successMessage,
              unsubscribeRedirectUrl: input.redirectUrl,
              unsubscribeBackgroundColor: input.backgroundColor,
              unsubscribeTextColor: input.textColor,
              unsubscribeAccentColor: input.accentColor,
              unsubscribeHideBranding: input.hideBranding,
            })
            .where(eq(schema.teams.id, ctx.teamId));
          return input;
        }),
    }),

    usage: router({
      recent: teamProcedure
        .input(z.object({ days: z.number().int().min(1).max(30).optional() }).optional())
        .query(async ({ ctx, input }) => {
          const days = input?.days ?? 15;
          const today = utcDay(Date.now());
          const since = utcDay(Date.now() - (days - 1) * DAY_MS);

          const [team] = await ctx.db
            .select({ plan: schema.teams.plan, currentPeriodEnd: schema.teams.currentPeriodEnd })
            .from(schema.teams)
            .where(eq(schema.teams.id, ctx.teamId));
          if (!team) throw new TRPCError({ code: "NOT_FOUND" });

          const c = schema.usageCounters;
          const rows = await ctx.db
            .select({
              day: c.day,
              accepted: c.accepted,
              sent: c.sent,
              delivered: c.delivered,
              bounced: c.bounced,
              complained: c.complained,
            })
            .from(c)
            .where(and(eq(c.teamId, ctx.teamId), gte(c.day, since)))
            .orderBy(desc(c.day));

          return {
            rows,
            today: {
              accepted: rows.find((r) => r.day === today)?.accepted ?? 0,
              limit: planDailyLimit(effectivePlan(team.plan, team.currentPeriodEnd)),
            },
          };
        }),
    }),
  });
}

export const settingsRouter = createSettingsRouter();
