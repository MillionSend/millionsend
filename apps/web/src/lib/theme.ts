export type Theme = "dark" | "light";

/* localStorage key; mirrored to a same-named cookie so SSR can render the
   attribute and avoid a theme flash. */
export const THEME_KEY = "ms-theme";

/* Dark is the default: the html attribute only ever carries "light"; absent
   means dark. System preference is deliberately not followed — the toggle in
   the account menu is the only switch. */
export function applyTheme(theme: Theme): void {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage may be unavailable (private mode); the cookie still persists it */
  }
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is Chromium-only; this is a single first-party cookie write
  document.cookie = `${THEME_KEY}=${theme}; path=/; max-age=31536000; samesite=lax`;
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/* Inlined in the root layout so it runs before first paint. localStorage is
   the source of truth; the SSR cookie only pre-seeds the attribute, so a
   stale cookie gets corrected here before anything renders. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light")document.documentElement.setAttribute("data-theme","light");else if(t==="dark")document.documentElement.removeAttribute("data-theme")}catch(e){}`;
