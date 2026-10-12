import { parseArgs } from "node:util";
import { env } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { createKeyringFromEnv } from "@millionsend/ses";
import { formatReplay, replayMedia } from "./media/replay.js";
import { mediaPool } from "./media/scan.js";

/**
 * Replays screening of images and attachments on stored mail, read-only.
 * The production image has neither pnpm nor dev dependencies, so it runs
 * through the worker's own tsx:
 *
 *   docker compose exec millionsend /app/apps/worker/node_modules/.bin/tsx \
 *     /app/apps/worker/src/replay-media.ts --days 30 --limit 5000
 *
 * It decrypts in memory, writes nothing, fetches nothing and calls neither
 * the image reader nor the judge; it prints counts and team id prefixes only.
 */

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    limit: { type: "string", default: "5000" },
    rescore: { type: "boolean", default: false },
  },
});

if (values.rescore) {
  console.error(
    "--rescore is not built yet. It would send each email's new judge input, with image text, " +
      "to TypeSafe and Bedrock, which needs the new privacy text live first. Run without it.",
  );
  process.exit(2);
}

const days = Number(values.days);
const limit = Number(values.limit);
if (!Number.isInteger(days) || days < 1 || !Number.isInteger(limit) || limit < 1) {
  console.error("--days and --limit take whole numbers from 1");
  process.exit(2);
}

const db = getDb();
try {
  const report = await replayMedia(db, createKeyringFromEnv(env), { days, limit });
  for (const line of formatReplay(report)) console.log(line);
} finally {
  await mediaPool().close();
  await db.$client.end();
}
