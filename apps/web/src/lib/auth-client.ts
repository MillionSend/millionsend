import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { confirmUnsavedNavigation, leaveDocument } from "@/lib/use-unsaved-warning";

// oauthProviderClient forwards the signed OAuth query of the current page
// (login/consent) with each auth call, which is how a sign-in resumes a
// pending MCP authorization.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });

/**
 * Signs out with a document load of /login, so nothing the account loaded
 * (router payloads, react-query data) outlives its session in this tab.
 * Unsaved edits are confirmed before the session ends: asked after it, Stay
 * would keep a page that can no longer save.
 */
export async function signOutToLogin(): Promise<void> {
  if (!confirmUnsavedNavigation()) return;
  await authClient.signOut();
  leaveDocument("/login");
}
