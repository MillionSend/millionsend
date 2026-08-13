-- audit_log is append-only: reject UPDATE/DELETE in the database itself,
-- independent of connection role.
CREATE FUNCTION audit_log_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();
