import {
  type ContactEventContext,
  emitSuppressionEvents,
  hashRecipient,
  recordContactActivity,
} from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { unsubscribeBaseUrl } from "@/lib/api-base-url";
import { enqueueWebhookDeliveries } from "@/server/queue";
import {
  postUnsubscribeLocation,
  preferenceTopics,
  targetForToken,
  type UnsubscribeTarget,
} from "../lookup";

/**
 * The opt-out on the email whose link was used, so its timeline and the
 * broadcast's stats show it. Only when the token names an email and that
 * row still exists on the contact's team (metadata retention purges rows;
 * a foreign team's id could only arrive with a forged signature), and only
 * for the email's own scope: a preference tweak on an unrelated topic
 * leaves the recipient in this email's audience. Callers guard repeats the
 * way the contact timeline does, so a scanner re-hit records nothing twice.
 */
async function recordEmailUnsubscribe(
  db: Db,
  target: UnsubscribeTarget,
  data: {
    scope: "global" | "topic";
    topicId?: string;
    topicName?: string;
    source: ContactEventContext["source"];
  },
): Promise<void> {
  if (!target.emailId) return;
  if (data.scope === "topic" && data.topicId !== target.topic?.id) return;
  const e = schema.emails;
  const [row] = await db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.id, target.emailId), eq(e.teamId, target.teamId)))
    .limit(1);
  if (!row) return;
  await db.insert(schema.emailEvents).values({
    emailId: row.id,
    type: "unsubscribed",
    occurredAt: new Date(),
    data,
  });
}

/**
 * Public unsubscribe endpoint — the signed token is the only credential, and
 * it carries the scope: a topic-scoped token unsubscribes from that topic
 * only, a bare token unsubscribes globally.
 *
 * This path is what buildUnsubscribeHeaders puts in List-Unsubscribe, so it
 * takes both verbs: a browser GET lands on the hosted confirm page (which
 * lives one segment over — page.tsx and route.ts can't share a segment),
 * and POST serves the confirm form plus RFC 8058 one-click posts
 * (form-encoded `List-Unsubscribe=One-Click`, which must get a bare 2xx,
 * not a redirect).
 *
 * Redirects are built on the unsubscribe host, never request.url: behind a
 * reverse proxy that rewrites Host the request URL names the upstream
 * (localhost:3000).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return Response.redirect(
    new URL(`/unsubscribe/confirm/${encodeURIComponent(token)}`, unsubscribeBaseUrl()),
    302,
  );
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const db = getDb();
  const target = await targetForToken(db, token);
  if (!target) return new Response(null, { status: 404 });

  const body = await request.text().catch(() => "");
  const form = new URLSearchParams(body);
  // An RFC 8058 header post and the confirm page's forms land here alike; the
  // published events say which one it was.
  const oneClick = form.get("List-Unsubscribe") === "One-Click";
  const events: ContactEventContext = {
    source: oneClick ? "one_click" : "hosted_page",
    enqueue: enqueueWebhookDeliveries,
  };

  // Preferences save from the confirm page: every listed topic gets an
  // explicit override (checked = subscribed). The listed set is recomputed
  // server-side — posted ids outside it are ignored, so a recipient can only
  // toggle what the page showed. Never touches the global unsubscribed flag.
  if (form.get("prefs") === "1") {
    const topics = await preferenceTopics(db, target);
    if (topics.length > 0) {
      const checked = new Set(form.getAll("topic"));
      const s = schema.contactTopicSubscriptions;
      await db
        .insert(s)
        .values(
          topics.map((topic) => ({
            contactId: target.contactId,
            topicId: topic.id,
            subscribed: checked.has(topic.id),
          })),
        )
        .onConflictDoUpdate({
          target: [s.contactId, s.topicId],
          set: { subscribed: sql`excluded.subscribed`, updatedAt: new Date() },
        });
      // Timeline: only the topics whose effective state actually flipped —
      // re-saving unchanged preferences records nothing.
      const flipped = topics.filter((topic) => topic.subscribed !== checked.has(topic.id));
      await recordContactActivity(
        db,
        flipped.map((topic) => ({
          teamId: target.teamId,
          contactId: target.contactId,
          type: checked.has(topic.id) ? ("topic_opt_in" as const) : ("topic_opt_out" as const),
          data: { topicId: topic.id, name: topic.name },
        })),
        events,
      );
      for (const topic of flipped) {
        if (checked.has(topic.id)) continue;
        await recordEmailUnsubscribe(db, target, {
          scope: "topic",
          topicId: topic.id,
          topicName: topic.name,
          source: events.source,
        });
      }
    }
    return Response.redirect(
      new URL(`/unsubscribe/confirm/${encodeURIComponent(token)}?saved=1`, unsubscribeBaseUrl()),
      303,
    );
  }

  if (target.topic) {
    // Topic-scoped: write the explicit opt-out override, leaving the global
    // unsubscribed flag and every other topic untouched.
    const s = schema.contactTopicSubscriptions;
    await db
      .insert(s)
      .values({ contactId: target.contactId, topicId: target.topic.id, subscribed: false })
      .onConflictDoUpdate({
        target: [s.contactId, s.topicId],
        set: { subscribed: false, updatedAt: new Date() },
      });
    // alreadyDone guards the timeline: scanner re-hits must not duplicate the event.
    if (!target.alreadyDone) {
      await recordContactActivity(
        db,
        {
          teamId: target.teamId,
          contactId: target.contactId,
          type: "topic_opt_out",
          data: { topicId: target.topic.id, name: target.topic.name },
        },
        events,
      );
      await recordEmailUnsubscribe(db, target, {
        scope: "topic",
        topicId: target.topic.id,
        topicName: target.topic.name,
        source: events.source,
      });
    }
  } else {
    await db
      .update(schema.contacts)
      .set({
        unsubscribed: true,
        // coalesce keeps the FIRST unsubscribe time: mail scanners re-hit
        // one-click links, and repeats must not walk the timestamp forward.
        unsubscribedAt: sql`coalesce(${schema.contacts.unsubscribedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(schema.contacts.id, target.contactId));
    // The contact flag is mutable and dies with the row; the suppression is
    // the retained opt-out record that outlives delete/re-import and API
    // re-subscribes. Repeats hit the (team, hash) unique index and no-op.
    const [suppression] = await db
      .insert(schema.suppressions)
      .values({
        teamId: target.teamId,
        email: target.email,
        emailHash: hashRecipient(target.email),
        reason: "one_click_unsubscribe",
      })
      .onConflictDoNothing()
      .returning({
        id: schema.suppressions.id,
        email: schema.suppressions.email,
        reason: schema.suppressions.reason,
        createdAt: schema.suppressions.createdAt,
      });
    if (suppression) {
      await emitSuppressionEvents(db, {
        teamId: target.teamId,
        type: "suppression.added",
        rows: [suppression],
        source: events.source,
        enqueue: events.enqueue,
      });
    }
    // alreadyDone guards the timeline: scanner re-hits must not duplicate the event.
    if (!target.alreadyDone) {
      await recordContactActivity(
        db,
        {
          teamId: target.teamId,
          contactId: target.contactId,
          type: "unsubscribed",
        },
        events,
      );
      await recordEmailUnsubscribe(db, target, { scope: "global", source: events.source });
    }
  }

  if (oneClick) {
    return new Response(null, { status: 200 });
  }
  return Response.redirect(postUnsubscribeLocation(token, target.customization.redirectUrl), 303);
}
