"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Drawer } from "@/components/drawer";
import { CodeGlyph } from "@/components/icons/nav-icons";

/* Snippets per SDK — the real published packages, shown with a placeholder
   key. Kept to the three calls people reach for from the Emails surface. */
const LANGS = ["node", "python", "php", "ruby", "go", "rust", "java", "dotnet", "elixir"] as const;
type Lang = (typeof LANGS)[number];

const LANG_LABEL: Record<Lang, string> = {
  node: "Node.js",
  python: "Python",
  php: "PHP",
  ruby: "Ruby",
  go: "Go",
  rust: "Rust",
  java: "Java",
  dotnet: ".NET",
  elixir: "Elixir",
};

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

function CodeBlock({ code }: { code: string }) {
  return (
    <pre
      className="ms-mono"
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
      {code}
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
          style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}
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
              }}
            >
              {LANG_LABEL[key]}
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
            <CodeBlock code={code} />
          </section>
        ))}

        <p style={{ margin: "20px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("apiSheet.keyHint")}
        </p>
      </Drawer>
    </>
  );
}
