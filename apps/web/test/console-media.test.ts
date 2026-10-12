import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, type MediaReview, sealMediaReview } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEK = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

const h = vi.hoisted(() => ({
  drains: 0,
  queries: {} as Record<string, unknown>,
}));

vi.mock("@/server/queue", () => ({
  getQueue: async () => ({
    runCronNow: async () => {
      h.drains += 1;
    },
  }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));
// The real English catalogs, so the test reads what the operator reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    console: (await import("../messages/en/console.json")).default,
    settings: (await import("../messages/en/settings.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: "en",
        messages,
        namespace: namespace as keyof typeof messages,
      }),
  };
});
// Dialogs portal to document.body, which a server render does not have.
vi.mock("@/components/modal", () => ({
  Modal: ({ title, children }: { title?: string; children: React.ReactNode }) =>
    createElement("div", { "data-title": title }, children),
}));
// A tooltip's text only mounts on hover: the trigger carries it here instead.
vi.mock("@/components/tooltip", () => ({
  Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) =>
    createElement("span", { "data-tip": text }, children),
}));
// Each procedure's options name its path; a query answers with what the test put there.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") || key === "queryKey"
          ? (input?: unknown) => ({ path: path.join("."), input })
          : at([...path, key]),
    });
  return { useTRPC: () => at([]), useTRPCClient: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) =>
    options.path in h.queries
      ? {
          data: h.queries[options.path],
          isPending: false,
          isError: false,
          error: null,
          refetch: () => {},
        }
      : { data: undefined, isPending: true, isError: false, error: null, refetch: () => {} },
  useMutation: () => ({ mutate: () => {}, reset: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

const { MediaPanel } = await import("@/components/console/safety/media-panel");
const { WaitingList } = await import("@/components/console/safety/waiting-list");

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const keyring = EnvKeyring.fromBase64(TEST_KEK);
const OPERATOR = "op";
const MEMBER = "bob";
const JUSTIFICATION = "Screening parked it over a QR code it could not decode.";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString(
  "base64",
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString(
  "base64",
);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: MEMBER, name: "Bob", email: "bob@example.com", createdAt: new Date(1) },
  ]);
  teamId = await createTeam(db, "acme");
  await db.insert(schema.teamMembers).values({ teamId, userId: MEMBER, role: "owner" });
  await db.insert(schema.linkDomainAges).values({
    domain: "m365-verify.example",
    registeredAt: new Date(Date.now() - 3 * 86_400_000),
    source: "rdap",
    checkedAt: new Date(),
  });
});
afterAll(() => close());

beforeEach(() => vi.stubEnv("CONTENT_REVEAL", "on"));
afterEach(async () => {
  vi.unstubAllEnvs();
  // audit_log is append-only: assertions scope themselves by target instead.
  await db.delete(schema.contentAccessGrants);
  await db.delete(schema.emails);
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
});

function callerFor(userId: string, team: string | null = null, role: TeamRole | null = null) {
  return createCaller({
    db,
    session: {
      user: { id: userId, email: `${userId}@example.com`, name: userId },
      session: { id: `s-${userId}`, createdAt: new Date() },
    },
    teamId: team,
    role,
  });
}
const operator = () => callerFor(OPERATOR);
const member = () => callerFor(MEMBER, teamId, "owner");

function review(over: Partial<MediaReview> = {}): MediaReview {
  return {
    text: [
      {
        source: "image 1, remote, cdn.lure.example",
        text: "Seu código é 448122. Confirme em https://login.m365-verify.example/session/abcdefghijklmnop",
      },
    ],
    links: [
      {
        source: "QR code",
        url: "https://login.m365-verify.example/s?t=8sJ2k",
        domain: "m365-verify.example",
      },
    ],
    pix: [],
    files: [
      {
        filename: "Fatura 529.982.247-25.pdf",
        kind: "pdf",
        size: 182_000,
        pages: 2,
        flags: ["pdf_actions"],
      },
    ],
    previews: [
      { label: "image 1, remote, cdn.lure.example", jpeg: JPEG },
      { label: "attachment logo.svg", jpeg: SVG },
    ],
    issues: ["qr_undecoded"],
    ...over,
  };
}

/** An email parked for an operator, with what screening read from its media sealed on it. */
async function parked(
  team: string,
  media: MediaReview | null,
  over: Partial<typeof schema.emails.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.emails).values({
    id,
    teamId: team,
    from: "Fatura <cobranca@lure.example>",
    to: ["victim@example.org"],
    subject: "Sua fatura chegou",
    latestStatus: "queued_quota",
    parkReason: "media",
    media: media && (await sealMediaReview(media, keyring, { teamId: team, rowId: id })),
    ...over,
  });
  return id;
}

