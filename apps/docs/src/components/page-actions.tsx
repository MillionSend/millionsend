"use client";

import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
import { useState } from "react";
import type { PageActionLabels } from "@/lib/page-actions-copy";

/**
 * Copies the body behind a markdown URL — a page's .md rendition or a
 * prompt file — so it can be pasted straight into an agent.
 */
export function CopyMarkdownButton({
  markdownUrl,
  label,
  copiedLabel,
}: {
  markdownUrl: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonVariants({ variant: "secondary", size: "sm" })}
      onClick={async () => {
        const text = await fetch(markdownUrl).then((res) => res.text());
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
      {copied ? copiedLabel : label}
    </button>
  );
}

/**
 * Per-page actions under the title: copy the page as markdown, or open it
 * in an agent that will read the markdown URL itself.
 */
export function PageActions({
  markdownUrl,
  markdownHref,
  githubUrl,
  labels,
}: {
  /** Same-origin path the copy button fetches. */
  markdownUrl: string;
  /** Absolute markdown URL handed to the agents. */
  markdownHref: string;
  githubUrl: string;
  labels: PageActionLabels;
}) {
  const q = labels.prompt.replace("{url}", markdownHref);
  const items = [
    { title: labels.view, href: markdownUrl },
    { title: labels.claude, href: `https://claude.ai/new?${new URLSearchParams({ q })}` },
    {
      title: labels.chatgpt,
      href: `https://chatgpt.com/?${new URLSearchParams({ hints: "search", prompt: q })}`,
    },
    {
      title: labels.cursor,
      href: `https://cursor.com/link/prompt?${new URLSearchParams({ text: q })}`,
    },
    { title: labels.github, href: githubUrl },
  ];
  return (
    <div className="flex flex-row flex-wrap items-center gap-2 border-b pb-6">
      <CopyMarkdownButton
        markdownUrl={markdownUrl}
        label={labels.copy}
        copiedLabel={labels.copied}
      />
      <Popover>
        <PopoverTrigger className={buttonVariants({ variant: "secondary", size: "sm" })}>
          {labels.open}
          <span aria-hidden="true" className="text-fd-muted-foreground">
            ▾
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex flex-col p-1">
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-md px-2 py-1.5 text-sm hover:bg-fd-accent hover:text-fd-accent-foreground"
            >
              {item.title}
            </a>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
