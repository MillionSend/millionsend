/**
 * A chosen username on the shared inbox domain, trimmed and lowercased
 * first: 1-64 letters, digits and . _ -, a letter or digit at each end, no
 * "..". Stricter than a local part: routing matches an address exactly
 * before it drops a +tag, so "leo+x" would take mail meant for leo. Imports
 * nothing, so the dashboard checks the same rule as the API.
 */
export const SHARED_USERNAME = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * The longest inbox name: room for any address, which is the name an inbox
 * gets when none is given (a 64-character local part, @ and a domain of up
 * to 255). Label names keep oneLineName's default of 64.
 */
export const INBOX_NAME_MAX = 320;