const grantFor = (emailId: string) =>
  operator().console.safety.requestAccess({
    teamId,
    reason: "phishing_or_malware",
    justification: JUSTIFICATION,
    scope: "email",
    emailId,
  });

describe("console.safety.media", () => {
  it("is the operator's alone, and only while content access is on", async () => {
    const emailId = await parked(teamId, review());
    const grantId = randomUUID();
    await expect(member().console.safety.media({ grantId, emailId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      member().console.safety.releaseSameMedia({ teamId, emailId, parkedBefore: new Date() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    vi.stubEnv("CONTENT_REVEAL", "off");
    await expect(operator().console.safety.media({ grantId, emailId })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "off",
    });
  });

  it("opens under a content grant, with its audit row, redacted and with JPEG previews only", async () => {
    const emailId = await parked(teamId, review());
    // Held mail screening read media from is in the flagged window, so a grant can name it.
    const { flaggedEmails } = await operator().console.safety.review({ teamId });
    expect(flaggedEmails.map((row) => row.id)).toContain(emailId);
    const { grantId } = await grantFor(emailId);
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "content.revealed"),
          eq(schema.auditLog.target, `team:${teamId}`),
        ),
      );
    expect(audits.find((row) => row.data?.grantId === grantId)).toMatchObject({
      teamId: null,
      actorId: `user:${OPERATOR}`,
      data: { grantId, emails: 1 },
    });

    const media = await operator().console.safety.media({ grantId, emailId });
    const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join("");
    expect(media.why).toBe("media");
    expect(media.issues).toEqual(["qr_undecoded"]);
    expect(plain(media.text[0]?.spans ?? [])).toBe(
      "Seu código é ••••••. Confirme em https://m365-verify.example/session/abcdefghijklmno…",
    );
    expect(media.links).toMatchObject([
      { source: "QR code", link: [{ text: "https://m365-verify.example/s…" }] },
    ]);
    expect(media.links[0]?.registeredAt).toBeInstanceOf(Date);
    expect(plain(media.files[0]?.name ?? [])).toBe("Fatura ••••••.pdf");
    expect(media.previews.map((preview) => preview.src)).toEqual([
      `data:image/jpeg;base64,${JPEG}`,
    ]);
    expect(media).toMatchObject({ sameMedia: 1, releasable: true, viewCount: 1 });
    const payload = JSON.stringify(media);
    for (const leak of ["448122", "8sJ2k", "529.982", SVG, "victim@example.org"]) {
      expect(payload).not.toContain(leak);
    }

    // The first look at the media is recorded with its own fields, once per grant,
    // and stamped on the grant so the team's disclosure names it.
    await operator().console.safety.media({ grantId, emailId });
    const [grant] = await db.select().from(schema.contentAccessGrants);
    expect(grant?.viewCount).toBe(2);
    expect(grant?.mediaViewedAt).toBeInstanceOf(Date);
    const reads = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "content.revealed"),
          eq(schema.auditLog.target, `team:${teamId}`),
        ),
      );
    expect(
      reads
        .filter((row) => row.data?.grantId === grantId)
        .map((row) => row.data?.fields)
        .sort(),
    ).toEqual(["subject, rendered text", "what screening read from its images and attachments"]);
  });

  it("refuses an email off the grant, a closed window and one without a review", async () => {
    const emailId = await parked(teamId, review());
    const other = await parked(teamId, review());
    const { grantId } = await grantFor(emailId);
    await expect(
      operator().console.safety.media({ grantId, emailId: other }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "not_in_grant" });

    await db.update(schema.emails).set({ media: null }).where(eq(schema.emails.id, emailId));
    await expect(operator().console.safety.media({ grantId, emailId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "no_media",
    });

    await db
      .update(schema.contentAccessGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.contentAccessGrants.id, grantId));
    await expect(operator().console.safety.media({ grantId, emailId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "expired",
    });
  });
});

