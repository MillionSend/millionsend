// Client for the /api/team-logo route handler (multipart upload / removal),
// shared by the onboarding picker and the settings logo row.

export async function uploadTeamLogo(teamId: string, file: File): Promise<{ logoUrl: string }> {
  const body = new FormData();
  body.set("teamId", teamId);
  body.set("file", file);
  const res = await fetch("/api/team-logo", { method: "POST", body });
  if (!res.ok) throw new Error(`team logo upload failed (${res.status})`);
  return res.json();
}

export async function removeTeamLogo(teamId: string): Promise<void> {
  const res = await fetch(`/api/team-logo?teamId=${encodeURIComponent(teamId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`team logo removal failed (${res.status})`);
}
