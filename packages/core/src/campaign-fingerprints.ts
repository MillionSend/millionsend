import type { CampaignFingerprintKind } from "@millionsend/db/schema";
import { getDomainWithoutSuffix } from "tldts";
import { decodeEntities, stripHiddenElements } from "./abuse-judge/body.js";
import { stripInvisible } from "./customer-text.js";
import { extractAnchors, visibleText } from "./email-insights.js";
import { sha256Hex } from "./hash.js";
import { ownerDomain } from "./org-domain.js";
import { parseMailbox } from "./sender-address.js";

/**
 * The fingerprints that tie a returning phisher to a team suspended for
 * phishing, and the rules that compare them. Only teams suspended for
 * phishing are ever compared, so the fuzzy rules below can be generous
 * enough to see through a renamed campaign and still stay clear of
 * legitimate senders. Exact kinds (phone, text hash, card, IP, address)
 * match on equal values.
 */

export interface Fingerprint {
  kind: CampaignFingerprintKind;
  value: string;
}

/** Display names: both need this many distinctive words... */
export const DISPLAY_NAME_MIN_WORDS = 2;
/** ...the shorter's all in the longer, which may carry this many more ("Service Facture Vexto"). */
export const DISPLAY_NAME_MAX_EXTRA_WORDS = 1;
/** Subjects: both need this many words, numbers left out... */
export const SUBJECT_MIN_WORDS = 4;
/** ...and this much overlap between their word sets (shared over all), so only near-identical lines meet. */
export const SUBJECT_MIN_SIMILARITY = 0.75;
/** Domains: one name's distinctive words, at least this many... */
export const DOMAIN_MIN_WORDS = 2;
/** ...all found in the other name, making up this share of its letters. */
export const DOMAIN_MIN_COVERAGE = 0.8;
/** Shorter words in a domain name (fr, bnp, app) tell nothing apart. */
export const DOMAIN_MIN_WORD_LENGTH = 4;
/** Two sending domains with one name under different suffixes match from this length. */
export const DOMAIN_SAME_NAME_MIN_LENGTH = 8;
/** A phone number is compared by its last digits: the same line with or without its country code or trunk 0. */
export const PHONE_KEY_DIGITS = 9;
/** Visible text shorter than this, in letters, is not a template worth a hash. */
export const TEXT_HASH_MIN_LETTERS = 60;

/**
 * Words that name a role rather than a sender, folded as fingerprintWords
 * folds them: "Support", "Equipe Financeiro" or "No reply" says nothing
 * about who sent the mail.
 */
const ROLE_WORDS = new Set([
  "no",
  "reply",
  "noreply",
  "donotreply",
  "do",
  "not",
  "nao",
  "responda",
  "team",
  "equipe",
  "support",
  "suporte",
  "service",
  "servico",
  "customer",
  "client",
  "cliente",
  "care",
  "help",
  "contact",
  "contato",
  "info",
  "news",
  "newsletter",
  "notification",
  "notificacao",
  "notificacoe",
  "alert",
  "alerta",
  "billing",
  "cobranca",
  "financeiro",
  "account",
  "conta",
  "admin",
  "sale",
  "venda",
  "marketing",
  "hello",
  "ola",
  "the",
  "de",
  "da",
  "du",
  "la",
  "le",
  "et",
  "and",
  "of",
]);

/**
 * Words every platform, mailer and lure puts in its hostnames: a domain made
 * of them says nothing about who holds it.
 */
const HOSTNAME_WORDS = new Set([
  "mail",
  "email",
  "mailer",
  "mailing",
  "news",
  "info",
  "inbox",
  "send",
  "sender",
  "secure",
  "login",
  "signin",
  "account",
  "verify",
  "verification",
  "update",
  "support",
  "service",
  "online",
  "shop",
  "store",
  "official",
  "group",
  "cloud",
  "link",
  "click",
  "track",
  "tracking",
  "page",
  "home",
  "portal",
  "docs",
  "drive",
  "form",
  "file",
  "download",
  "office",
  "live",
  "mobile",
  "auth",
  "static",
  "image",
  "site",
  "list",
  "manage",
  "notify",
  "alert",
  "client",
  "cliente",
  "conta",
  "acesso",
]);

