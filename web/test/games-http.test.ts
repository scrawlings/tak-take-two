import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createApp, type App } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';
import { hashPassword } from '../src/passwords.js';

/**
 * The game routes as adapters: authenticate, call the module, render. The
 * lifecycle rules themselves are covered in games.test.ts.
 */

const silent: Logger = { log() {} };

function makeApp(): { app: App; db: Database.Database } {
  const db = new Database(':memory:');
  runMigrations(db);
  return {
    app: createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent }),
    db,
  };
}

async function insertUser(
  db: Database.Database,
  seed: { id: number; username: string; password: string; displayName?: string; role?: 'player' | 'admin' },
): Promise<void> {
  const hash = await hashPassword(seed.password);
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
  ).run(seed.id, seed.username, seed.displayName ?? seed.username, hash, seed.role ?? 'player');
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

async function signIn(app: App, username: string, password: string): Promise<string> {
  const res = await app.request('/login', form({ username, password }));
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('tak_session='));
  const m = cookie ? /tak_session=([^;]+)/.exec(cookie) : null;
  const id = m?.[1];
  if (!id) throw new Error('sign-in did not set a session cookie');
  return id;
}

function withCookie(init: RequestInit, session: string): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), cookie: `tak_session=${session}` } };
}

const OPENING_PTN = '[Size "5"]\n1. a1 e5\n2. c3 c4';

async function playerApp(): Promise<{ app: App; db: Database.Database; session: string }> {
  const { app, db } = makeApp();
  await insertUser(db, { id: 1, username: 'aoife', password: 'a good password', displayName: 'Aoife Nolan' });
  await insertUser(db, { id: 2, username: 'takashi', password: 'a good password', displayName: 'Takashi Mori' });
  return { app, db, session: await signIn(app, 'aoife', 'a good password') };
}

describe('GET /games', () => {
  it('redirects a signed-out visitor to sign in', async () => {
    const { app } = makeApp();
    const res = await app.request('/games');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('invites the player to propose when they have no games', async () => {
    const { app, session } = await playerApp();

    const res = await app.request('/games', withCookie({}, session));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No games yet');
    expect(html).toContain('action="/games"');
  });

  it('lists the player’s own games', async () => {
    const { app, session } = await playerApp();
    await app.request('/games', withCookie(form({ board_size: '6', join_type: 'open' }), session));

    const html = await (await app.request('/games', withCookie({}, session))).text();

    expect(html).toContain('6×6');
    expect(html).toContain('waiting for anyone');
  });
});

describe('POST /games', () => {
  it('proposes a game and redirects back to the list', async () => {
    const { app, db, session } = await playerApp();

    const res = await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), session));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/games');
    const row = db.prepare('SELECT board_size, state, join_type, proposer_id FROM games').get();
    expect(row).toEqual({ board_size: 5, state: 'proposed', join_type: 'open', proposer_id: 1 });
  });

  it('proposes an invited game naming the player', async () => {
    const { app, db, session } = await playerApp();

    await app.request(
      '/games',
      withCookie(
        form({ board_size: '5', join_type: 'invited', invited_display_name: 'Takashi Mori' }),
        session,
      ),
    );

    expect(db.prepare('SELECT invited_player_id FROM games').get()).toEqual({ invited_player_id: 2 });
  });

  it('imports a PTN record, taking the board size from it', async () => {
    const { app, db, session } = await playerApp();

    const res = await app.request(
      '/games',
      withCookie(form({ board_size: '6', join_type: 'open', ptn: OPENING_PTN }), session),
    );

    expect(res.status).toBe(303);
    expect(db.prepare('SELECT board_size, imported_ptn FROM games').get()).toEqual({
      board_size: 5,
      imported_ptn: OPENING_PTN,
    });
  });

  it('re-renders the form with the error and the submitted record kept', async () => {
    const { app, db, session } = await playerApp();

    const res = await app.request(
      '/games',
      withCookie(form({ board_size: '5', join_type: 'open', ptn: 'not a record' }), session),
    );

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('not a legal game');
    expect(html).toContain('not a record');
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 0 });
  });

  it('refuses an admin account with 403', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'root', password: 'a good password', role: 'admin' });
    const session = await signIn(app, 'root', 'a good password');

    const res = await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), session));

    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 0 });
  });

  it('refuses an admin the games page too, not just the command', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'root', password: 'a good password', role: 'admin' });
    const session = await signIn(app, 'root', 'a good password');

    const res = await app.request('/games', withCookie({}, session));

    expect(res.status).toBe(403);
  });
});

describe('POST /games/:id/delete', () => {
  async function propose(app: App, session: string): Promise<number> {
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), session));
    return 1;
  }

  it('deletes the proposer’s own unjoined proposal', async () => {
    const { app, db, session } = await playerApp();
    const id = await propose(app, session);

    const res = await app.request(`/games/${id}/delete`, withCookie({ method: 'POST' }, session));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/games');
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 0 });
  });

  it('refuses to delete someone else’s proposal', async () => {
    const { app, db, session } = await playerApp();
    const id = await propose(app, session);
    const other = await signIn(app, 'takashi', 'a good password');

    const res = await app.request(`/games/${id}/delete`, withCookie({ method: 'POST' }, other));

    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 1 });
  });

  it('reports a joined game as a conflict and leaves it alone', async () => {
    const { app, db, session } = await playerApp();
    const id = await propose(app, session);
    db.prepare('UPDATE games SET opponent_id = 2 WHERE id = ?').run(id);

    const res = await app.request(`/games/${id}/delete`, withCookie({ method: 'POST' }, session));

    expect(res.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 1 });
  });

  it('reports an unknown game as not found', async () => {
    const { app, session } = await playerApp();

    const res = await app.request('/games/404/delete', withCookie({ method: 'POST' }, session));

    expect(res.status).toBe(404);
  });

  it('reports a non-numeric id as not found', async () => {
    const { app, session } = await playerApp();

    const res = await app.request('/games/abc/delete', withCookie({ method: 'POST' }, session));

    expect(res.status).toBe(404);
  });
});

describe('games navigation', () => {
  it('offers Games to a player and Users to an admin', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'a good password' });
    await insertUser(db, { id: 2, username: 'root', password: 'a good password', role: 'admin' });

    const player = await signIn(app, 'aoife', 'a good password');
    const playerHtml = await (await app.request('/account', withCookie({}, player))).text();
    expect(playerHtml).toContain('href="/games"');
    expect(playerHtml).not.toContain('href="/admin/users"');

    const admin = await signIn(app, 'root', 'a good password');
    const adminHtml = await (await app.request('/account', withCookie({}, admin))).text();
    expect(adminHtml).toContain('href="/admin/users"');
    expect(adminHtml).not.toContain('href="/games"');
  });
});
