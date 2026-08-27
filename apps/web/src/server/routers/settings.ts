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
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { isHexColor } from "@/lib/hex-color";
import { isHttpUrl } from "@/lib/http-url";
import { resolveBaseUrl } from "../auth";
import { smtpRelayOffered } from "../smtp";
import { uploadsEnabled } from "../storage";
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

export const settingsRouter = router({
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
  }),

  members: router({
    list: teamProcedure.query(({ ctx }) =>
      ctx.db
        .select({
          name: schema.user.name,
          email: schema.user.email,
          role: schema.teamMembers.role,
        })
        .from(schema.teamMembers)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
        .where(eq(schema.teamMembers.teamId, ctx.teamId))
        .orderBy(asc(schema.teamMembers.createdAt)),
    ),
  }),

  invitations: router({
    // The accept link is a bearer token, so listing pending invites — like
    // creating and revoking them — is owner/admin only.
    list: teamProcedure.query(async ({ ctx }) => {
      assertCanManageMembers(ctx.role);
      const rows = await ctx.db
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
      return rows.map((row) => ({ ...row, acceptUrl: inviteAcceptUrl(row.id) }));
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
     * comes only from the invite row. The invited email is not required to
     * match the caller: the signed link is the bearer credential, and
     * self-host operators routinely invite an address the new user signs up
     * under verbatim. Single-use is atomic — acceptedAt is stamped in the same
     * conditional update, so a second accept finds nothing to stamp.
     */
    accept: protectedProcedure
      .input(z.object({ token: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const inviteId = verifyInviteToken(input.token, requireAuthSecret());
        if (!inviteId) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });

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
