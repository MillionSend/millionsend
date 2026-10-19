import { cardFingerprints } from "@millionsend/billing";
import type { FingerprintSources } from "@millionsend/core";
import { getStripe } from "./billing";
import { getKeyring } from "./keyring";

/** Where the web process reads a team's stored mail and its Stripe cards from, for linkage. */
export const FINGERPRINT_SOURCES: FingerprintSources = {
  keyring: getKeyring,
  cards: (customerId) => cardFingerprints(getStripe(), customerId),
};
