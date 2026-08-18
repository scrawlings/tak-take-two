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
  db.pragma('foreign_keys = ON');
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
    expect(playerHtml).toContain('href="/games/find"');
    expect(playerHtml).not.toContain('href="/admin/users"');

    const admin = await signIn(app, 'root', 'a good password');
    const adminHtml = await (await app.request('/account', withCookie({}, admin))).text();
    expect(adminHtml).toContain('href="/admin/users"');
    expect(adminHtml).not.toContain('href="/games"');
  });
});

describe('GET /games/find', () => {
  it('redirects a signed-out visitor to sign in', async () => {
    const { app } = makeApp();
    const res = await app.request('/games/find');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('shows another player’s open proposal', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'a good password', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'a good password', displayName: 'Takashi Mori' });
    const aoife = await signIn(app, 'aoife', 'a good password');
    await app.request('/games', withCookie(form({ board_size: '6', join_type: 'open' }), aoife));

    const takashi = await signIn(app, 'takashi', 'a good password');
    const html = await (await app.request('/games/find', withCookie({}, takashi))).text();

    expect(html).toContain('Aoife Nolan');
    expect(html).toContain('6×6');
    expect(html).toContain('action="/games/1/join"');
  });

  it('says so plainly when nothing is on offer', async () => {
    const { app, session } = await playerApp();

    const html = await (await app.request('/games/find', withCookie({}, session))).text();

    expect(html).toContain('Nobody is waiting for an opponent');
  });

  it('narrows by the filters in the query string', async () => {
    const { app, session } = await playerApp();
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), session));
    await app.request('/games', withCookie(form({ board_size: '6', join_type: 'open' }), session));

    const html = await (await app.request('/games/find?board_size=6', withCookie({}, session))).text();

    // The board filter itself lists both sizes, so assert on the results.
    expect(html).toContain('action="/games/2/join"');
    expect(html).not.toContain('action="/games/1/join"');
    expect(html).toContain('Matching proposals');
  });

  it('treats blank filters as no filter at all', async () => {
    const { app, session } = await playerApp();
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), session));

    const res = await app.request('/games/find?board_size=&join_type=&proposer=', withCookie({}, session));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Waiting for an opponent');
  });

  it('keeps the form and explains when a filter is nonsense', async () => {
    const { app, session } = await playerApp();

    const res = await app.request('/games/find?board_size=7', withCookie({}, session));

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Board size must be 5 or 6');
    expect(html).toContain('action="/games/find"');
  });

  it('hides another player’s invitation entirely', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'a good password', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'a good password', displayName: 'Takashi Mori' });
    await insertUser(db, { id: 3, username: 'wren', password: 'a good password', displayName: 'Wren Alvarez' });
    const aoife = await signIn(app, 'aoife', 'a good password');
    await app.request(
      '/games',
      withCookie(form({ board_size: '5', join_type: 'invited', invited_display_name: 'Takashi Mori' }), aoife),
    );

    const wren = await signIn(app, 'wren', 'a good password');
    expect(await (await app.request('/games/find', withCookie({}, wren))).text()).not.toContain('Aoife Nolan');

    const takashi = await signIn(app, 'takashi', 'a good password');
    expect(await (await app.request('/games/find', withCookie({}, takashi))).text()).toContain('Aoife Nolan');
  });

  it('refuses an admin account', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'root', password: 'a good password', role: 'admin' });
    const session = await signIn(app, 'root', 'a good password');

    expect((await app.request('/games/find', withCookie({}, session))).status).toBe(403);
  });
});

