import {
  encryptEmailBody,
  hashRecipient,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
  type MonitorSettings,
  verifyForwardMarker,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesTenantClient } from "@millionsend/ses";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addInbox,
  addThread,
  receive,
  seedWorld,
  type World,
} from "../../../packages/core/test/inbox-send-fixtures.js";
import { forwardToOwners } from "../src/handlers/inbox-forward.js";
import { type SesSender, sendEmail } from "../src/handlers/send-email.js";
import { sharedTenantResolver } from "../src/handlers/tenants.js";

let db: Db;
let close: () => Promise<void>;
let w: World;
const sends: Parameters<SesSender["sendRaw"]>[0][] = [];
const ses: SesSender = {
  sendRaw: async (params) => {
    sends.push(params);
    return { messageId: `mid-${sends.length}` };
  },
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  w = await seedWorld(db, "worker");
});
afterAll(() => close());

async function queuedEmail(
  over: Partial<typeof schema.emails.$inferInsert>,
  html: string | null = null,
): Promise<string> {
  const encrypted = await encryptEmailBody({ html, text: "hello" }, w.deps.keyring);
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId: w.teamId,
      domainId: w.domainId,
      from: `a@${w.domain}`,
      to: ["r@example.org"],
      subject: "hi",
      latestStatus: "queued",
      bodyCiphertext: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      bodyWrappedDek: encrypted.wrappedDek,
      bodyKeyVersion: encrypted.keyVersion,
      ...over,
    })
    .returning({ id: schema.emails.id });
  return row?.id ?? "";
}

const monitorWith = (settings: MonitorSettings, queued: string[]): MonitorDeps => ({
  samplingKey: Buffer.alloc(32, 7),
  settings: async () => settings,
  enqueueJudge: async (id) => void queued.push(id),
});

const samplesFor = (emailId: string) =>
  db.select().from(schema.monitorSamples).where(eq(schema.monitorSamples.emailId, emailId));

describe("send-email for inbox mail", () => {
  it("sends a shared-domain reply from the platform identity, and still screens it as customer mail", async () => {
    const inbox = await addInbox(w, { local: "shared-bot", shared: true });
    const emailId = await queuedEmail({
      domainId: null,
      from: inbox.emailAddress,
      inboxId: inbox.id,
    });
    const queued: string[] = [];
    const settings = { ...MONITOR_SETTING_DEFAULTS, autoHold: false };
    expect(
      await sendEmail(
        db,
        {
          keyring: w.deps.keyring,
          ses,
          defaultConfigurationSet: "default-set",
          sharedInboxDomain: w.sharedDomain,
          monitor: monitorWith(settings, queued),
        },
        { emailId },
      ),
    ).toBe("sent");
    expect(sends.at(-1)).toMatchObject({ configurationSetName: "default-set" });
    expect(sends.at(-1)?.region).toBeUndefined();
    expect(await samplesFor(emailId)).toHaveLength(1);

    const stranger = await queuedEmail({ domainId: null, from: "x@unknown.example" });
    expect(
      await sendEmail(
        db,
        { keyring: w.deps.keyring, ses, sharedInboxDomain: w.sharedDomain },
        {
          emailId: stranger,
        },
      ),
    ).toBe("failed");
  });

  it("always judges an agent inbox's first contact, past the instance's daily cap", async () => {
    const inbox = await addInbox(w, { local: "first-contact" });
    const human = await addInbox(w, { local: "people", kind: "human" });
    const queued: string[] = [];
    const settings = { ...MONITOR_SETTING_DEFAULTS, autoHold: false, instanceDailyCap: 0 };
    const deps = { keyring: w.deps.keyring, ses, monitor: monitorWith(settings, queued) };
    const first = await queuedEmail({ inboxId: inbox.id, firstContact: true });
    expect(await sendEmail(db, deps, { emailId: first })).toBe("sent");
    expect(await samplesFor(first)).toMatchObject([
      { kind: "agent_first_contact", status: "pending" },
    ]);
    expect(queued).toHaveLength(1);
    const people = await queuedEmail({ inboxId: human.id, firstContact: true });
    expect(await sendEmail(db, deps, { emailId: people })).toBe("sent");
    expect((await samplesFor(people)).map((s) => s.kind)).not.toContain("agent_first_contact");
  });

  it("sends a people inbox's mail untracked; an agent inbox's follows the domain's toggles", async () => {
    const setTracking = (on: boolean) =>
      db
        .update(schema.domains)
        .set({ clickTracking: on, openTracking: on })
        .where(eq(schema.domains.id, w.domainId));
    await setTracking(true);
    try {
      const deps = {
        keyring: w.deps.keyring,
        ses,
        tracking: { secretKey: Buffer.alloc(32, 9), defaultBaseUrl: "https://track.example.com" },
      };
      const agent = await addInbox(w, { local: "tracked-agent" });
      const people = await addInbox(w, { local: "untracked-people", kind: "human" });
      for (const [inbox, tracked] of [
        [agent, true],
        [people, false],
      ] as const) {
        const emailId = await queuedEmail(
          { inboxId: inbox.id },
          '<p><a href="https://example.com/order">order</a></p>',
        );
        expect(await sendEmail(db, deps, { emailId })).toBe("sent");
        const mime = sends.at(-1)?.raw.toString("utf8").replace(/=\r\n/g, "") ?? "";
        expect(mime.includes("/t/c/")).toBe(tracked);
        expect(mime.includes("/t/o/")).toBe(tracked);
      }
    } finally {
      await setTracking(false);
    }
  });
});

