import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing and generation. argon2id is the normative choice
 * (CONTEXT.md: "argon2id password hashing"). `@node-rs/argon2`'s `Algorithm`
 * is a const enum that is erased at runtime, so we pass the numeric id
 * directly rather than the enum member — it stays correct across
 * esbuild/tsx/vitest transpilation.
 */
const ARGON2ID = 2;

/** Minimum accepted password length (design.md: "minimum 8 characters"). */
export const PASSWORD_MIN_LENGTH = 8;

/** Hash a plaintext password with argon2id. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID });
}

/** Verify a plaintext password against a stored argon2 hash. */
export function verifyPassword(hashed: string, password: string): Promise<boolean> {
  return verify(hashed, password);
}

/** Whether a candidate password meets the policy. */
export function passwordMeetsPolicy(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH;
}

/** Generate a strong one-time password (192 bits, base64url, 32 chars). */
export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}
