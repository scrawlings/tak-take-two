import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type { Persistence, SessionRecord, UserRecord } from './persistence.js';
import { createTrail } from './trail.js';
import {
  generatePassword,
  hashPassword,
  passwordMeetsPolicy,
  verifyPassword,
  PASSWORD_MIN_LENGTH,
} from './passwords.js';

/**
 * The auth module — accounts and sessions behind one command union (the same
 * seam ADR-0004 draws for the game module). Routes authenticate (session →
 * user) and render; `applyAuth` owns every auth invariant: credential
 * verification, session lifecycle, password policy and change, the
 * force-password-change flag, block/unblock, admin reset, and the
 * activity-trail events for auth actions. It never touches SQL — persistence
 * grows the accessors.
 *
 * The actor is passed separately from the command: `applyAuth(actor, command)`.
 * Unauthenticated commands (login, bootstrapAdmin) pass `null`.
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

/** One command per auth mutation. The actor is passed to `applyAuth`, not embedded here. */
export type AuthCommand =
  | { readonly type: 'login'; readonly username: string; readonly password: string }
  | { readonly type: 'logout'; readonly sessionId: string }
  | { readonly type: 'bootstrapAdmin' }
  | {
      readonly type: 'createUser';
      readonly username: string;
      readonly password: string;
      /** Defaults to the username (CONTEXT.md: display name defaults to username). */
      readonly displayName?: string;
      /** Defaults to `player`; creating admins is an admin action. */
      readonly role?: Role;
    }
  | {
      readonly type: 'changePassword';
      readonly userId: number;
      readonly oldPassword: string;
      readonly newPassword: string;
    }
  | { readonly type: 'changeDisplayName'; readonly displayName: string }
  | { readonly type: 'blockUser'; readonly userId: number }
  | { readonly type: 'unblockUser'; readonly userId: number }
  | { readonly type: 'forcePasswordChange'; readonly userId: number }
  | { readonly type: 'resetPassword'; readonly userId: number };

/** One domain-shaped result per command; commands that only change state yield `{ type: 'ok' }`. */
export type AuthCommandResult =
  | { readonly type: 'ok' }
  | { readonly type: 'login'; readonly sessionId: string; readonly user: SessionUser }
  | { readonly type: 'createUser'; readonly user: SessionUser }
  | { readonly type: 'changeDisplayName'; readonly user: SessionUser }
  | { readonly type: 'resetPassword'; readonly username: string; readonly password: string }
  | { readonly type: 'bootstrapAdmin'; readonly username: string; readonly password: string };

export interface Auth {
  /**
   * Run one auth command. `actor` is null for the unauthenticated commands
   * (login, bootstrapAdmin). Commands authorise themselves.
   */
  applyAuth(actor: SessionUser | null, command: AuthCommand): Promise<Result<AuthCommandResult, AuthError>>;
  /** Resolve a session id to its user, or `not-authenticated`. */
  getSessionUser(sessionId: string): Result<SessionUser, AuthError>;
  /** Admin: all users, ordered by username. */
  listUsers(actor: SessionUser): Result<SessionUser[], AuthError>;
}

