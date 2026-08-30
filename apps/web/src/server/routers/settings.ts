import { cancelTeamSubscription } from "@millionsend/billing";
import { env } from "@millionsend/config";
import {
  DAY_MS,
  INVITE_TTL_MS,
  PLAN_DAILY_LIMIT,
  type Plan,
  signInviteToken,
  utcDay,
  verifyInviteToken,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createSesv2Client, deleteDomainIdentity } from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gt, gte, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { isHexColor } from "@/lib/hex-color";
import { isHttpUrl } from "@/lib/http-url";
import { resolveBaseUrl } from "../auth";
import { getStripe } from "../billing";
import { smtpRelayOffered } from "../smtp";
import { deletePublicObject, keyFromPublicUrl, uploadsEnabled } from "../storage";
import { protectedProcedure, router, teamProcedure } from "../trpc";

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
  deleteSesIdentity(domain: { name: string; region: string }): Promise<void>;
  deleteLogo(logoUrl: string): Promise<void>;
}

const defaultTeamDeletionDeps: TeamDeletionDeps = {
  cancelSubscription: (db, teamId) => cancelTeamSubscription({ stripe: getStripe(), db }, teamId),
  // Identities live in the domain's region, which may differ from AWS_REGION.
  deleteSesIdentity: ({ name, region }) =>
    deleteDomainIdentity(
      createSesv2Client({
        region,
        ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : {}),
      }),
      { domain: name },
    ),
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

export function createSettingsRouter(deps: TeamDeletionDeps = defaultTeamDeletionDeps) {
  return router({
    team: router({
      get: teamProcedure.query(async ({ ctx }) => {
        const [team] = await ctx.db
          .select({
            name: schema.teams.name,
            slug: schema.teams.slug,
            plan: schema.teams.plan,
            logoUrl: schema.teams.logoUrl,
          })
          .from(schema.teams)
          .where(eq(schema.teams.id, ctx.teamId));
        if (!team) throw new TRPCError({ code: "NOT_FOUND" });
        const logoUploadsEnabled = uploadsEnabled();
        return {
          ...team,
          // Storage off ⇒ stored URLs may be dead; the UI falls back to the tile.
          logoUrl: logoUploadsEnabled ? team.logoUrl : null,
          logoUploadsEnabled,
          planDailyLimit: planDailyLimit(team.plan),
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
        const { domains, logoUrl } = await ctx.db.transaction(async (tx) => {
          const [team] = await tx
            .select({ logoUrl: schema.teams.logoUrl })
            .from(schema.teams)
            .where(eq(schema.teams.id, ctx.teamId));
          if (!team) throw new TRPCError({ code: "NOT_FOUND" });
          const domains = await tx
            .select({ name: schema.domains.name, region: schema.domains.region })
            .from(schema.domains)
            .where(eq(schema.domains.teamId, ctx.teamId));
          await revokeTeamGrants(tx, ctx.teamId);
          await tx.delete(schema.broadcasts).where(eq(schema.broadcasts.teamId, ctx.teamId));
          await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.teamId, ctx.teamId));
          await tx.delete(schema.teams).where(eq(schema.teams.id, ctx.teamId));
          return { domains, logoUrl: team.logoUrl };
        });
        await Promise.allSettled([
          ...domains.map((domain) => deps.deleteSesIdentity(domain)),
          ...(logoUrl ? [deps.deleteLogo(logoUrl)] : []),
        ]);
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
          return { userId: input.userId };
        }),

      leave: teamProcedure.mutation(async ({ ctx }) => {
        if (ctx.role === "owner") await assertAnotherOwner(ctx.db, ctx.teamId, ctx.session.user.id);
        await removeMembership(ctx.db, ctx.teamId, ctx.session.user.id);
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
            return {
              id: row.id,
              email: input.email,
              role: input.role,
              acceptUrl: inviteAcceptUrl(row.id),
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
        return { id: row.id };
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

          const teamId = await ctx.db.transaction(async (tx) => {
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
            return claimed.teamId;
          });

          ctx.setActiveTeamCookie?.(teamId);
          return { teamId };
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
            .select({ plan: schema.teams.plan })
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
              limit: planDailyLimit(team.plan),
            },
          };
        }),
    }),
  });
}

export const settingsRouter = createSettingsRouter();
