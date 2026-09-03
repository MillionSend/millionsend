"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { ChevronGlyph, PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap } from "@/components/modal-footer";
import { useDismiss } from "@/components/popover-menu";
import { BtnSpinner } from "@/components/spinner";
import { TeamLogo } from "@/components/team-logo";
import { useTRPC } from "@/lib/trpc";

function PlanBadge({ plan }: { plan: string }) {
  const t = useTranslations("common");
  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--ms-muted)",
        border: "1px solid var(--ms-line)",
        borderRadius: 999,
        padding: "1px 8px",
        flex: "none",
      }}
    >
      {t(`plan.${plan}`)}
    </span>
  );
}

/** The tiny stacked up/down chevrons on the switcher trigger. */
function ChevronStack() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        color: "var(--ms-muted)",
      }}
    >
      <ChevronGlyph size={10} direction="up" />
      {/* Pull the halves together so the pair reads as one glyph. */}
      <span style={{ display: "flex", marginTop: -3 }}>
        <ChevronGlyph size={10} />
      </span>
    </span>
  );
}

/**
 * Sidebar team switcher — avatar tile + name on the trigger (the plan pill
 * lives only in the popover rows), popover listing every membership with a ✓
 * on the active one, then a "Create team" row.
 * Switching/creating sets the server-side selection cookie, so the follow-up
 * is a full navigation: every query cache belongs to the previous team.
 */
export function TeamSwitcher({
  teamName,
  teamLogoUrl,
}: {
  teamName: string;
  /** Server-resolved logo for the active team — the trigger before team.list lands. */
  teamLogoUrl?: string | null | undefined;
}) {
  const t = useTranslations("common.teamSwitcher");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));
  // Stable identity: Modal's focus effect depends on onClose, and a fresh
  // arrow per render would re-run it on every keystroke, stealing focus
  // from the name input.
  const closeCreate = useCallback(() => setCreateOpen(false), []);

  const { data } = useQuery(trpc.team.list.queryOptions());
  const active = data?.teams.find((m) => m.teamId === data.activeTeamId);

  const switchTeam = useMutation(
    trpc.team.switch.mutationOptions({
      onSuccess: () => window.location.assign("/emails"),
    }),
  );
  const createTeam = useMutation(
    trpc.team.createTeam.mutationOptions({
      // A new team starts at its first email, like the first team does.
      onSuccess: () => window.location.assign("/onboarding"),
    }),
  );

  // Shared by the form submit and the modal's ⌘↵ shortcut, which bypasses
  // the input's native `required` check — hence the explicit empty guard.
  function submitCreate() {
    if (createTeam.isPending || newName.trim().length === 0) return;
    createTeam.mutate({ name: newName });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keydown only intercepts Escape bubbling from the trigger/menu
    <div ref={rootRef} style={{ position: "relative" }} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label={t("switch")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: "100%",
          padding: "7px 10px",
          borderRadius: 10,
          background: open ? "var(--ms-panel-raised)" : "none",
          border: 0,
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          color: "inherit",
        }}
      >
        <TeamLogo
          name={active?.teamName ?? teamName}
          logoUrl={active ? active.logoUrl : teamLogoUrl}
          size={26}
        />
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {active?.teamName ?? teamName}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", flex: "none" }}>
          <ChevronStack />
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="ms-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            minWidth: 0,
          }}
        >
          <div className="ms-menu-label">{t("teams")}</div>
          {(data?.teams ?? []).map((team) => (
            <button
              key={team.teamId}
              type="button"
              role="menuitem"
              className="ms-menu-item"
              onClick={() => {
                setOpen(false);
                if (team.teamId !== data?.activeTeamId) switchTeam.mutate({ teamId: team.teamId });
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <TeamLogo name={team.teamName} logoUrl={team.logoUrl} size={22} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {team.teamName}
                </span>
              </span>
              {/* Right cluster: the active ✓ sits just left of the plan pill,
                  so the pill is always the right-most element of the row. */}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
                {team.teamId === data?.activeTeamId ? (
                  <span aria-hidden="true" style={{ color: "var(--ms-muted)" }}>
                    ✓
                  </span>
                ) : null}
                <PlanBadge plan={team.plan} />
              </span>
            </button>
          ))}
          <hr className="ms-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="ms-menu-item"
            onClick={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--ms-muted)", display: "inline-flex", flex: "none" }}>
                <PlusGlyph size={13} />
              </span>
              {t("create")}
            </span>
          </button>
        </div>
      ) : null}
      <Modal open={createOpen} onClose={closeCreate} onConfirm={submitCreate} title={t("create")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitCreate();
          }}
          style={{ display: "grid", gap: 16, marginTop: 12 }}
        >
          <div className="ms-field">
            <label htmlFor="new-team-name">{t("nameLabel")}</label>
            <input
              id="new-team-name"
              type="text"
              className="ms-input"
              style={{ width: "100%" }}
              required
              maxLength={80}
              disabled={createTeam.isPending}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          {createTeam.isError ? (
            <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
              {createTeam.error.data?.code === "FORBIDDEN" ? t("limit") : t("error")}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCreate}>
              {tCommon("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button type="submit" className="ms-btn ms-btn-primary" disabled={createTeam.isPending}>
              <BtnSpinner on={createTeam.isPending} />
              {t("submit")} <ConfirmKeycap />
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
