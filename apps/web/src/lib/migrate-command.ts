export const MIGRATE_COMMAND = "npx @millionsend/cli migrate --from resend";

/** Cloud is the CLI's default target; a self-hosted instance has to name its own API URL. */
export function migrateCommand(toUrl: string | null): string {
  return toUrl ? `${MIGRATE_COMMAND} --to-url ${toUrl}` : MIGRATE_COMMAND;
}
