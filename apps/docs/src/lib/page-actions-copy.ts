/** Labels for the per-page copy/open actions; fumadocs keeps its own strings private. */
export interface PageActionLabels {
  copy: string;
  copied: string;
  open: string;
  view: string;
  claude: string;
  chatgpt: string;
  cursor: string;
  github: string;
  /** Prompt handed to the AI links; {url} is the page's markdown URL. */
  prompt: string;
}

const LABELS: Record<string, PageActionLabels> = {
  en: {
    copy: "Copy Markdown",
    copied: "Copied",
    open: "Open",
    view: "View as Markdown",
    claude: "Open in Claude",
    chatgpt: "Open in ChatGPT",
    cursor: "Open in Cursor",
    github: "Open in GitHub",
    prompt: "Read {url}, I want to ask questions about it.",
  },
  "pt-BR": {
    copy: "Copiar Markdown",
    copied: "Copiado",
    open: "Abrir",
    view: "Ver como Markdown",
    claude: "Abrir no Claude",
    chatgpt: "Abrir no ChatGPT",
    cursor: "Abrir no Cursor",
    github: "Abrir no GitHub",
    prompt: "Leia {url}, quero fazer perguntas sobre a página.",
  },
};

export function pageActionLabels(lang: string): PageActionLabels {
  return LABELS[lang] ?? (LABELS.en as PageActionLabels);
}
