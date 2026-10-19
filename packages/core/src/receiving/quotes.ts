/**
 * Quoted history and signatures in a reply's text, in the languages the
 * product serves (en, pt-BR, es) plus fr and de attributions. Mail clients
 * mark quotes in HTML too (the markers below, and blockquote type=cite); the
 * read pipeline cuts those before this runs. No imports: the dashboard reads
 * received mail with the same rules.
 */

/** Classes mail clients give the element that holds a reply's quoted history. */
export const QUOTE_CLASSES = [
  "gmail_quote",
  "gmail_quote_container",
  "moz-cite-prefix",
  "yahoo_quoted",
  "protonmail_quote",
] as const;
/**
 * Ids, lowercased, Outlook gives the element where a reply's quoted original
 * starts: it and everything after it are history.
 */
export const OUTLOOK_QUOTE_IDS = ["divrplyfwdmsg", "appendonsend", "stopspelling"] as const;

const ATTRIBUTION = [
  /^On\b.{4,300}\bwrote:\s*$/i,
  /^Em\b.{4,300}\bescreveu:\s*$/i,
  /^El\b.{4,300}\bescribi[oó]:\s*$/i,
  /^Le\b.{4,300}\ba [ée]crit\s*:\s*$/i,
  /^Am\b.{4,300}\bschrieb\b.{0,80}:\s*$/i,
];
const ATTRIBUTION_START = /^(?:On|Em|El|Le|Am)\b/;
const SEPARATOR = /^-{2,}\s*(?:Original Message|Mensagem original|Mensaje original)\s*-{2,}$/i;
const FORWARD_MARK =
  /^(?:-{2,}\s*(?:Forwarded message|Mensagem encaminhada|Mensaje reenviado|Message transf[ée]r[ée]|Weitergeleitete Nachricht)\s*-{2,}|Begin forwarded message:|In[ií]cio da mensagem encaminhada:|Inicio del mensaje reenviado:)$/i;
const HEADER_FROM = /^\*?(?:From|De|Von)\*?:\s*\S/i;
const HEADER_REST =
  /^\*?(?:Sent|Date|Enviado|Enviada em|Data|Fecha|Gesendet|To|Para|An|Subject|Assunto|Asunto|Betreff|Cc)\*?:/i;
const MOBILE_FOOTER =
  /^(?:Sent from my |Enviado do meu |Enviado desde mi |Get Outlook for |Obter o Outlook para |Obtener Outlook para |Sent from Outlook|Enviado do Outlook|Enviado desde Outlook|Sent from Yahoo Mail|Enviado do Yahoo Mail|Enviado desde Yahoo Mail)/i;
/** An RFC 3676 signature runs at most this many lines; a "--" earlier is a divider. */
const SIGNATURE_MAX_LINES = 15;

/** Whether text carries a forwarded message: forwarded content inherits no trust. */
export function hasForwardMarker(text: string): boolean {
  return text.split("\n").some((line) => FORWARD_MARK.test(line.trim()));
}

export interface TextQuotes {
  /** What the sender wrote this time. */
  reply: string;
  quoted: string;
  signature: string;
}

/** Where the quoted history starts in `lines`, or lines.length when there is none. */
function quoteStart(lines: string[]): number {
  // Where the run of ">", blank and mobile-footer lines that ends the text starts.
  let tail = lines.length;
  while (tail > 0) {
    const line = (lines[tail - 1] as string).trim();
    if (line && !line.startsWith(">") && !MOBILE_FOOTER.test(line)) break;
    tail--;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    // A forwarded original is what the sender wants read: nothing after its marker is cut.
    if (FORWARD_MARK.test(line)) return lines.length;
    // Clients wrap a long attribution, so it is also read joined with the next line.
    const joined = i + 1 < lines.length ? `${line} ${(lines[i + 1] as string).trim()}` : line;
    if (
      ATTRIBUTION.some((r) => r.test(line)) ||
      (ATTRIBUTION_START.test(line) && ATTRIBUTION.some((r) => r.test(joined)))
    ) {
      return i;
    }
    if (SEPARATOR.test(line)) return i;
    if (HEADER_FROM.test(line)) {
      const next = lines.slice(i + 1, i + 6).map((l) => l.trim());
      if (next.filter((l) => HEADER_REST.test(l)).length >= 2) {
        // A rule of underscores right above Outlook's header block belongs to it.
        return i > 0 && /^_{10,}$/.test((lines[i - 1] as string).trim()) ? i - 1 : i;
      }
    }
    // A trailing ">" block only: answers written between quoted lines stay in the reply.
    if (line.startsWith(">") && i >= tail) return i;
  }
  return lines.length;
}

/** Splits plain text into the new reply, the quoted history and a trailing signature. */
export function splitTextQuotes(text: string): TextQuotes {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cut = quoteStart(lines);
  let replyLines = lines.slice(0, cut);
  let quoted = lines.slice(cut).join("\n").trim();
  // Bottom-posting: nothing above the quote, the answer below its ">" block.
  if (cut < lines.length && replyLines.every((l) => !l.trim())) {
    let end = cut + 1;
    while (end < lines.length && (/^\s*>/.test(lines[end] as string) || !lines[end]?.trim())) {
      end++;
    }
    if (end < lines.length) {
      quoted = lines.slice(cut, end).join("\n").trim();
      replyLines = lines.slice(end);
    }
  }
  let signature = "";
  const sigAt = replyLines.findLastIndex((l) => l === "-- " || l === "--");
  if (sigAt >= 0 && replyLines.length - sigAt - 1 <= SIGNATURE_MAX_LINES) {
    signature = replyLines
      .slice(sigAt + 1)
      .join("\n")
      .trim();
    replyLines = replyLines.slice(0, sigAt);
  } else {
    const last = replyLines.findLastIndex((l) => l.trim() !== "");
    if (last >= 0 && MOBILE_FOOTER.test((replyLines[last] as string).trim())) {
      signature = (replyLines[last] as string).trim();
      replyLines = replyLines.slice(0, last);
    }
  }
  return { reply: replyLines.join("\n").trim(), quoted, signature };
}
