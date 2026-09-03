import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { DeploymentTab, DeploymentTabs } from "./deployment-tabs";
import { CopyMarkdownButton } from "./page-actions";

/** `<CopyPrompt href="/prompts/x.md" copied="Copied">Copy the prompt</CopyPrompt>` in MDX. */
function CopyPrompt({
  href,
  copied,
  children,
}: {
  href: string;
  copied: string;
  children: string;
}) {
  return <CopyMarkdownButton markdownUrl={href} label={children} copiedLabel={copied} />;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tabs,
    Tab,
    DeploymentTabs,
    DeploymentTab,
    CopyPrompt,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
