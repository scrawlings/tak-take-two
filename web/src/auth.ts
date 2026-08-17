import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type { Persistence, UserRecord } from './persistence.js';
import {
  generatePassword,
  hashPassword,
  passwordMeetsPolicy,
  verifyPassword,
  PASSWORD_MIN_LENGTH,
} from './passwords.js';

/**
 * The auth module — accounts and sessions. Routes authenticate (session →
 * user) and render; this module owns every auth invariant: credential
 * verification, session lifecycle, password policy and change, the
 * force-password-change flag, and the activity-trail events for auth actions.
 * It never touches SQL — persistence grows the accessors (ADR-0004's seam).
 */

export type Role = 'player' | 'admin';

/** The authenticated user handed to routes. Never carries the password hash. */
export interface SessionUser {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly forcePasswordChange: boolean;
  readonly blocked: boolean;
}

export type AuthErrorCode =
  | 'invalid-credentials'
  | 'user-blocked'
  | 'weak-password'
  | 'wrong-password'
  | 'username-taken'
  | 'invalid-username'
  | 'invalid-display-name'
  | 'display-name-taken'
  | 'admin-exists'
  | 'forbidden'
  | 'cannot-block-self'
  | 'not-authenticated'
  | 'not-found'
  | 'persistence';

export interface AuthError {
  readonly code: AuthErrorCode;
  readonly message: string;
}

export interface LoginResult {
  readonly sessionId: string;
  readonly user: SessionUser;
}

export interface BootstrapResult {
  readonly username: string;
  readonly password: string;
}

/** A freshly generated password an admin hands to a user out of band. */
export interface ResetPasswordResult {
  readonly username: string;
  readonly password: string;
}

export interface CreateAuthUserInput {
  readonly username: string;
  readonly password: string;
  /** Defaults to the username (CONTEXT.md: display name defaults to username). */
  readonly displayName?: string;
  /** Defaults to `player`; creating admins is the admin-management ticket's call. */
  readonly role?: Role;
}

export interface Auth {
  /** Create the first admin when none exists; refuse when one already does. */
  bootstrapAdmin(): Promise<Result<BootstrapResult, AuthError>>;
  /** An admin creates a user whose initial password forces a change on first login. */
  createUser(actor: SessionUser, input: CreateAuthUserInput): Promise<Result<SessionUser, AuthError>>;
  login(username: string, password: string): Promise<Result<LoginResult, AuthError>>;
  logout(sessionId: string): Result<void, AuthError>;
  /** Change the user's own password (old → new); invalidates all their sessions. */
  changePassword(userId: number, oldPassword: string, newPassword: string): Promise<Result<void, AuthError>>;
  /** Resolve a session id to its user, or `not-authenticated`. */
  getSessionUser(sessionId: string): Result<SessionUser, AuthError>;

  /** Admin: all users, ordered by username. */
  listUsers(actor: SessionUser): Result<SessionUser[], AuthError>;
  /** Admin: block a user — clears their sessions so all access stops now. */
  blockUser(actor: SessionUser, userId: number): Result<void, AuthError>;
  /** Admin: unblock a user. */
  unblockUser(actor: SessionUser, userId: number): Result<void, AuthError>;
  /** Admin: require the user to change their password before any other action. */
  forcePasswordChange(actor: SessionUser, userId: number): Result<void, AuthError>;
  /** Admin: replace a forgotten password with a generated one; forces a change and clears sessions. */
  resetPassword(actor: SessionUser, userId: number): Promise<Result<ResetPasswordResult, AuthError>>;
  /** The account owner changes their own display name (unique; username stays immutable). */
  changeDisplayName(user: SessionUser, displayName: string): Result<SessionUser, AuthError>;
}

const BOOTSTRAP_USERNAME = 'admin';
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const DISPLAY_NAME_MAX = 64;

function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    forcePasswordChange: user.forcePasswordChange,
    blocked: user.blocked,
  };
}

function persistenceError(message: string): AuthError {
  return { code: 'persistence', message };
}

function requireAdmin(actor: SessionUser): Result<void, AuthError> {
  return actor.role === 'admin'
    ? ok(undefined)
    : err({ code: 'forbidden', message: 'Only an admin can do that.' });
}