describe("shared-domain mail, the team's SES tenant and the operator's switch", () => {
  /** A team of its own with one shared inbox, and a queued email from it. */
  async function sharedSender(slug: string) {
    const team = await seedWorld(db, slug);
    const inbox = await addInbox(team, { local: "bot", shared: true });
    const queue = () =>
      queuedEmail({
        teamId: team.teamId,
        domainId: null,
        from: inbox.emailAddress,
        inboxId: inbox.id,
      });
    return { team, queue };
  }
  const switches = (over: Partial<MonitorSettings>) => async () => ({
    ...MONITOR_SETTING_DEFAULTS,
    ...over,
  });
  const marker = async (teamId: string) =>
    (
      await db
        .select({ region: schema.sharedInboxDomains.sesTenantRegion })
        .from(schema.sharedInboxDomains)
        .where(eq(schema.sharedInboxDomains.teamId, teamId))
    )[0]?.region;

  it("a team's first shared send associates its tenant and names it, only while sharedInboxTenants is on", async () => {
    const { team, queue } = await sharedSender("tenant-first");
    const calls: string[] = [];
    const client: SesTenantClient = {
      async send(command) {
        calls.push(command.constructor.name);
        return { TenantArn: `arn:aws:ses:us-east-1:123456789012:tenant/${team.teamId}` };
      },
    };
    const sharedTenant = vi.fn(
      sharedTenantResolver(db, { client, region: "us-east-1", sharedInboxDomain: w.sharedDomain }),
    );
    let settings = switches({ sharedInboxTenants: true });
    const deps = () => ({
      keyring: w.deps.keyring,
      ses,
      defaultConfigurationSet: "default-set",
      sharedInboxDomain: w.sharedDomain,
      settings,
      sharedTenant,
    });

    for (const _ of [1, 2]) {
      expect(await sendEmail(db, deps(), { emailId: await queue() })).toBe("sent");
      expect(sends.at(-1)).toMatchObject({
        tenantName: team.teamId,
        configurationSetName: "default-set",
      });
      expect(sends.at(-1)?.region).toBeUndefined();
    }
    expect(sharedTenant).toHaveBeenCalledWith(team.teamId, "default-set");
    expect(calls).toEqual([
      "CreateTenantCommand",
      "CreateTenantResourceAssociationCommand",
      "CreateTenantResourceAssociationCommand",
    ]);
    expect(await marker(team.teamId)).toBe("us-east-1");

    settings = switches({ sharedInboxTenants: false });
    expect(await sendEmail(db, deps(), { emailId: await queue() })).toBe("sent");
    expect(sends.at(-1)?.tenantName).toBeUndefined();
    expect(sharedTenant).toHaveBeenCalledTimes(2);
  });

  it("a send SES refuses as not associated with the tenant forgets the marker and goes out once without it", async () => {
    const { team, queue } = await sharedSender("tenant-gone");
    await db
      .update(schema.sharedInboxDomains)
      .set({ sesTenantRegion: "us-east-1", sesTenantConfigSet: "default-set" })
      .where(eq(schema.sharedInboxDomains.teamId, team.teamId));
    const attempts: (string | undefined)[] = [];
    // The shapes live SES sends answered on 2026-10-14.
    const refusal = {
      name: "AccessDeniedException",
      message:
        "Tenant not associated with resources [arn:aws:ses:us-east-1:111122223333:identity/agents.example.test].",
    };
    const refusing: SesSender = {
      async sendRaw(params) {
        attempts.push(params.tenantName);
        if (params.tenantName) throw Object.assign(new Error(refusal.message), refusal);
        return { messageId: "mid-untenanted" };
      },
    };
    const deps = {
      keyring: w.deps.keyring,
      ses: refusing,
      defaultConfigurationSet: "default-set",
      sharedInboxDomain: w.sharedDomain,
      settings: switches({ sharedInboxTenants: true }),
      sharedTenant: async () => team.teamId,
    };

    expect(await sendEmail(db, deps, { emailId: await queue() })).toBe("sent");
    expect(attempts).toEqual([team.teamId, undefined]);
    expect(await marker(team.teamId)).toBeNull();

    // A paused or disabled tenant is never routed around. Paused: the claim
    // is released for the job's retry, and nothing went out without the tenant.
    attempts.length = 0;
    refusal.name = "SendingPausedException";
    refusal.message = "Sending is paused for this tenant";
    const paused = await queue();
    await expect(sendEmail(db, deps, { emailId: paused })).rejects.toThrow(/paused/);
    expect(attempts).toEqual([team.teamId]);
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, paused));
    expect(row).toMatchObject({ latestStatus: "queued", sentAt: null });

    // Disabled: SES rejects the message outright, and it is never resent without the tenant.
    attempts.length = 0;
    refusal.name = "MessageRejected";
    refusal.message =
      "Sending disabled for <arn:aws:ses:us-east-1:111122223333:tenant/t/tn-0>. For more information, please check the resource configuration and status.";
    const disabled = await queue();
    expect(await sendEmail(db, deps, { emailId: disabled })).toBe("failed");
    expect(attempts).toEqual([team.teamId]);
  });

  it("holds queued shared-domain mail while the operator has shared sending off", async () => {
    const { team, queue } = await sharedSender("shared-off");
    let sending = false;
    const rescheduled: Date[] = [];
    const deps = {
      keyring: w.deps.keyring,
      ses,
      sharedInboxDomain: w.sharedDomain,
      settings: async () => ({ ...MONITOR_SETTING_DEFAULTS, sharedInboxSend: sending }),
      reschedule: async (_id: string, at: Date) => void rescheduled.push(at),
    };
    const emailId = await queue();
    const sent = sends.length;

    expect(await sendEmail(db, deps, { emailId })).toBe("deferred");
    expect(sends).toHaveLength(sent);
    expect(rescheduled[0]?.getTime()).toBeGreaterThan(Date.now());
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
    expect(row).toMatchObject({ latestStatus: "queued", sentAt: null });

    // The team's own domain is not the shared domain: the switch never holds it.
    const own = await queuedEmail({
      teamId: team.teamId,
      domainId: team.domainId,
      from: `a@${team.domain}`,
    });
    expect(await sendEmail(db, deps, { emailId: own })).toBe("sent");

    sending = true;
    expect(await sendEmail(db, deps, { emailId })).toBe("sent");
    expect(sends.at(-1)?.emailId).toBe(emailId);
  });
});

