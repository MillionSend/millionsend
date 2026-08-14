"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { useDismiss } from "@/components/popover-menu";
import { useTRPC } from "@/lib/trpc";

/** Rounded-square avatar: the team's initial on a raised tile. */
function TeamTile({ name, size }: { name: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: "var(--ms-panel-raised)",
        border: "1px solid var(--ms-line)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.46),
        fontWeight: 600,
        flex: "none",
        boxSizing: "border-box",
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

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
    <svg width="9" height="15" viewBox="0 0 9 15" fill="none" aria-hidden="true" role="img">
      <path
        d="M1.5 5.25 4.5 2.25 7.5 5.25"
        stroke="var(--ms-muted)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 9.75 4.5 12.75 7.5 9.75"
        stroke="var(--ms-muted)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Sidebar team switcher — avatar tile + name on the trigger (the plan pill
 * lives only in the popover rows), popover listing every membership with a ✓
 * on the active one, then a "Create team" row.
 * Switching/creating sets the server-side selection cookie, so the follow-up
 * is a full navigation: every query cache belongs to the previous team.
 */
export function TeamSwitcher({ teamName }: { teamName: string }) {
  const t = useTranslations("common.teamSwitcher");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  const { data } = useQuery(trpc.team.list.queryOptions());
  const active = data?.teams.find((m) => m.teamId === data.activeTeamId);

  const switchTeam = useMutation(
    trpc.team.switch.mutationOptions({
      onSuccess: () => window.location.assign("/emails"),
    }),
  );
  const createTeam = useMutation(
    trpc.team.createTeam.mutationOptions({
      onSuccess: () => window.location.assign("/emails"),
    }),
  );

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
        <TeamTile name={active?.teamName ?? teamName} size={26} />
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
            zIndex: 20,
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
                <TeamTile name={team.teamName} size={22} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {team.teamName}
                </span>
                <PlanBadge plan={team.plan} />
              </span>
              {team.teamId === data?.activeTeamId ? (
                <span aria-hidden="true" style={{ color: "var(--ms-muted)", flex: "none" }}>
                  ✓
                </span>
              ) : null}
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
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t("create")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            createTeam.mutate({ name: newName });
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
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          {createTeam.isError ? (
            <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
              {t("error")}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              onClick={() => setCreateOpen(false)}
            >
              {tCommon("cancel")}
            </button>
            <button type="submit" className="ms-btn ms-btn-primary" disabled={createTeam.isPending}>
              {t("submit")}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