export function createAuth(persistence: Persistence): Auth {
  return {
    async bootstrapAdmin(): Promise<Result<BootstrapResult, AuthError>> {
      const admins = persistence.countAdmins();
      if (admins.isErr()) return err(persistenceError(admins.error));
      if (admins.value > 0) {
        return err({ code: 'admin-exists', message: 'An admin already exists; refusing to bootstrap another.' });
      }

      const existing = persistence.findUserByUsername(BOOTSTRAP_USERNAME);
      if (existing.isErr()) return err(persistenceError(existing.error));
      if (existing.value !== null) {
        return err({
          code: 'username-taken',
          message: `The username "${BOOTSTRAP_USERNAME}" is already taken.`,
        });
      }

      const password = generatePassword();
      const passwordHash = await hashPassword(password);
      const created = persistence.createUser({
        username: BOOTSTRAP_USERNAME,
        displayName: BOOTSTRAP_USERNAME,
        passwordHash,
        role: 'admin',
        forcePasswordChange: true,
      });
      if (created.isErr()) return err(persistenceError(created.error));

      const trail = persistence.appendActivityTrail({ userId: created.value.id, event: 'admin-bootstrapped' });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok({ username: BOOTSTRAP_USERNAME, password });
    },

    async createUser(actor: SessionUser, input: CreateAuthUserInput): Promise<Result<SessionUser, AuthError>> {
      if (actor.role !== 'admin') {
        return err({ code: 'forbidden', message: 'Only an admin can create users.' });
      }

      const username = input.username.trim();
      if (!USERNAME_PATTERN.test(username)) {
        return err({
          code: 'invalid-username',
          message: 'Username must be 1–64 characters of letters, digits, dot, underscore, or hyphen.',
        });
      }
      if (!passwordMeetsPolicy(input.password)) {
        return err({
          code: 'weak-password',
          message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
        });
      }

      const existing = persistence.findUserByUsername(username);
      if (existing.isErr()) return err(persistenceError(existing.error));
      if (existing.value !== null) {
        return err({ code: 'username-taken', message: 'That username is already taken.' });
      }

      const passwordHash = await hashPassword(input.password);
      const created = persistence.createUser({
        username,
        displayName: input.displayName?.trim() || username,
        passwordHash,
        role: input.role ?? 'player',
        forcePasswordChange: true,
      });
      if (created.isErr()) return err(persistenceError(created.error));

      const trail = persistence.appendActivityTrail({
        userId: created.value.id,
        event: 'user-created',
        payload: { by: actor.username },
      });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok(toSessionUser(created.value));
    },

    async login(rawUsername: string, password: string): Promise<Result<LoginResult, AuthError>> {
      const username = rawUsername.trim();
      const found = persistence.findUserByUsername(username);
      if (found.isErr()) return err(persistenceError(found.error));
      if (found.value === null) {
        return err({ code: 'invalid-credentials', message: 'Unknown username or password.' });
      }

      const user = found.value;
      if (user.blocked) {
        return err({ code: 'user-blocked', message: 'This account is blocked.' });
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        return err({ code: 'invalid-credentials', message: 'Unknown username or password.' });
      }

      const sessionId = randomUUID();
      const created = persistence.createSession(user.id, sessionId);
      if (created.isErr()) return err(persistenceError(created.error));

      const trail = persistence.appendActivityTrail({ userId: user.id, event: 'sign-in', payload: { via: 'password' } });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok({ sessionId, user: toSessionUser(user) });
    },

    logout(sessionId: string): Result<void, AuthError> {
      const found = persistence.findSessionById(sessionId);
      if (found.isErr()) return err(persistenceError(found.error));
      if (found.value === null) return ok(undefined);

      const deleted = persistence.deleteSession(sessionId);
      if (deleted.isErr()) return err(persistenceError(deleted.error));

      const trail = persistence.appendActivityTrail({ userId: found.value.userId, event: 'sign-out' });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok(undefined);
    },

    async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<Result<void, AuthError>> {
      const found = persistence.findUserById(userId);
      if (found.isErr()) return err(persistenceError(found.error));
      if (found.value === null) return err({ code: 'not-found', message: 'User not found.' });

      const user = found.value;
      if (!(await verifyPassword(user.passwordHash, oldPassword))) {
        return err({ code: 'wrong-password', message: 'Current password is incorrect.' });
      }
      if (!passwordMeetsPolicy(newPassword)) {
        return err({
          code: 'weak-password',
          message: `New password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
        });
      }

      const newHash = await hashPassword(newPassword);
      const updated = persistence.updateUserPassword(userId, newHash, false);
      if (updated.isErr()) return err(persistenceError(updated.error));

      const cleared = persistence.deleteSessionsForUser(userId);
      if (cleared.isErr()) return err(persistenceError(cleared.error));

      const trail = persistence.appendActivityTrail({ userId, event: 'password-change' });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok(undefined);
    },

    getSessionUser(sessionId: string): Result<SessionUser, AuthError> {
      const session = persistence.findSessionById(sessionId);
      if (session.isErr()) return err(persistenceError(session.error));
      if (session.value === null) return err({ code: 'not-authenticated', message: 'Not signed in.' });

      const user = persistence.findUserById(session.value.userId);
      if (user.isErr()) return err(persistenceError(user.error));
      if (user.value === null) return err({ code: 'not-authenticated', message: 'Not signed in.' });

      return ok(toSessionUser(user.value));
    },

    listUsers(actor: SessionUser): Result<SessionUser[], AuthError> {
      const authorized = requireAdmin(actor);
      if (authorized.isErr()) return err(authorized.error);

      const users = persistence.listUsers();
      if (users.isErr()) return err(persistenceError(users.error));
      return ok(users.value.map(toSessionUser));
    },

    blockUser(actor: SessionUser, userId: number): Result<void, AuthError> {
      const authorized = requireAdmin(actor);
      if (authorized.isErr()) return err(authorized.error);
      if (actor.id === userId) {
        return err({ code: 'cannot-block-self', message: 'You cannot block your own account.' });
      }

      const target = persistence.findUserById(userId);
      if (target.isErr()) return err(persistenceError(target.error));
      if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

      const blocked = persistence.setUserBlocked(userId, true);
      if (blocked.isErr()) return err(persistenceError(blocked.error));

      const cleared = persistence.deleteSessionsForUser(userId);
      if (cleared.isErr()) return err(persistenceError(cleared.error));

      const trail = persistence.appendActivityTrail({ userId, event: 'user-blocked', payload: { by: actor.username } });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok(undefined);
    },

    unblockUser(actor: SessionUser, userId: number): Result<void, AuthError> {
      const authorized = requireAdmin(actor);
      if (authorized.isErr()) return err(authorized.error);

      const target = persistence.findUserById(userId);
      if (target.isErr()) return err(persistenceError(target.error));
      if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

      const unblocked = persistence.setUserBlocked(userId, false);
      if (unblocked.isErr()) return err(persistenceError(unblocked.error));

      const trail = persistence.appendActivityTrail({ userId, event: 'user-unblocked', payload: { by: actor.username } });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok(undefined);
    },

    forcePasswordChange(actor: SessionUser, userId: number): Result<void, AuthError> {
      const authorized = requireAdmin(actor);
      if (authorized.isErr()) return err(authorized.error);

      const target = persistence.findUserById(userId);
      if (target.isErr()) return err(persistenceError(target.error));
      if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

      const forced = persistence.setUserForcePasswordChange(userId, true);
      if (forced.isErr()) return err(persistenceError(forced.error));

      const trail = persistence.appendActivityTrail({ userId, event: 'password-change-forced', payload: { by: actor.username } });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok(undefined);
    },

    async resetPassword(actor: SessionUser, userId: number): Promise<Result<ResetPasswordResult, AuthError>> {
      const authorized = requireAdmin(actor);
      if (authorized.isErr()) return err(authorized.error);

      const target = persistence.findUserById(userId);
      if (target.isErr()) return err(persistenceError(target.error));
      if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

      const password = generatePassword();
      const passwordHash = await hashPassword(password);

      const updated = persistence.updateUserPassword(userId, passwordHash, true);
      if (updated.isErr()) return err(persistenceError(updated.error));

      const cleared = persistence.deleteSessionsForUser(userId);
      if (cleared.isErr()) return err(persistenceError(cleared.error));

      const trail = persistence.appendActivityTrail({ userId, event: 'password-reset', payload: { by: actor.username } });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok({ username: target.value.username, password });
    },

    changeDisplayName(user: SessionUser, displayName: string): Result<SessionUser, AuthError> {
      const name = displayName.trim();
      if (name.length < 1 || name.length > DISPLAY_NAME_MAX) {
        return err({ code: 'invalid-display-name', message: `Display name must be 1–${DISPLAY_NAME_MAX} characters.` });
      }

      const existing = persistence.findUserByDisplayName(name);
      if (existing.isErr()) return err(persistenceError(existing.error));
      if (existing.value !== null && existing.value.id !== user.id) {
        return err({ code: 'display-name-taken', message: 'That display name is already in use.' });
      }

      const updated = persistence.updateUserDisplayName(user.id, name);
      if (updated.isErr()) return err(persistenceError(updated.error));

      const trail = persistence.appendActivityTrail({
        userId: user.id,
        event: 'display-name-change',
        payload: { from: user.displayName, to: name },
      });
      if (trail.isErr()) return err(persistenceError(trail.error));

      return ok({ ...user, displayName: name });
    },
  };
}