describe("the inbox.forward job", () => {
  it("passes a delivered message on to the inbox's owners from the inbox address", async () => {
    const inbox = await addInbox(w, { local: "forwarder", safety: { forward_to: [w.owner] } });
    const threadId = await addThread(w, inbox.id);
    const received = await receive(w, { inbox, threadId });
    await forwardToOwners(db, w.deps, { receivedEmailId: received.id, inboxId: inbox.id });
    const [email] = await db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.inboxId, inbox.id));
    expect(email).toMatchObject({ from: inbox.emailAddress, to: [w.owner], threadId });
    const marker = email?.headers?.["X-MillionSend-Forwarded"] ?? "";
    expect(marker.startsWith(`${inbox.id}.`)).toBe(true);
    expect(verifyForwardMarker(w.keys, marker)).toBe(true);
  });

  it("logs a refusal by its name only and does not retry it", async () => {
    const team = await seedWorld(db, "worker-suppressed");
    const inbox = await addInbox(team, {
      local: "forwarder",
      safety: { forward_to: [team.owner] },
    });
    const threadId = await addThread(team, inbox.id);
    const received = await receive(team, { inbox, threadId });
    await db.insert(schema.suppressions).values({
      teamId: team.teamId,
      email: team.owner,
      emailHash: hashRecipient(team.owner),
      reason: "hard_bounce",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await forwardToOwners(db, team.deps, { receivedEmailId: received.id, inboxId: inbox.id });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain(
        `${received.id} inbox=${inbox.id} not forwarded (all_recipients_suppressed)`,
      );
      expect(line).not.toContain("@");
    } finally {
      warn.mockRestore();
    }
  });
});
