import { parseArgs } from "node:util";
import Stripe from "stripe";
import { dryRunStripe, provision, usdToCents } from "../src/provision.js";

const USAGE = `Usage: STRIPE_SECRET_KEY=sk_... pnpm --filter @millionsend/billing provision \\
  --pro-usd 20 --scale-usd 100 [--webhook-url https://app.example.com/api/billing/webhook] [--portal] [--dry-run]

Idempotent: re-running with the same arguments changes nothing; changed
amounts rotate the price behind the same lookup key.`;

// pnpm forwards a literal "--" to the script; parseArgs would read everything after it as positionals.
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const { values } = parseArgs({
  args,
  options: {
    "pro-usd": { type: "string" },
    "scale-usd": { type: "string" },
    "webhook-url": { type: "string" },
    portal: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const secretKey = process.env.STRIPE_SECRET_KEY;
if (values.help || !values["pro-usd"] || !values["scale-usd"] || !secretKey) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 1);
}

const real = new Stripe(secretKey);
const stripe = values["dry-run"] ? dryRunStripe(real, console.log) : real;
await provision(stripe, {
  amounts: { pro: usdToCents(values["pro-usd"]), scale: usdToCents(values["scale-usd"]) },
  webhookUrl: values["webhook-url"],
  portal: values.portal,
});
