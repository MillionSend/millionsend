-- Dynamically registered OAuth clients (MCP: Claude Code, Cursor, …) store
-- the scope list as of their registration day, and the authorization
-- endpoint validates requests against the stored list — so every existing
-- client gets invalid_scope whenever the server ships a new scope. NULL
-- defers to the server's live scope configuration; per-user consent remains
-- the gate. The register after-hook in apps/web/src/server/auth.ts keeps new
-- registrations NULL too.
UPDATE "oauth_client" SET "scopes" = NULL;
