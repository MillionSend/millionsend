/** 1 = weak, 2 = fair, 3 = strong (0 only for the empty string). */
export type PasswordStrength = 0 | 1 | 2 | 3;

/**
 * Coarse strength for the signup meter. Length dominates (NIST 800-63:
 * length beats composition rules), character variety refines — a long
 * all-lowercase passphrase still rates strong.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) return 0;
  if (password.length < 8) return 1;
  let variety = 0;
  if (/[a-z]/.test(password)) variety++;
  if (/[A-Z]/.test(password)) variety++;
  if (/[0-9]/.test(password)) variety++;
  if (/[^A-Za-z0-9]/.test(password)) variety++;
  if (password.length >= 16 || (password.length >= 12 && variety >= 3)) return 3;
  if (password.length >= 10 || variety >= 3) return 2;
  return variety >= 2 ? 2 : 1;
}
