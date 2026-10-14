/**
 * A chosen username on the shared inbox domain, trimmed and lowercased
 * first: 1-64 letters, digits and . _ -, a letter or digit at each end, no
 * "..". Stricter than a local part: routing matches an address exactly
 * before it drops a +tag, so "leo+x" would take mail meant for leo. Imports
 * nothing, so the dashboard checks the same rule as the API.
 */
export const SHARED_USERNAME = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