describe("console.safety.releaseSameMedia", () => {
  it("releases the team's parked emails with the same media, and no other", async () => {
    const first = await parked(teamId, review());
    const copy = await parked(teamId, review(), { parkReason: "screening" });
    const different = await parked(teamId, review({ issues: ["risky_file"] }));
    const noMedia = await parked(teamId, null);
    const canceled = await parked(teamId, review(), { latestStatus: "canceled" });
    const otherTeam = await createTeam(db, "other");
    const elsewhere = await parked(otherTeam, review());
    const drains = h.drains;

    expect(
      await operator().console.safety.releaseSameMedia({
        teamId,
        emailId: first,
        parkedBefore: new Date(),
      }),
    ).toEqual({
      released: 2,
    });
    const rows = await db
      .select({
        id: schema.emails.id,
        parkReason: schema.emails.parkReason,
        latestStatus: schema.emails.latestStatus,
      })
      .from(schema.emails)
      .where(inArray(schema.emails.id, [first, copy, different, noMedia, canceled, elsewhere]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first)).toMatchObject({ parkReason: null, latestStatus: "queued_quota" });
    expect(byId.get(copy)).toMatchObject({ parkReason: null });
    expect(byId.get(different)?.parkReason).toBe("media");
    expect(byId.get(noMedia)?.parkReason).toBe("media");
    expect(byId.get(canceled)?.latestStatus).toBe("canceled");
    expect(byId.get(elsewhere)?.parkReason).toBe("media");
    expect(h.drains).toBe(drains + 1);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          isNull(schema.auditLog.teamId),
          eq(schema.auditLog.action, "screening.released"),
          eq(schema.auditLog.target, `team:${teamId}`),
        ),
      );
    expect(audits.map((row) => row.data)).toEqual([{ team: "acme", emails: 2 }]);

    // Nothing left with that media: nothing released, nothing recorded.
    expect(
      await operator().console.safety.releaseSameMedia({
        teamId,
        emailId: first,
        parkedBefore: new Date(),
      }),
    ).toEqual({
      released: 0,
    });
  });

  it("waits with the rest of a suspended team's mail", async () => {
    const emailId = await parked(teamId, review());
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "review" })
      .where(eq(schema.teams.id, teamId));
    await expect(
      operator().console.safety.releaseSameMedia({ teamId, emailId, parkedBefore: new Date() }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "held" });
  });
});

describe("the media panel and its row action", () => {
  it("lists which rows carry a review, and the operator's own live grants", async () => {
    const withMedia = await parked(teamId, review());
    const without = await parked(teamId, null, { parkReason: "screening" });
    const { grantId } = await grantFor(withMedia);
    const { groups, grants, contentReveal } = await operator().console.safety.waiting({ teamId });
    expect(contentReveal).toBe(true);
    const media = new Map(groups[0]?.emails.map((email) => [email.id, email.media]));
    expect(media.get(withMedia)).toBe(true);
    expect(media.get(without)).toBe(false);
    expect(grants).toMatchObject([{ id: grantId, emailIds: [withMedia] }]);
  });

  it("offers Media on a row with a review, held back while content access is off", async () => {
    await parked(teamId, review());
    await parked(teamId, null, { parkReason: "screening" });
    const waiting = await operator().console.safety.waiting({ teamId });
    h.queries = { "console.safety.waiting": waiting };
    const media = (html: string) => html.match(/>Media</g)?.length ?? 0;
    const on = renderToStaticMarkup(createElement(WaitingList, { teamId }));
    expect(media(on)).toBe(1);
    expect(on).toMatch(/<button type="button" class="ms-link"[^>]*>Media<\/button> · /);

    h.queries = { "console.safety.waiting": { ...waiting, contentReveal: false } };
    const off = renderToStaticMarkup(createElement(WaitingList, { teamId }));
    expect(off).toContain(
      '<span data-tip="Content access is off on this instance: set CONTENT_REVEAL=on in its environment."><span style="color:var(--ms-muted)">Media</span></span>',
    );
  });

  it("shows why it waits, the redacted text, the tables and JPEG previews only", async () => {
    const emailId = await parked(teamId, review());
    await parked(teamId, review());
    const { grantId } = await grantFor(emailId);
    h.queries = {
      "console.safety.media": await operator().console.safety.media({ grantId, emailId }),
    };
    const html = renderToStaticMarkup(
      createElement(MediaPanel, {
        team: { id: teamId, name: "acme" },
        grantId,
        emailId,
        onClose: () => {},
        onChanged: () => {},
      }),
    );
    expect(html).toContain('data-title="Images and attachments · acme"');
    expect(html).toContain(
      'Images or files<span style="color:var(--ms-muted)">· a QR code could not be decoded</span>',
    );
    expect(html).toContain('<span class="ms-redact">••••••</span>');
    expect(html).not.toContain("448122");
    // Words left, figures right.
    expect(html).toContain('<th class="right">Size</th><th class="right">Pages</th>');
    expect(html).toContain(
      '<td>PDF actions</td><td class="right num">177.7 KB</td><td class="right num">2</td>',
    );
    expect(html).toContain("<td>QR code</td>");
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain(`<img src="data:image/jpeg;base64,${JPEG}"`);
    expect(html).not.toContain(SVG);
    expect(html).toContain("Release all 2 with the same media");
  });
});
