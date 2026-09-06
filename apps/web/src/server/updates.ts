import { accountEmailFrom, env } from "@millionsend/config";
import {
  confirmSystemContact,
  deriveUpdatesKey,
  findSenderDomainOwner,
  makeUpdatesToken,
  type UpdatesSource,
  verifyUpdatesToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { appBaseUrl } from "@/lib/api-base-url";
import type { AppLocale } from "../i18n/request";
import {
  buildUpdatesConfirmEmail,
  defaultSystemMailDeps,
  type SystemMailDeps,
} from "./system-mail";

export const UPDATES_TOKEN_TTL_HOURS = 24;

function updatesKey(): Buffer | null {
  return env.MASTER_ENCRYPTION_KEY
    ? deriveUpdatesKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"))
    : null;
}

let warnedNoTeam = false;

/** Where product-updates subscribers live: the account-mail team, if there is one. */
export async function updatesTeam(db: Db): Promise<string | null> {
  const from = accountEmailFrom();
  const teamId = from ? ((await findSenderDomainOwner(db, from))?.teamId ?? null) : null;
  if (!teamId && !warnedNoTeam) {
    warnedNoTeam = true;
    console.warn(
      "product updates: no team holds a verified domain for the account sender; opt-ins are acknowledged but nothing is sent or stored",
    );
  }
  return teamId;
}

/**
 * First half of the double opt-in: a confirmation link to the address, and
 * nothing stored. False when this instance has no account-mail team or no
 * key to sign with; the endpoint answers the same either way, so it says
 * nothing about the instance or the address.
 */
export async function requestUpdatesConfirmation(
  db: Db,
  input: { email: string; source: UpdatesSource; locale: AppLocale },
  deps: SystemMailDeps = defaultSystemMailDeps,
): Promise<boolean> {
  const key = updatesKey();
  if (!key || !(await updatesTeam(db))) return false;
  const token = makeUpdatesToken({
    email: input.email,
    source: input.source,
    issuedAt: Date.now(),
    secretKey: key,
  });
  const url = new URL(`/updates/confirm?token=${encodeURIComponent(token)}`, appBaseUrl());
  try {
    await deps.send(
      buildUpdatesConfirmEmail({ to: input.email, url: url.toString(), locale: input.locale }),
    );
  } catch (error) {
    // A suppressed or undeliverable address answers like any other: the
    // caller's response must not say which addresses the team suppresses.
    console.warn("product updates: confirmation not sent", error);
  }
  return true;
}

/** The address and source a confirmation link carries, if it is intact and fresh. */
export function readUpdatesLink(token: string): { email: string; source: UpdatesSource } | null {
  const key = updatesKey();
  return key
    ? verifyUpdatesToken(token, key, { maxAgeMs: UPDATES_TOKEN_TTL_HOURS * 60 * 60 * 1000 })
    : null;
}

/**
 * Second half: the confirm button behind the link is the consent, so the
 * contact is created (or subscribed again) now. A form post, never the
 * link's GET — mail gateways open links, people press buttons.
 */
export async function confirmUpdatesSubscription(
  db: Db,
  token: string,
  locale: AppLocale,
): Promise<{ email: string } | null> {
  const verified = readUpdatesLink(token);
  if (!verified) return null;
  const teamId = await updatesTeam(db);
  if (!teamId) return null;
  await confirmSystemContact(db, teamId, {
    email: verified.email,
    name: "",
    source: verified.source,
    locale,
  });
  return { email: verified.email };
}
