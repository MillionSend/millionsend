import { Breakable } from "@/components/breakable";

/**
 * A subdomain field and the domain it sits under, read as "<input>.<domain>".
 * The suffix stays beside the input while both fit and takes a line of its
 * own under it when they don't; there a domain longer than the line breaks
 * between its labels, or inside one as a last resort, instead of running off
 * the screen.
 */
export function SubdomainInput({
  domain,
  error = false,
  ...input
}: { domain: string; error?: boolean } & Omit<
  React.ComponentProps<"input">,
  "type" | "className" | "style"
>) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <input
        type="text"
        className={`ms-input mono${error ? " error" : ""}`}
        style={{ flex: "1 1 120px", minWidth: 0 }}
        autoComplete="off"
        spellCheck={false}
        {...input}
      />
      <span
        className="ms-mono"
        style={{ minWidth: 0, fontSize: 13, color: "var(--ms-muted)", overflowWrap: "anywhere" }}
      >
        .<Breakable text={domain} />
      </span>
    </div>
  );
}
