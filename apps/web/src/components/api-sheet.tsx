"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  siDotnet,
  siElixir,
  siGo,
  siNodedotjs,
  siOpenjdk,
  siPhp,
  siPython,
  siRuby,
  siRust,
} from "simple-icons";
import { CodeHighlight, type HighlightLanguage } from "@/components/code-highlight";
import { Drawer } from "@/components/drawer";
import { CodeGlyph } from "@/components/icons/nav-icons";

/* Snippets per SDK — the real published packages, shown with a placeholder
   key. Kept to the three calls people reach for from the Emails surface. */
const LANGS = ["node", "python", "php", "ruby", "go", "rust", "java", "dotnet", "elixir"] as const;
type Lang = (typeof LANGS)[number];

const LANG_META: Record<Lang, { label: string; hljs: HighlightLanguage; icon: { path: string } }> =
  {
    node: { label: "Node.js", hljs: "javascript", icon: siNodedotjs },
    python: { label: "Python", hljs: "python", icon: siPython },
    php: { label: "PHP", hljs: "php", icon: siPhp },
    ruby: { label: "Ruby", hljs: "ruby", icon: siRuby },
    go: { label: "Go", hljs: "go", icon: siGo },
    rust: { label: "Rust", hljs: "rust", icon: siRust },
    // Java's own mark is trademark-restricted; OpenJDK is the ecosystem icon.
    java: { label: "Java", hljs: "java", icon: siOpenjdk },
    dotnet: { label: ".NET", hljs: "csharp", icon: siDotnet },
    elixir: { label: "Elixir", hljs: "elixir", icon: siElixir },
  };

