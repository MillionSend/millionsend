import { randomInt } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, count, eq } from "drizzle-orm";
import { isUniqueViolation } from "../driver-result.js";
import { type InboxActor, recordInboxActivity } from "./activity.js";
import {
  INBOX_NOT_FOUND,
  invalid,
  isInboxError,
  labelNotFound,
  oneLineName,
} from "./inbox-common.js";
import type { InboxDeps } from "./inboxes.js";
import { findLiveInbox, INBOX_LABELS_MAX } from "./limits.js";
import { LABEL_COLORS } from "./organize.js";
import type { InboxError, LabelWire } from "./types.js";
import { labelWire } from "./wire.js";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PALETTE = Object.values(LABEL_COLORS);

type LabelResult = { ok: true; label: LabelWire } | { ok: false; error: InboxError };

function labelColor(value: string): string | InboxError {
  return HEX_COLOR.test(value)
    ? value.toUpperCase()
    : invalid('color must be a #RRGGBB hex color, like "#E93D82"');
}

/** Names are unique per inbox regardless of case (a unique index on lower(name)). */
const duplicate = (name: string): LabelResult => ({
  ok: false,
  error: invalid(`A label named "${name}" already exists in this inbox`),
});

/** Oldest first and unpaged, as Resend lists labels (at most 100 per inbox). */
export async function listLabels(
  db: Db,
  p: { teamId: string; inboxId: string },
): Promise<LabelWire[]> {
  const l = schema.inboxLabels;
  const rows = await db
    .select()
    .from(l)
    .where(and(eq(l.inboxId, p.inboxId), eq(l.teamId, p.teamId)))
    .orderBy(asc(l.createdAt), asc(l.id));
  return rows.map(labelWire);
}

export async function createLabel(
  db: Db,
  _deps: InboxDeps,
  p: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    name: string;
    color?: string | undefined;
  },
): Promise<LabelResult> {
  const name = oneLineName(p.name);
  if (isInboxError(name)) return { ok: false, error: name };
  const color =
    p.color === undefined ? (PALETTE[randomInt(PALETTE.length)] as string) : labelColor(p.color);
  if (isInboxError(color)) return { ok: false, error: color };
  const l = schema.inboxLabels;
  return db.transaction(async (tx): Promise<LabelResult> => {
    const t = tx as unknown as Db;
    if (!(await findLiveInbox(t, { teamId: p.teamId, inboxId: p.inboxId })))
      return { ok: false, error: INBOX_NOT_FOUND };
    // The inbox row's lock serializes creates, so two at once cannot pass the cap together.
    await t
      .select({ id: schema.inboxes.id })
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, p.inboxId))
      .for("update");
    const [held] = await t.select({ n: count() }).from(l).where(eq(l.inboxId, p.inboxId));
    if ((held?.n ?? 0) >= INBOX_LABELS_MAX) {
      return { ok: false, error: invalid(`An inbox can have at most ${INBOX_LABELS_MAX} labels`) };
    }
    const [row] = await t
      .insert(l)
      .values({ teamId: p.teamId, inboxId: p.inboxId, name, color })
      .onConflictDoNothing()
      .returning();
    if (!row) return duplicate(name);
    await recordInboxActivity(t, {
      teamId: p.teamId,
      inboxId: p.inboxId,
      actor: p.actor,
      action: "label.created",
    });
    return { ok: true, label: labelWire(row) };
  });
}

export async function updateLabel(
  db: Db,
  _deps: InboxDeps,
  p: {
    teamId: string;
    inboxId: string;
    labelId: string;
    actor: InboxActor;
    name?: string | undefined;
    color?: string | undefined;
  },
): Promise<LabelResult> {
  const set: { name?: string; color?: string } = {};
  if (p.name !== undefined) {
    const name = oneLineName(p.name);
    if (isInboxError(name)) return { ok: false, error: name };
    set.name = name;
  }
  if (p.color !== undefined) {
    const color = labelColor(p.color);
    if (isInboxError(color)) return { ok: false, error: color };
    set.color = color;
  }
  const l = schema.inboxLabels;
  const scope = and(eq(l.id, p.labelId), eq(l.inboxId, p.inboxId), eq(l.teamId, p.teamId));
  try {
    return await db.transaction(async (tx): Promise<LabelResult> => {
      const t = tx as unknown as Db;
      if (!(await findLiveInbox(t, { teamId: p.teamId, inboxId: p.inboxId }))) {
        return { ok: false, error: INBOX_NOT_FOUND };
      }
      const [row] =
        Object.keys(set).length === 0
          ? await t.select().from(l).where(scope)
          : await t.update(l).set(set).where(scope).returning();
      if (!row) return { ok: false, error: labelNotFound(p.labelId) };
      if (Object.keys(set).length > 0) {
        await recordInboxActivity(t, {
          teamId: p.teamId,
          inboxId: p.inboxId,
          actor: p.actor,
          action: "label.updated",
        });
      }
      return { ok: true, label: labelWire(row) };
    });
  } catch (err) {
    if (isUniqueViolation(err) && set.name !== undefined) return duplicate(set.name);
    throw err;
  }
}

/** Also takes the label off every thread, without a per-thread event (Resend). */
export async function deleteLabel(
  db: Db,
  _deps: InboxDeps,
  p: { teamId: string; inboxId: string; labelId: string; actor: InboxActor },
): Promise<boolean> {
  const l = schema.inboxLabels;
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [row] = await t
      .delete(l)
      .where(and(eq(l.id, p.labelId), eq(l.inboxId, p.inboxId), eq(l.teamId, p.teamId)))
      .returning({ id: l.id });
    if (!row) return false;
    await recordInboxActivity(t, {
      teamId: p.teamId,
      inboxId: p.inboxId,
      actor: p.actor,
      action: "label.deleted",
    });
    return true;
  });
}
