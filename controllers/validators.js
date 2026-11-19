// Shared input validators for auth flows (login, register, change/reset password).
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const NAME_RE = /^[\p{L}][\p{L}\s.'’-]{1,99}$/u;
// At least 8 chars with uppercase, lowercase, number and special character.
export const PASSWORD_RE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
export const PASSWORD_RULES =
  "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";