const PHONE_RUN = /\+?\d[\d\s().-]{6,}\d/g;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;

/** Lowercase, accents and compatibility forms folded, invisible characters gone. */
function fold(text: string): string {
  return stripInvisible(text)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * The words of a name, subject or domain: runs of letters and digits,
 * folded, a plural "s" dropped from words of five letters or more so
 * "Factures" meets "facture" and "vextos" meets "vexto".
 */
function fingerprintWords(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).map((word) =>
    word.length >= 5 && word.endsWith("s") ? word.slice(0, -1) : word,
  );
}

function senderWords(name: string): Set<string> {
  return new Set(
    fingerprintWords(name).filter(
      (word) => word.length > 1 && !/^\d+$/.test(word) && !ROLE_WORDS.has(word),
    ),
  );
}

/**
 * "Facture Vexto" meets "Factures Vexto" and "Service Facture Vexto", never
 * "Vexto Video", and a lone "Facture" or "Support" meets nothing.
 */
export function displayNamesMatch(a: string, b: string): boolean {
  const [small, large] = [senderWords(a), senderWords(b)].sort((x, y) => x.size - y.size) as [
    Set<string>,
    Set<string>,
  ];
  return (
    small.size >= DISPLAY_NAME_MIN_WORDS &&
    large.size - small.size <= DISPLAY_NAME_MAX_EXTRA_WORDS &&
    [...small].every((word) => large.has(word))
  );
}

function subjectWords(subject: string): Set<string> {
  return new Set(fingerprintWords(subject).filter((word) => !/\d/.test(word)));
}

/**
 * Near-identical subjects: "Votre facture Vexto du 02/10 est disponible"
 * meets the same line dated 04/10 and the one without "du"; "Votre colis est
 * disponible" stays apart. Numbers are left out, since dates, amounts and
 * order numbers change from one email to the next.
 */
export function subjectsMatch(a: string, b: string): boolean {
  const x = subjectWords(a);
  const y = subjectWords(b);
  if (x.size < SUBJECT_MIN_WORDS || y.size < SUBJECT_MIN_WORDS) return false;
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / (x.size + y.size - shared) >= SUBJECT_MIN_SIMILARITY;
}

/** The name a domain was registered under: "vexto-cadeaux" for mail.vexto-cadeaux.example. */
function registeredName(domain: string): string {
  return getDomainWithoutSuffix(domain, { allowPrivateDomains: true }) ?? domain;
}

function nameWords(name: string): string[] {
  return [
    ...new Set(
      fingerprintWords(name).filter(
        (word) =>
          word.length >= DOMAIN_MIN_WORD_LENGTH && !/\d/.test(word) && !HOSTNAME_WORDS.has(word),
      ),
    ),
  ];
}

/** Whether `words` all appear in `letters` and make up enough of them. */
function covers(words: string[], letters: string): boolean {
  if (words.length < DOMAIN_MIN_WORDS || !words.every((word) => letters.includes(word))) {
    return false;
  }
  const length = words.reduce((sum, word) => sum + word.length, 0);
  return length >= DOMAIN_MIN_COVERAGE * letters.length;
}

/**
 * vexto-cadeaux.example, vextos-cadeaux.example and
 * cadeaux-vexto.example all meet: the words of one name are all in the
 * other, in any order, with or without hyphens, and nearly fill it. A name
 * made of one word, or of the words every hostname uses, never matches
 * that way; two sending domains of the same longer name under different
 * suffixes do.
 */
