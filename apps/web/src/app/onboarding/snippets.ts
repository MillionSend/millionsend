import { LANG_META } from "@/components/api-sheet";
import { LANGS } from "@/components/api-sheet-snippets";
import type { HighlightLanguage } from "@/components/code-highlight";
import { shellSingleQuote } from "@/lib/escape";

export const SNIPPET_LANGS = [...LANGS, "curl"] as const;
export type SnippetLang = (typeof SNIPPET_LANGS)[number];

export const SNIPPET_LABELS: Record<SnippetLang, string> = {
  ...Object.fromEntries(LANGS.map((l) => [l, LANG_META[l].label])),
  curl: "cURL",
} as Record<SnippetLang, string>;

export const SNIPPET_HLJS: Record<SnippetLang, HighlightLanguage> = {
  ...Object.fromEntries(LANGS.map((l) => [l, LANG_META[l].hljs])),
  curl: "bash",
} as Record<SnippetLang, HighlightLanguage>;

export interface SnippetParams {
  apiUrl: string;
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Rides the key line: what the shown key is (masked, real on copy…). */
  comment?: string | undefined;
}

/* Double-quoted literal: JSON escaping is a valid string literal in every
   SDK language here, and the values are addresses and one-line copy. */
const q = JSON.stringify;
const slashNote = (c?: string) => (c ? ` // ${c}` : "");
const hashNote = (c?: string) => (c ? ` # ${c}` : "");

/** The first-email call in each SDK's own idiom (mirrors api-sheet.tsx's send snippets). */
export function onboardingSnippet(lang: SnippetLang, p: SnippetParams): string {
  switch (lang) {
    case "node":
      return `import { MillionSend } from "millionsend";

const ms = new MillionSend(${q(p.apiKey)});${slashNote(p.comment)}

await ms.emails.send({
  from: ${q(p.from)},
  to: [${q(p.to)}],
  subject: ${q(p.subject)},
  html: ${q(p.html)},
});`;
    case "python":
      return `import millionsend

millionsend.api_key = ${q(p.apiKey)}${hashNote(p.comment)}

millionsend.Emails.send({
    "from": ${q(p.from)},
    "to": [${q(p.to)}],
    "subject": ${q(p.subject)},
    "html": ${q(p.html)},
})`;
    case "php":
      return `$ms = MillionSend\\MillionSend::client(${q(p.apiKey)});${slashNote(p.comment)}

$ms->emails->send([
    'from' => ${q(p.from)},
    'to' => [${q(p.to)}],
    'subject' => ${q(p.subject)},
    'html' => ${q(p.html)},
]);`;
    case "ruby":
      return `Millionsend.api_key = ${q(p.apiKey)}${hashNote(p.comment)}

Millionsend::Emails.send(
  from: ${q(p.from)},
  to: ${q(p.to)},
  subject: ${q(p.subject)},
  html: ${q(p.html)}
)`;
    case "go":
      return `client := millionsend.NewClient(${q(p.apiKey)})${slashNote(p.comment)}

sent, err := client.Emails.Send(&millionsend.SendEmailRequest{
    From:    ${q(p.from)},
    To:      []string{${q(p.to)}},
    Subject: ${q(p.subject)},
    Html:    ${q(p.html)},
})`;
    case "rust":
      return `let ms = MillionSend::new(${q(p.apiKey)});${slashNote(p.comment)}

let email = CreateEmailBaseOptions::new(
    ${q(p.from)},
    [${q(p.to)}],
    ${q(p.subject)},
)
.with_html(${q(p.html)});

ms.emails.send(email).await?;`;
    case "java":
      return `MillionSend ms = new MillionSend(${q(p.apiKey)});${slashNote(p.comment)}

CreateEmailOptions email = CreateEmailOptions.builder()
    .from(${q(p.from)})
    .to(${q(p.to)})
    .subject(${q(p.subject)})
    .html(${q(p.html)})
    .build();

ms.emails().send(email);`;
    case "dotnet":
      return `var ms = new MillionSendClient(${q(p.apiKey)});${slashNote(p.comment)}

await ms.EmailSendAsync(new EmailMessage
{
    From = ${q(p.from)},
    To = new[] { ${q(p.to)} },
    Subject = ${q(p.subject)},
    Html = ${q(p.html)},
});`;
    case "elixir":
      return `client = MillionSend.client(api_key: ${q(p.apiKey)})${hashNote(p.comment)}

MillionSend.Emails.send(client, %{
  from: ${q(p.from)},
  to: [${q(p.to)}],
  subject: ${q(p.subject)},
  html: ${q(p.html)}
})`;
    case "curl": {
      const body = JSON.stringify({ from: p.from, to: p.to, subject: p.subject, html: p.html });
      // The comment takes its own line so any selection of the command
      // itself is valid shell — an inline comment after a trailing "\\"
      // breaks the continuation when copied.
      return `${p.comment ? `# ${p.comment}\n` : ""}curl -X POST ${p.apiUrl}/emails \\
  -H ${shellSingleQuote(`Authorization: Bearer ${p.apiKey}`)} \\
  -H 'Content-Type: application/json' \\
  -d ${shellSingleQuote(body)}`;
    }
  }
}
