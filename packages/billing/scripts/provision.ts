import { parseArgs } from "node:util";
import Stripe from "stripe";
import { dryRunStripe, provision } from "../src/provision.js";

const USAGE = `Usage: STRIPE_SECRET_KEY=sk_... pnpm --filter @millionsend/billing provision \\
  [--webhook-url https://app.example.com/api/billing/webhook] [--portal] [--app-url https://app.example.com] [--dry-run]

Creates the products, the overage meter, one price per rung and one metered
overage price per monthly rung, from the ladder in @millionsend/core
(packages/core/src/plans.ts), and archives the pre-ladder prices.
Idempotent: re-running changes nothing; a changed amount in the ladder
rotates the price behind the same lookup key.`;

// pnpm forwards a literal "--" to the script; parseArgs would read everything after it as positionals.
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const { values } = parseArgs({
  args,
  options: {
    "webhook-url": { type: "string" },
    portal: { type: "boolean", default: false },
    "app-url": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const secretKey = process.env.STRIPE_SECRET_KEY;
if (values.help || !secretKey) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 1);
}

const real = new Stripe(secretKey);
const stripe = values["dry-run"] ? dryRunStripe(real, console.log) : real;
await provision(stripe, {
  webhookUrl: values["webhook-url"],
  portal: values.portal,
  appUrl: values["app-url"],
});