interface CreateAuthUserInput {
  readonly username: string;
  readonly password: string;
  readonly displayName?: string;
  readonly role?: Role;
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

function requireAdmin(actor: SessionUser | null): Result<SessionUser, AuthError> {
  if (actor === null) return err({ code: 'not-authenticated', message: 'Not signed in.' });
  if (actor.role !== 'admin') return err({ code: 'forbidden', message: 'Only an admin can do that.' });
  return ok(actor);
}

export function createAuth(persistence: Persistence): Auth {
  // The activity trail owns the transaction-plus-entry ritual and its error
  // shape; `TrailError` is already an `AuthError` structurally.
  const trail = createTrail(persistence);

  async function bootstrapAdmin(): Promise<Result<AuthCommandResult, AuthError>> {
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
    const created = trail.write((append): Result<UserRecord, string> => {
      const inserted = persistence.createUser({
        username: BOOTSTRAP_USERNAME,
        displayName: BOOTSTRAP_USERNAME,
        passwordHash,
        role: 'admin',
        forcePasswordChange: true,
      });
      if (inserted.isErr()) return inserted;
      const audited = append({ userId: inserted.value.id, event: 'admin-bootstrapped' });
      if (audited.isErr()) return err(audited.error);
      return inserted;
    });
    if (created.isErr()) return err(created.error);

    return ok({ type: 'bootstrapAdmin', username: BOOTSTRAP_USERNAME, password });
  }

  async function createUser(
    actor: SessionUser | null,
    input: CreateAuthUserInput,
  ): Promise<Result<AuthCommandResult, AuthError>> {
    const authorized = requireAdmin(actor);
    if (authorized.isErr()) return err(authorized.error);
    const admin = authorized.value;

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
    const created = trail.write((append): Result<UserRecord, string> => {
      const inserted = persistence.createUser({
        username,
        displayName: input.displayName?.trim() || username,
        passwordHash,
        role: input.role ?? 'player',
        forcePasswordChange: true,
      });
      if (inserted.isErr()) return inserted;
      const audited = append({
        userId: inserted.value.id,
        event: 'user-created',
        payload: { by: admin.username },
      });
      if (audited.isErr()) return err(audited.error);
      return inserted;
    });
    if (created.isErr()) return err(created.error);

    return ok({ type: 'createUser', user: toSessionUser(created.value) });
  }

  async function login(rawUsername: string, password: string): Promise<Result<AuthCommandResult, AuthError>> {
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
    const created = trail.write((append): Result<SessionRecord, string> => {
      const inserted = persistence.createSession(user.id, sessionId);
      if (inserted.isErr()) return inserted;
      const audited = append({ userId: user.id, event: 'sign-in', payload: { via: 'password' } });
      if (audited.isErr()) return err(audited.error);
      return inserted;
    });
    if (created.isErr()) return err(created.error);

    return ok({ type: 'login', sessionId, user: toSessionUser(user) });
  }

  function logout(sessionId: string): Result<AuthCommandResult, AuthError> {
    const found = persistence.findSessionById(sessionId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return ok({ type: 'ok' });
    const userId = found.value.userId;

    const result = trail.write((append): Result<void, string> => {
      const deleted = persistence.deleteSession(sessionId);
      if (deleted.isErr()) return deleted;
      const audited = append({ userId, event: 'sign-out' });
      if (audited.isErr()) return audited;
      return ok(undefined);
    });
    if (result.isErr()) return err(result.error);

    return ok({ type: 'ok' });
  }

  async function changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<Result<AuthCommandResult, AuthError>> {
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
    const result = trail.write((append): Result<void, string> => {
      const updated = persistence.updateUserPassword(userId, newHash, false);
      if (updated.isErr()) return updated;
      const cleared = persistence.deleteSessionsForUser(userId);
      if (cleared.isErr()) return cleared;
      const audited = append({ userId, event: 'password-change' });
      if (audited.isErr()) return audited;
      return ok(undefined);
    });
    if (result.isErr()) return err(result.error);

    return ok({ type: 'ok' });
  }

  function blockUser(actor: SessionUser | null, userId: number): Result<AuthCommandResult, AuthError> {
    const authorized = requireAdmin(actor);
    if (authorized.isErr()) return err(authorized.error);
    const admin = authorized.value;
    if (admin.id === userId) {
      return err({ code: 'cannot-block-self', message: 'You cannot block your own account.' });
    }

    const target = persistence.findUserById(userId);
    if (target.isErr()) return err(persistenceError(target.error));
    if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

    const blocked = trail.write((append): Result<void, string> => {
      const set = persistence.setUserBlocked(userId, true);
      if (set.isErr()) return set;
      const cleared = persistence.deleteSessionsForUser(userId);
      if (cleared.isErr()) return cleared;
      const audited = append({ userId, event: 'user-blocked', payload: { by: admin.username } });
      if (audited.isErr()) return audited;
      return ok(undefined);
    });
    if (blocked.isErr()) return err(blocked.error);

    return ok({ type: 'ok' });
  }

  function unblockUser(actor: SessionUser | null, userId: number): Result<AuthCommandResult, AuthError> {
    const authorized = requireAdmin(actor);
    if (authorized.isErr()) return err(authorized.error);
    const admin = authorized.value;

    const target = persistence.findUserById(userId);
    if (target.isErr()) return err(persistenceError(target.error));
    if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

    const unblocked = trail.write((append): Result<void, string> => {
      const set = persistence.setUserBlocked(userId, false);
      if (set.isErr()) return set;
      const audited = append({ userId, event: 'user-unblocked', payload: { by: admin.username } });
      if (audited.isErr()) return audited;
      return ok(undefined);
    });
    if (unblocked.isErr()) return err(unblocked.error);

    return ok({ type: 'ok' });
  }

  function forcePasswordChange(actor: SessionUser | null, userId: number): Result<AuthCommandResult, AuthError> {
    const authorized = requireAdmin(actor);
    if (authorized.isErr()) return err(authorized.error);
    const admin = authorized.value;

    const target = persistence.findUserById(userId);
    if (target.isErr()) return err(persistenceError(target.error));
    if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

    const forced = trail.write((append): Result<void, string> => {
      const set = persistence.setUserForcePasswordChange(userId, true);
      if (set.isErr()) return set;
      const audited = append({ userId, event: 'password-change-forced', payload: { by: admin.username } });
      if (audited.isErr()) return audited;
      return ok(undefined);
    });
    if (forced.isErr()) return err(forced.error);

    return ok({ type: 'ok' });
  }

  async function resetPassword(
    actor: SessionUser | null,
    userId: number,
  ): Promise<Result<AuthCommandResult, AuthError>> {
    const authorized = requireAdmin(actor);
    if (authorized.isErr()) return err(authorized.error);
    const admin = authorized.value;

    const target = persistence.findUserById(userId);
    if (target.isErr()) return err(persistenceError(target.error));
    if (target.value === null) return err({ code: 'not-found', message: 'User not found.' });

    const password = generatePassword();
    const passwordHash = await hashPassword(password);

    const updated = trail.write((append): Result<void, string> => {
      const set = persistence.updateUserPassword(userId, passwordHash, true);
      if (set.isErr()) return set;
      const cleared = persistence.deleteSessionsForUser(userId);
      if (cleared.isErr()) return cleared;
      const audited = append({ userId, event: 'password-reset', payload: { by: admin.username } });
      if (audited.isErr()) return audited;
      return ok(undefined);
    });
    if (updated.isErr()) return err(updated.error);

    return ok({ type: 'resetPassword', username: target.value.username, password });
  }

  function changeDisplayName(actor: SessionUser | null, displayName: string): Result<AuthCommandResult, AuthError> {
    if (actor === null) return err({ code: 'not-authenticated', message: 'Not signed in.' });

    const name = displayName.trim();
    if (name.length < 1 || name.length > DISPLAY_NAME_MAX) {
      return err({ code: 'invalid-display-name', message: `Display name must be 1–${DISPLAY_NAME_MAX} characters.` });
    }

    const existing = persistence.findUserByDisplayName(name);
    if (existing.isErr()) return err(persistenceError(existing.error));
    if (existing.value !== null && existing.value.id !== actor.id) {
      return err({ code: 'display-name-taken', message: 'That display name is already in use.' });
    }

    const updated = trail.write((append): Result<void, string> => {
      const set = persistence.updateUserDisplayName(actor.id, name);
      if (set.isErr()) return set;
      const audited = append({
        userId: actor.id,
        event: 'display-name-change',
        payload: { from: actor.displayName, to: name },
      });
      if (audited.isErr()) return audited;
      return ok(undefined);
    });
    if (updated.isErr()) return err(updated.error);

    return ok({ type: 'changeDisplayName', user: { ...actor, displayName: name } });
  }

  return {
    async applyAuth(actor, command): Promise<Result<AuthCommandResult, AuthError>> {
      switch (command.type) {
        case 'login':
          return login(command.username, command.password);
        case 'logout':
          return logout(command.sessionId);
        case 'bootstrapAdmin':
          return bootstrapAdmin();
        case 'createUser':
          return createUser(actor, {
            username: command.username,
            password: command.password,
            displayName: command.displayName,
            role: command.role,
          });
        case 'changePassword':
          return changePassword(command.userId, command.oldPassword, command.newPassword);
        case 'changeDisplayName':
          return changeDisplayName(actor, command.displayName);
        case 'blockUser':
          return blockUser(actor, command.userId);
        case 'unblockUser':
          return unblockUser(actor, command.userId);
        case 'forcePasswordChange':
          return forcePasswordChange(actor, command.userId);
        case 'resetPassword':
          return resetPassword(actor, command.userId);
      }
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
  };
}