function LangIcon({ path }: { path: string }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

interface Snippets {
  send: string;
  batch: string;
  retrieve: string;
}

const SNIPPETS: Record<Lang, Snippets> = {
  node: {
    send: `import { MillionSend } from "millionsend";

const ms = new MillionSend("ms_xxxxxxxxx");

await ms.emails.send({
  from: "Acme <onboarding@yourdomain.com>",
  to: ["delivered@resend.dev"],
  subject: "hello world",
  html: "<p>it works!</p>",
});`,
    batch: `await ms.batch.send([
  {
    from: "Acme <onboarding@yourdomain.com>",
    to: ["foo@gmail.com"],
    subject: "hello world",
    html: "<h1>it works!</h1>",
  },
  {
    from: "Acme <onboarding@yourdomain.com>",
    to: ["bar@outlook.com"],
    subject: "world hello",
    html: "<p>it works!</p>",
  },
]);`,
    retrieve: `const { data, error } = await ms.emails.get(
  "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
);`,
  },
  python: {
    send: `import millionsend

millionsend.api_key = "ms_xxxxxxxxx"

millionsend.Emails.send({
    "from": "Acme <onboarding@yourdomain.com>",
    "to": ["delivered@resend.dev"],
    "subject": "hello world",
    "html": "<p>it works!</p>",
})`,
    batch: `millionsend.Batch.send([
    {
        "from": "Acme <onboarding@yourdomain.com>",
        "to": ["foo@gmail.com"],
        "subject": "hello world",
        "html": "<h1>it works!</h1>",
    },
    {
        "from": "Acme <onboarding@yourdomain.com>",
        "to": ["bar@outlook.com"],
        "subject": "world hello",
        "html": "<p>it works!</p>",
    },
])`,
    retrieve: `email = millionsend.Emails.get(
    "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"
)`,
  },
  php: {
    send: `$ms = MillionSend\\MillionSend::client('ms_xxxxxxxxx');

$ms->emails->send([
    'from' => 'Acme <onboarding@yourdomain.com>',
    'to' => ['delivered@resend.dev'],
    'subject' => 'hello world',
    'html' => '<p>it works!</p>',
]);`,
    batch: `$ms->batch->send([
    [
        'from' => 'Acme <onboarding@yourdomain.com>',
        'to' => ['foo@gmail.com'],
        'subject' => 'hello world',
        'html' => '<h1>it works!</h1>',
    ],
    [
        'from' => 'Acme <onboarding@yourdomain.com>',
        'to' => ['bar@outlook.com'],
        'subject' => 'world hello',
        'html' => '<p>it works!</p>',
    ],
]);`,
    retrieve: `$email = $ms->emails->get(
    '4ef9a417-02e9-4d39-ad75-9611e0fcc33c'
);`,
  },
  ruby: {
    send: `Millionsend.api_key = "ms_xxxxxxxxx"

Millionsend::Emails.send(
  from: "Acme <onboarding@yourdomain.com>",
  to: "delivered@resend.dev",
  subject: "hello world",
  html: "<p>it works!</p>"
)`,
    batch: `Millionsend::Batch.send([
  {
    from: "Acme <onboarding@yourdomain.com>",
    to: ["foo@gmail.com"],
    subject: "hello world",
    html: "<h1>it works!</h1>"
  },
  {
    from: "Acme <onboarding@yourdomain.com>",
    to: ["bar@outlook.com"],
    subject: "world hello",
    html: "<p>it works!</p>"
  }
])`,
    retrieve: `email = Millionsend::Emails.get(
  "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"
)`,
  },
  go: {
    send: `client := millionsend.NewClient("ms_xxxxxxxxx")

sent, err := client.Emails.Send(&millionsend.SendEmailRequest{
    From:    "Acme <onboarding@yourdomain.com>",
    To:      []string{"delivered@resend.dev"},
    Subject: "hello world",
    Html:    "<p>it works!</p>",
})`,
    batch: `batch, err := client.Batch.Send([]*millionsend.SendEmailRequest{
    {
        From:    "Acme <onboarding@yourdomain.com>",
        To:      []string{"foo@gmail.com"},
        Subject: "hello world",
        Html:    "<h1>it works!</h1>",
    },
    {
        From:    "Acme <onboarding@yourdomain.com>",
        To:      []string{"bar@outlook.com"},
        Subject: "world hello",
        Html:    "<p>it works!</p>",
    },
})`,
    retrieve: `email, err := client.Emails.Get(
    "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
)`,
  },
  rust: {
    send: `let ms = MillionSend::new("ms_xxxxxxxxx");

let email = CreateEmailBaseOptions::new(
    "Acme <onboarding@yourdomain.com>",
    ["delivered@resend.dev"],
    "hello world",
)
.with_html("<p>it works!</p>");

ms.emails.send(email).await?;`,
    batch: `let emails = vec![
    CreateEmailBaseOptions::new(
        "Acme <onboarding@yourdomain.com>",
        ["foo@gmail.com"],
        "hello world",
    )
    .with_html("<h1>it works!</h1>"),
    CreateEmailBaseOptions::new(
        "Acme <onboarding@yourdomain.com>",
        ["bar@outlook.com"],
        "world hello",
    )
    .with_html("<p>it works!</p>"),
];

ms.batch.send(emails).await?;`,
    retrieve: `let email = ms
    .emails
    .get("4ef9a417-02e9-4d39-ad75-9611e0fcc33c")
    .await?;`,
  },
  java: {
    send: `MillionSend ms = new MillionSend("ms_xxxxxxxxx");

CreateEmailOptions email = CreateEmailOptions.builder()
    .from("Acme <onboarding@yourdomain.com>")
    .to("delivered@resend.dev")
    .subject("hello world")
    .html("<p>it works!</p>")
    .build();

ms.emails().send(email);`,
    batch: `ms.batch().send(List.of(
    CreateEmailOptions.builder()
        .from("Acme <onboarding@yourdomain.com>")
        .to("foo@gmail.com")
        .subject("hello world")
        .html("<h1>it works!</h1>")
        .build(),
    CreateEmailOptions.builder()
        .from("Acme <onboarding@yourdomain.com>")
        .to("bar@outlook.com")
        .subject("world hello")
        .html("<p>it works!</p>")
        .build()
));`,
    retrieve: `Email email = ms.emails().get(
    "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"
);`,
  },
  dotnet: {
    send: `var ms = new MillionSendClient("ms_xxxxxxxxx");

await ms.EmailSendAsync(new EmailMessage
{
    From = "Acme <onboarding@yourdomain.com>",
    To = new[] { "delivered@resend.dev" },
    Subject = "hello world",
    Html = "<p>it works!</p>",
});`,
    batch: `await ms.EmailBatchAsync(new[]
{
    new EmailMessage
    {
        From = "Acme <onboarding@yourdomain.com>",
        To = new[] { "foo@gmail.com" },
        Subject = "hello world",
        Html = "<h1>it works!</h1>",
    },
    new EmailMessage
    {
        From = "Acme <onboarding@yourdomain.com>",
        To = new[] { "bar@outlook.com" },
        Subject = "world hello",
        Html = "<p>it works!</p>",
    },
});`,
    retrieve: `var email = await ms.EmailRetrieveAsync(
    Guid.Parse("4ef9a417-02e9-4d39-ad75-9611e0fcc33c")
);`,
  },
  elixir: {
    send: `client = MillionSend.client(api_key: "ms_xxxxxxxxx")

MillionSend.Emails.send(client, %{
  from: "Acme <onboarding@yourdomain.com>",
  to: ["delivered@resend.dev"],
  subject: "hello world",
  html: "<p>it works!</p>"
})`,
    batch: `MillionSend.Emails.send_batch(client, [
  %{
    from: "Acme <onboarding@yourdomain.com>",
    to: ["foo@gmail.com"],
    subject: "hello world",
    html: "<h1>it works!</h1>"
  },
  %{
    from: "Acme <onboarding@yourdomain.com>",
    to: ["bar@outlook.com"],
    subject: "world hello",
    html: "<p>it works!</p>"
  }
])`,
    retrieve: `{:ok, email} = MillionSend.Emails.get(
  client,
  "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"
)`,
  },
};

/* curl sheets for the non-email resources. The paths mirror apps/api exactly
   (/contacts, /segments, /topics, /broadcasts, /domains, /api-keys); `ns` is
   the message-namespace prefix carrying apiSheet.{title,<section>} keys. */
const API_BASE = "https://api.millionsend.com";
const AUTH = `-H "Authorization: Bearer ms_xxxxxxxxx"`;
const JSON_CT = `-H "Content-Type: application/json"`;
const SAMPLE_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

export const RESOURCE_SHEETS = {
  contacts: {
    ns: "audience.contacts",
    sections: [
      ["list", `curl "${API_BASE}/contacts?limit=20" \\\n  ${AUTH}`],
      [
        "create",
        `curl -X POST "${API_BASE}/contacts" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{
    "email": "steve.wozniak@gmail.com",
    "first_name": "Steve",
    "last_name": "Wozniak",
    "unsubscribed": false
  }'`,
      ],
      [
        "update",
        `curl -X PATCH "${API_BASE}/contacts/${SAMPLE_ID}" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "unsubscribed": true }'`,
      ],
    ],
  },
  segments: {
    ns: "audience.segments",
    sections: [
      ["list", `curl "${API_BASE}/segments" \\\n  ${AUTH}`],
      [
        "create",
        `curl -X POST "${API_BASE}/segments" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{
    "name": "Gmail users",
    "filter": {
      "match": "all",
      "conditions": [
        { "field": "email", "op": "ends_with", "value": "@gmail.com" }
      ]
    }
  }'`,
      ],
      [
        "addContact",
        `curl -X POST \\
  "${API_BASE}/contacts/${SAMPLE_ID}/segments/b0f2a3c4-5d6e-4f70-8a91-b2c3d4e5f607" \\
  ${AUTH}`,
      ],
    ],
  },
  topics: {
    ns: "audience.topics",
    sections: [
      ["list", `curl "${API_BASE}/topics" \\\n  ${AUTH}`],
      [
        "create",
        `curl -X POST "${API_BASE}/topics" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{
    "name": "Product updates",
    "description": "New features and improvements",
    "default_subscription": "opt_in",
    "visibility": "public"
  }'`,
      ],
      [
        "update",
        `curl -X PATCH "${API_BASE}/topics/${SAMPLE_ID}" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "description": "Monthly product news", "visibility": "private" }'`,
      ],
    ],
  },
  broadcasts: {
    ns: "broadcasts",
    sections: [
      ["list", `curl "${API_BASE}/broadcasts?limit=20" \\\n  ${AUTH}`],
      [
        "create",
        `curl -X POST "${API_BASE}/broadcasts" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{
    "name": "Launch announcement",
    "segment_id": "${SAMPLE_ID}",
    "from": "Acme <news@yourdomain.com>",
    "subject": "We just launched",
    "html": "<p>Big news!</p>"
  }'`,
      ],
      [
        "send",
        `curl -X POST "${API_BASE}/broadcasts/${SAMPLE_ID}/send" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "scheduled_at": "in 1 hour" }'`,
      ],
    ],
  },
  domains: {
    ns: "domains",
    sections: [
      ["list", `curl "${API_BASE}/domains" \\\n  ${AUTH}`],
      [
        "create",
        `curl -X POST "${API_BASE}/domains" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "name": "yourdomain.com", "region": "us-east-1" }'`,
      ],
      ["verify", `curl -X POST "${API_BASE}/domains/${SAMPLE_ID}/verify" \\\n  ${AUTH}`],
    ],
  },
  apiKeys: {
    ns: "api-keys",
    sections: [
      ["list", `curl "${API_BASE}/api-keys" \\\n  ${AUTH}`],
      [
        "create",
        `curl -X POST "${API_BASE}/api-keys" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "name": "Production", "permission": "sending_access" }'`,
      ],
      ["revoke", `curl -X DELETE "${API_BASE}/api-keys/${SAMPLE_ID}" \\\n  ${AUTH}`],
    ],
  },
} satisfies Record<string, { ns: string; sections: readonly (readonly [string, string])[] }>;

type Resource = keyof typeof RESOURCE_SHEETS;

/**
 * "</>" affordance for the non-email list surfaces: same drawer as
 * ApiDocsButton, copy-ready curl calls against the public API. The key hint
 * is shared with the emails sheet (emails.apiSheet.keyHint).
 */
export function ResourceApiButton({ resource }: { resource: Resource }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const { ns, sections } = RESOURCE_SHEETS[resource];
  const title = t(`${ns}.apiSheet.title`);

  return (
    <>
      <button
        type="button"
        className="ms-btn ms-btn-icon"
        aria-label={title}
        onClick={() => setOpen(true)}
      >
        <CodeGlyph size={14} />
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={title}>
        {sections.map(([section, code]) => (
          <section key={section} style={{ marginTop: 22 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ms-bone)" }}>
              {t(`${ns}.apiSheet.${section}`)}
            </h3>
            <CodeBlock code={code} language="bash" />
          </section>
        ))}
        <p style={{ margin: "20px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("emails.apiSheet.keyHint")}
        </p>
      </Drawer>
    </>
  );
}

function CodeBlock({ code, language }: { code: string; language: HighlightLanguage }) {
  return (
    <pre
      className="ms-mono ms-hl"
      style={{
        margin: "10px 0 0",
        padding: "14px 16px",
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        borderRadius: 10,
        fontSize: 12,
        lineHeight: 1.65,
        color: "var(--ms-bone)",
        overflowX: "auto",
      }}
    >
      <CodeHighlight code={code} language={language} />
    </pre>
  );
}

/**
 * "</>" affordance on the Emails surfaces: opens a drawer with copy-ready
 * send/batch/retrieve snippets for every official SDK, so the dashboard hands
 * developers straight to code (the Resend sheet, on our own packages).
 */
export function ApiDocsButton() {
  const t = useTranslations("emails");
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Lang>("node");
  const snippets = SNIPPETS[lang];

  return (
    <>
      <button
        type="button"
        className="ms-btn ms-btn-icon"
        aria-label={t("list.apiDocs")}
        onClick={() => setOpen(true)}
      >
        <CodeGlyph size={14} />
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t("apiSheet.title")}>
        <div
          role="tablist"
          aria-label={t("apiSheet.title")}
          className="ms-scroll-x"
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "nowrap",
            marginTop: 4,
            overflowX: "auto",
            paddingBottom: 4,
          }}
        >
          {LANGS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === lang}
              onClick={() => setLang(key)}
              style={{
                border: 0,
                borderRadius: 8,
                padding: "5px 10px",
                fontSize: 12.5,
                cursor: "pointer",
                background: key === lang ? "var(--ms-panel-raised)" : "none",
                color: key === lang ? "var(--ms-bone)" : "var(--ms-muted)",
                font: "inherit",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                flex: "none",
                whiteSpace: "nowrap",
              }}
            >
              <LangIcon path={LANG_META[key].icon.path} />
              {LANG_META[key].label}
            </button>
          ))}
        </div>

        {(
          [
            ["send", snippets.send],
            ["batch", snippets.batch],
            ["retrieve", snippets.retrieve],
          ] as const
        ).map(([section, code]) => (
          <section key={section} style={{ marginTop: 22 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ms-bone)" }}>
              {t(`apiSheet.${section}`)}
            </h3>
            <CodeBlock code={code} language={LANG_META[lang].hljs} />
          </section>
        ))}

        <p style={{ margin: "20px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("apiSheet.keyHint")}
        </p>
      </Drawer>
    </>
  );
}
