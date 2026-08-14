/**
 * Nav icons from the design canvas (assets/icons/*.svg), inlined with
 * stroke=currentColor so the nav's muted→bone color states drive them.
 * 18×18 viewBox, 1.4 stroke, round caps/joins — do not add icons outside
 * this set without a design pass (text is the icon system otherwise).
 */

const PATHS: Record<string, React.ReactNode> = {
  emails: (
    <>
      <rect x="2.5" y="4" width="13" height="10" rx="1.8" />
      <path d="M3.5 5.5 L9 10 L14.5 5.5" />
    </>
  ),
  broadcasts: (
    <>
      <circle cx="9" cy="9" r="1.9" />
      <path d="M5.11 5.11a5.5 5.5 0 0 0 0 7.78 M12.89 5.11a5.5 5.5 0 0 1 0 7.78" />
    </>
  ),
  audience: (
    <>
      <circle cx="6.6" cy="6.4" r="2.3" />
      <path d="M2.6 15a4.1 4.1 0 0 1 8 0" />
      <circle cx="12.7" cy="7" r="1.8" />
      <path d="M12.5 11.3a3.5 3.5 0 0 1 3 3.7" />
    </>
  ),
  metrics: <path d="M4 15V9 M9 15V4.5 M14 15v-4" />,
  domains: (
    <>
      <circle cx="9" cy="9" r="6.4" />
      <ellipse cx="9" cy="9" rx="2.9" ry="6.4" />
      <path d="M2.6 9h12.8" />
    </>
  ),
  logs: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="1.5" />
      <path d="M5.4 7.2l2.3 1.8-2.3 1.8 M9.6 11.3h3" />
    </>
  ),
  "api-keys": (
    <>
      <circle cx="6.2" cy="6.2" r="2.9" />
      <path d="M8.3 8.3l6.5 6.5 M12.3 12.3l1.7-1.7 M10.3 10.3l1.7-1.7" />
    </>
  ),
  webhooks: (
    <>
      <circle cx="9" cy="4.9" r="1.8" />
      <circle cx="4.4" cy="13.4" r="1.8" />
      <circle cx="13.6" cy="13.4" r="1.8" />
      <path d="M8.2 6.6l-2.9 5.1 M9.8 6.6l2.9 5.1 M6.2 13.4h5.6" />
    </>
  ),
  templates: (
    <>
      <path d="M5.2 2.5h4.6l3.5 3.5v8.6a.9.9 0 0 1-.9.9H5.2a.9.9 0 0 1-.9-.9V3.4a.9.9 0 0 1 .9-.9z" />
      <path d="M9.8 2.7v3.2h3.2 M6.6 9.6h4.8 M6.6 12h3.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="9" cy="9" r="2.3" />
      <path d="M9 2.6v2 M9 13.4v2 M2.6 9h2 M13.4 9h2 M4.5 4.5l1.4 1.4 M12.1 12.1l1.4 1.4 M13.5 4.5l-1.4 1.4 M5.9 12.1l-1.4 1.4" />
    </>
  ),
};

export type NavIconName = keyof typeof PATHS;

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