describe('POST /games/:id/join', () => {
  async function twoPlayers() {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'a good password', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'a good password', displayName: 'Takashi Mori' });
    const aoife = await signIn(app, 'aoife', 'a good password');
    const takashi = await signIn(app, 'takashi', 'a good password');
    return { app, db, aoife, takashi };
  }

  it('joins an open game and lands on the player’s games', async () => {
    const { app, db, aoife, takashi } = await twoPlayers();
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));

    const res = await app.request('/games/1/join', withCookie({ method: 'POST' }, takashi));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/games');
    expect(db.prepare('SELECT state, opponent_id FROM games').get()).toEqual({
      state: 'in_play',
      opponent_id: 2,
    });
  });

  it('reports a second join as a conflict', async () => {
    const { app, db, aoife, takashi } = await twoPlayers();
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    await app.request('/games/1/join', withCookie({ method: 'POST' }, takashi));

    const res = await app.request('/games/1/join', withCookie({ method: 'POST' }, aoife));

    expect(res.status).toBe(409);
    expect(db.prepare('SELECT opponent_id FROM games').get()).toEqual({ opponent_id: 2 });
  });

  it('treats an invitation to someone else as absent', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'a good password', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'a good password', displayName: 'Takashi Mori' });
    await insertUser(db, { id: 3, username: 'wren', password: 'a good password', displayName: 'Wren Alvarez' });
    const aoife = await signIn(app, 'aoife', 'a good password');
    await app.request(
      '/games',
      withCookie(form({ board_size: '5', join_type: 'invited', invited_display_name: 'Takashi Mori' }), aoife),
    );

    const wren = await signIn(app, 'wren', 'a good password');
    const res = await app.request('/games/1/join', withCookie({ method: 'POST' }, wren));

    expect(res.status).toBe(404);
    expect(db.prepare('SELECT opponent_id FROM games').get()).toEqual({ opponent_id: null });
  });

  it('reports a refused join on the page the button was on', async () => {
    const { app, aoife, takashi } = await twoPlayers();
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    await app.request('/games/1/join', withCookie({ method: 'POST' }, takashi));

    const res = await app.request('/games/1/join', withCookie(form({ from: 'find' }), aoife));

    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('Find a game');
    expect(html).toContain('This game has already started');
  });

  it('reports an unknown game as not found', async () => {
    const { app, takashi } = await twoPlayers();

    expect((await app.request('/games/404/join', withCookie({ method: 'POST' }, takashi))).status).toBe(404);
  });
});

describe('navigation between the two game lists', () => {
  it('marks only the page you are on, not both /games and /games/find', async () => {
    const { app, session } = await playerApp();

    const find = await (await app.request('/games/find', withCookie({}, session))).text();
    expect(find).toContain('href="/games/find" aria-current="page"');
    expect(find).not.toContain('href="/games" aria-current="page"');

    const mine = await (await app.request('/games', withCookie({}, session))).text();
    expect(mine).toContain('href="/games" aria-current="page"');
    expect(mine).not.toContain('href="/games/find" aria-current="page"');
  });
});

