import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// oauthProviderClient forwards the signed OAuth query of the current page
// (login/consent) with each auth call, which is how a sign-in resumes a
// pending MCP authorization.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