export function domainsMatch(a: Fingerprint, b: Fingerprint): boolean {
  const nameA = registeredName(a.value);
  const nameB = registeredName(b.value);
  const lettersA = fold(nameA).replace(/[^\p{L}\p{N}]+/gu, "");
  const lettersB = fold(nameB).replace(/[^\p{L}\p{N}]+/gu, "");
  if (covers(nameWords(nameA), lettersB) || covers(nameWords(nameB), lettersA)) return true;
  return (
    a.kind === "sending_domain" &&
    b.kind === "sending_domain" &&
    lettersA.length >= DOMAIN_SAME_NAME_MIN_LENGTH &&
    lettersA === lettersB
  );
}

/** Each phone-like run's last digits, for runs of 9 to 15 digits, the lengths phone numbers have. */
export function phoneKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const run of text.match(PHONE_RUN) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= PHONE_KEY_DIGITS && digits.length <= 15) {
      keys.add(digits.slice(-PHONE_KEY_DIGITS));
    }
  }
  return [...keys];
}

/**
 * The hash of the visible text reduced to its words: folded, with numbers,
 * links and addresses dropped, so one template sent to different people on
 * different days hashes alike. Null for text too short to be a template.
 */
export function visibleTextHash(text: string): string | null {
  const words = fold(text)
    .replace(/https?:\/\/\S+|\S+@\S+/g, " ")
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
  return words.replace(/ /g, "").length >= TEXT_HASH_MIN_LETTERS ? sha256Hex(words) : null;
}

function linkDomain(href: string): string | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    return ownerDomain(new URL(href).hostname);
  } catch {
    return null;
  }
}

export interface FingerprintMessage {
  from: string;
  subject: string;
  html: string | null;
  text: string | null;
}

/**
 * What one email carries: its sender's display name and domain, its
 * subject, the domains its links lead to, the phone numbers in what it
 * shows, and the hash of its visible text.
 */
export function messageFingerprints(message: FingerprintMessage): Fingerprint[] {
  const out: Fingerprint[] = [];
  const sender = parseMailbox(message.from);
  if (sender?.name?.trim()) out.push({ kind: "display_name", value: sender.name.trim() });
  if (sender) {
    const domain = sender.address.slice(sender.address.lastIndexOf("@") + 1).toLowerCase();
    out.push({ kind: "sending_domain", value: domain });
  }
  if (message.subject.trim()) out.push({ kind: "subject", value: message.subject.trim() });
  const shown =
    message.html === null
      ? (message.text ?? "")
      : decodeEntities(visibleText(stripHiddenElements(message.html).html));
  const hrefs = [
    ...(message.html === null ? [] : extractAnchors(message.html).map((anchor) => anchor.href)),
    ...((message.text ?? "").match(URL_IN_TEXT) ?? []),
  ];
  for (const domain of new Set(hrefs.flatMap((href) => linkDomain(href) ?? []))) {
    out.push({ kind: "link_domain", value: domain });
  }
  for (const key of phoneKeys(`${message.subject}\n${shown}\n${message.text ?? ""}`)) {
    out.push({ kind: "phone", value: key });
  }
  const hash = visibleTextHash(shown);
  if (hash) out.push({ kind: "text_hash", value: hash });
  return out;
}

/** Whether a team's fingerprint matches a stored one: the fuzzy rules for names, subjects and domains, equality for the rest. */
export function fingerprintsMatch(mine: Fingerprint, stored: Fingerprint): boolean {
  switch (mine.kind) {
    case "display_name":
      return stored.kind === "display_name" && displayNamesMatch(mine.value, stored.value);
    case "subject":
      return stored.kind === "subject" && subjectsMatch(mine.value, stored.value);
    case "sending_domain":
    case "link_domain":
      return (
        (stored.kind === "sending_domain" || stored.kind === "link_domain") &&
        domainsMatch(mine, stored)
      );
    default:
      return stored.kind === mine.kind && stored.value === mine.value;
  }
}