describe('the game screen', () => {
  async function inPlayGame(): Promise<{
    app: App;
    db: Database.Database;
    aoife: string;
    takashi: string;
    gameId: number;
  }> {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'pw', displayName: 'Takashi Mori' });
    const aoife = await signIn(app, 'aoife', 'pw');
    const takashi = await signIn(app, 'takashi', 'pw');
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    await app.request('/games/1/join', withCookie(form({ from: 'find' }), takashi));
    return { app, db, aoife, takashi, gameId: 1 };
  }

  it('renders the board and history for a participant', async () => {
    const { app, aoife, gameId } = await inPlayGame();

    const res = await app.request(`/games/${gameId}`, withCookie({}, aoife));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Game 1');
    expect(html).toContain('data-square="a1"');
    // The x-data JSON is HTML-escaped so its quotes do not break the attribute.
    expect(html).toContain('x-data="takBoard({&quot;');
    expect(html).toContain('Your move');
    expect(html).toContain('Aoife Nolan');
    // Axes: files across the top, ranks down the side.
    expect(html).toContain('<span class="axis">a</span>');
    expect(html).toContain('<span class="axis">5</span>');
    // Your colour and the opening-turn colour.
    expect(html).toContain('You play ● (filled)');
    expect(html).toContain('your opening move places your opponent');
    // Stones left and the move-syntax summary.
    expect(html).toContain('Stones left');
    expect(html).toContain('Move syntax');
  });

  it('records a move and redirects back to the game screen', async () => {
    const { app, aoife, gameId } = await inPlayGame();

    const res = await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/games/${gameId}`);
  });

  it('numbers turns in PTN style, both halves under the same full move', async () => {
    const { app, aoife, takashi, gameId } = await inPlayGame();

    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));
    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'e5' }), takashi));

    const html = await (await app.request(`/games/${gameId}`, withCookie({}, aoife))).text();

    // Both halves of the first full move sit behind the one "1." marker.
    expect(html).toContain('1.</span>');
    expect(html).toContain('a1');
    expect(html).toContain('e5');
    expect(html).not.toContain('2.</span>');
    // The hover stack tooltip renders the glyph column.
    expect(html).toContain('class="stack-tip"');
  });

  it('rejects an illegal move with a clear message', async () => {
    const { app, aoife, gameId } = await inPlayGame();

    const res = await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'Sa1' }), aoife));

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('opening move must place a flat stone');
  });

  it('rejects a move when it is not your turn', async () => {
    const { app, takashi, gameId } = await inPlayGame();

    const res = await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), takashi));

    expect(res.status).toBe(409);
    expect(await res.text()).toContain('not your turn');
  });

  it('finishes the game on resignation', async () => {
    const { app, aoife, db, gameId } = await inPlayGame();

    const res = await app.request(`/games/${gameId}/resign`, withCookie(form({}), aoife));

    expect(res.status).toBe(303);
    const game = db.prepare('SELECT state, result FROM games WHERE id = ?').get(gameId);
    expect(game).toEqual({ state: 'finished', result: '0-1' });
  });

  it('hides a game the visitor cannot see', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'pw' });
    await insertUser(db, { id: 3, username: 'stranger', password: 'pw' });
    const aoife = await signIn(app, 'aoife', 'pw');
    const stranger = await signIn(app, 'stranger', 'pw');
    // Invited games start unshared, so a stranger cannot see it at all.
    await app.request(
      '/games',
      withCookie(form({ board_size: '5', join_type: 'invited', invited_display_name: 'takashi' }), aoife),
    );

    const res = await app.request('/games/1', withCookie({}, stranger));

    expect(res.status).toBe(404);
  });

  it('returns 404 for a game that does not exist', async () => {
    const { app, aoife } = await inPlayGame();

    const res = await app.request('/games/404', withCookie({}, aoife));

    expect(res.status).toBe(404);
  });
});

describe('self-play in one window', () => {
  it('lets one account play both seats and says so in the view', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw', displayName: 'Aoife Nolan' });
    const aoife = await signIn(app, 'aoife', 'pw');
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    await app.request('/games/1/join', withCookie(form({ from: 'games' }), aoife));

    const page = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(page).toContain('Self-play');
    expect(page).toContain('You play both colours');
    expect(page).not.toContain('Resign');
    expect(page).not.toContain('Offer draw');
    expect(page).not.toContain('Request take-back');

    // Both seats' moves come from the same account.
    expect((await app.request('/games/1/move', withCookie(form({ move: 'a1' }), aoife))).status).toBe(303);
    expect((await app.request('/games/1/move', withCookie(form({ move: 'e5' }), aoife))).status).toBe(303);
  });
});

describe('draw offers and take-backs at the game screen', () => {
  async function inPlayGame(): Promise<{ app: App; db: Database.Database; aoife: string; takashi: string }> {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'pw', displayName: 'Takashi Mori' });
    const aoife = await signIn(app, 'aoife', 'pw');
    const takashi = await signIn(app, 'takashi', 'pw');
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    await app.request('/games/1/join', withCookie(form({ from: 'find' }), takashi));
    return { app, db, aoife, takashi };
  }

  it('offers a draw, notifies the opponent, and finishes only on accept', async () => {
    const { app, aoife, takashi } = await inPlayGame();

    await app.request('/games/1/draw', withCookie(form({}), takashi));

    // The respondent sees the offer with accept/reject; the offerer sees waiting.
    const respondent = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(respondent).toContain('Takashi Mori offers a draw');
    expect(respondent).toContain('/draw/accept');
    expect(respondent).toContain('/draw/reject');
    const offerer = await (await app.request('/games/1', withCookie({}, takashi))).text();
    expect(offerer).toContain('Draw offered — waiting for a response');

    expect((await app.request('/games/1/draw/accept', withCookie(form({}), aoife))).status).toBe(303);
    const game = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(game).toContain('Draw by agreement');
  });

  it('rejects the offer and play continues', async () => {
    const { app, aoife, takashi } = await inPlayGame();
    await app.request('/games/1/draw', withCookie(form({}), takashi));

    expect((await app.request('/games/1/draw/reject', withCookie(form({}), aoife))).status).toBe(303);
    const page = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(page).not.toContain('offers a draw');
  });

  it('takes back the last move on accept', async () => {
    const { app, aoife, takashi } = await inPlayGame();
    await app.request('/games/1/move', withCookie(form({ move: 'a1' }), aoife));
    await app.request('/games/1/take-back', withCookie(form({}), aoife));

    const respondent = await (await app.request('/games/1', withCookie({}, takashi))).text();
    expect(respondent).toContain('requests a take-back');
    expect(respondent).toContain('/take-back/accept');

    expect((await app.request('/games/1/take-back/accept', withCookie(form({}), takashi))).status).toBe(303);
    const page = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(page).toContain('Your move'); // back to Aoife's turn
    expect(page).not.toContain('1.</span>'); // the move was undone
  });
});

describe('sharing, hiding, and admin removal at the game screen', () => {
  async function inPlayGame(): Promise<{ app: App; db: Database.Database; aoife: string; takashi: string }> {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'pw', displayName: 'Takashi Mori' });
    const aoife = await signIn(app, 'aoife', 'pw');
    const takashi = await signIn(app, 'takashi', 'pw');
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    await app.request('/games/1/join', withCookie(form({ from: 'find' }), takashi));
    return { app, db, aoife, takashi };
  }

  it('toggles the viewer’s own share and shows it on the page', async () => {
    const { app, aoife } = await inPlayGame();

    const shared = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(shared).toContain('Shared: anyone can view this game.');
    expect(shared).toContain('Stop sharing');

    const res = await app.request('/games/1/share', withCookie(form({ on: '0' }), aoife));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/games/1');

    const unshared = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(unshared).toContain('Not shared: only the two players can view this game.');
    expect(unshared).toContain('Share with spectators');
  });

  it('hides the game from the hider’s list and redirects there', async () => {
    const { app, aoife, takashi } = await inPlayGame();

    const res = await app.request('/games/1/hide', withCookie(form({}), aoife));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/games');
    expect(await (await app.request('/games', withCookie({}, aoife))).text()).toContain('No games yet');
    // Takashi never hid it, so it still shows for him.
    expect(await (await app.request('/games', withCookie({}, takashi))).text()).not.toContain('No games yet');
  });

  it('deletes the game once both players hide it', async () => {
    const { app, aoife, takashi } = await inPlayGame();
    await app.request('/games/1/hide', withCookie(form({}), aoife));

    await app.request('/games/1/hide', withCookie(form({}), takashi));

    expect((await app.request('/games/1', withCookie({}, aoife))).status).toBe(404);
  });

  it('lets an admin remove any game, leaving a warning for the players', async () => {
    const { app, db, aoife } = await inPlayGame();
    await insertUser(db, { id: 3, username: 'root', password: 'pw', role: 'admin' });
    const admin = await signIn(app, 'root', 'pw');

    const res = await app.request('/games/1/admin-delete', withCookie(form({}), admin));

    expect(res.status).toBe(303);
    expect(db.prepare('SELECT state, admin_removed FROM games WHERE id = 1').get()).toEqual({
      state: 'finished',
      admin_removed: 1,
    });

    const playerView = await (await app.request('/games/1', withCookie({}, aoife))).text();
    expect(playerView).toContain('This game was removed by an admin');
    const list = await (await app.request('/games', withCookie({}, aoife))).text();
    expect(list).toContain('removed by an admin');
  });

  it('lets an admin view a game that is not shared', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'pw' });
    await insertUser(db, { id: 3, username: 'root', password: 'pw', role: 'admin' });
    const aoife = await signIn(app, 'aoife', 'pw');
    await app.request(
      '/games',
      withCookie(form({ board_size: '5', join_type: 'invited', invited_display_name: 'takashi' }), aoife),
    );
    const admin = await signIn(app, 'root', 'pw');

    const res = await app.request('/games/1', withCookie({}, admin));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Remove this game');
  });

  it('refuses a non-admin the admin-delete route', async () => {
    const { app, aoife } = await inPlayGame();

    const res = await app.request('/games/1/admin-delete', withCookie(form({}), aoife));

    expect(res.status).toBe(403);
  });
});

describe('exporting a record from the game screen', () => {
  async function playedGame(): Promise<{ app: App; db: Database.Database; aoife: string; takashi: string }> {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw', displayName: 'Aoife Nolan' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'pw', displayName: 'Takashi Mori' });
    const aoife = await signIn(app, 'aoife', 'pw');
    const takashi = await signIn(app, 'takashi', 'pw');
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    await app.request('/games/1/join', withCookie(form({ from: 'find' }), takashi));
    await app.request('/games/1/move', withCookie(form({ move: 'a1' }), aoife));
    await app.request('/games/1/move', withCookie(form({ move: 'e5' }), takashi));
    return { app, db, aoife, takashi };
  }

  it('offers PTN and TPS links against every move and the whole game', async () => {
    const { app, aoife } = await playedGame();

    const html = await (await app.request('/games/1', withCookie({}, aoife))).text();

    // `&amp;` is the attribute form; the browser sends back a plain `&`.
    expect(html).toContain('/games/1/export?format=ptn&amp;through=1');
    expect(html).toContain('/games/1/export?format=tps&amp;through=1');
    expect(html).toContain('/games/1/export?format=ptn&amp;through=2');
    // The whole game carries no move number.
    expect(html).toContain('href="/games/1/export?format=ptn"');
  });

  it('shows the full PTN, ready to copy', async () => {
    const { app, aoife } = await playedGame();

    const res = await app.request('/games/1/export?format=ptn', withCookie({}, aoife));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('[Size &quot;5&quot;]');
    expect(html).toContain('[Player1 &quot;Aoife Nolan&quot;]');
    expect(html).toContain('1. a1 e5');
    expect(html).toContain('class="export-text"');
    expect(html).toContain('Back to the game');
  });

  it('shows the TPS after a chosen move', async () => {
    const { app, aoife } = await playedGame();

    const res = await app.request('/games/1/export?format=tps&through=1', withCookie({}, aoife));

    expect(res.status).toBe(200);
    const html = await res.text();
    // One half-move played: player 2 to move, still on move 1.
    expect(html).toContain('2 1</pre>');
    expect(html).toContain('position after move 1 of 2');
  });

  it('reports an unwritable format on the game page', async () => {
    const { app, aoife } = await playedGame();

    const res = await app.request('/games/1/export?format=pgn', withCookie({}, aoife));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Choose PTN or TPS');
  });

  it('reports a move number the game does not have', async () => {
    const { app, aoife } = await playedGame();

    const res = await app.request('/games/1/export?format=ptn&through=99', withCookie({}, aoife));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('choose one between 0 and 2');
  });

  it('hides an unshared game from a stranger', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'pw' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'pw' });
    await insertUser(db, { id: 3, username: 'stranger', password: 'pw' });
    const aoife = await signIn(app, 'aoife', 'pw');
    await app.request(
      '/games',
      withCookie(form({ board_size: '5', join_type: 'invited', invited_display_name: 'takashi' }), aoife),
    );
    const stranger = await signIn(app, 'stranger', 'pw');

    expect((await app.request('/games/1/export?format=ptn', withCookie({}, stranger))).status).toBe(404);
  });

  it('records the export in the activity trail', async () => {
    const { app, db, aoife } = await playedGame();

    await app.request('/games/1/export?format=ptn&through=1', withCookie({}, aoife));

    const row = db
      .prepare("SELECT user_id, game_id, payload FROM activity_trail WHERE event = 'game-exported'")
      .get() as { user_id: number; game_id: number; payload: string };
    expect(row).toMatchObject({ user_id: 1, game_id: 1 });
    expect(JSON.parse(row.payload)).toMatchObject({ format: 'ptn', throughMove: 1, complete: false });
  });
});
