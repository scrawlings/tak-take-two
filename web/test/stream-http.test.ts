import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createApp, type App } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';
import { hashPassword } from '../src/passwords.js';

/**
 * The live-update routes as adapters (ticket 14): they authenticate, ask the
 * Game module what this viewer may see, and push the same regions the page
 * itself renders. Visibility is the module's answer, never the route's — a
 * game the viewer cannot open is a game they cannot watch.
 */

const silent: Logger = { log() {} };

function makeApp(): { app: App; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return {
    app: createApp({
      persistence: createPersistence(db),
      metrics: new Metrics(),
      logger: silent,
      // Long enough that no test ever sees a heartbeat it did not ask for.
      heartbeatMs: 60_000,
    }),
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
  const id = cookie ? /tak_session=([^;]+)/.exec(cookie)?.[1] : undefined;
  if (!id) throw new Error('sign-in did not set a session cookie');
  return id;
}

function withCookie(init: RequestInit, session: string): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), cookie: `tak_session=${session}` } };
}

/** One SSE frame: its event name and its parsed data. */
interface Frame {
  event: string;
  data: string;
}

/**
 * A reader over an open stream. Frames arrive one at a time; `close` cancels
 * the body, which is what a browser closing the tab does.
 */
function reader(res: Response): {
  next: () => Promise<Frame>;
  ended: () => Promise<boolean>;
  close: () => Promise<void>;
} {
  const stream = res.body;
  if (stream === null) throw new Error('the stream had no body');
  const decoder = new TextDecoder();
  const source = stream.getReader();
  let buffer = '';

  const readFrame = async (): Promise<Frame> => {
    for (;;) {
      const split = buffer.indexOf('\n\n');
      if (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        return { event, data };
      }
      const chunk = await source.read();
      if (chunk.done) throw new Error(`the stream ended with ${JSON.stringify(buffer)} unread`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  /** True once the server closed the stream; false if another frame arrived. */
  const ended = async (): Promise<boolean> => {
    for (;;) {
      if (buffer.includes('\n\n')) return false;
      const chunk = await source.read();
      if (chunk.done) return true;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  return { next: readFrame, ended, close: () => source.cancel() };
}

function regionsOf(frame: Frame): Record<string, string> {
  expect(frame.event).toBe('state');
  return (JSON.parse(frame.data) as { regions: Record<string, string> }).regions;
}

/** Two players, a 5×5 game in play, and the session of each. */
async function gameInPlay(): Promise<{
  app: App;
  db: Database.Database;
  aoife: string;
  takashi: string;
  spectator: string;
  gameId: number;
}> {
  const { app, db } = makeApp();
  await insertUser(db, { id: 1, username: 'aoife', password: 'a good password', displayName: 'Aoife Nolan' });
  await insertUser(db, { id: 2, username: 'takashi', password: 'a good password', displayName: 'Takashi Mori' });
  await insertUser(db, { id: 3, username: 'sam', password: 'a good password', displayName: 'Sam Doyle' });
  const aoife = await signIn(app, 'aoife', 'a good password');
  const takashi = await signIn(app, 'takashi', 'a good password');
  const spectator = await signIn(app, 'sam', 'a good password');

  await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
  const gameId = (db.prepare('SELECT id FROM games').get() as { id: number }).id;
  await app.request(`/games/${gameId}/join`, withCookie(form({}), takashi));
  return { app, db, aoife, takashi, spectator, gameId };
}

async function openStream(app: App, path: string, session: string): Promise<Response> {
  return app.request(path, withCookie({}, session));
}

describe('GET /games/:id/stream', () => {
  it('turns a signed-out visitor away rather than opening a stream', async () => {
    const { app, gameId } = await gameInPlay();

    const res = await app.request(`/games/${gameId}/stream`);

    expect(res.status).toBe(303);
  });

  it('opens as an event stream and sends the position straight away', async () => {
    const { app, aoife, gameId } = await gameInPlay();

    const res = await openStream(app, `/games/${gameId}/stream`, aoife);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const stream = reader(res);
    const regions = regionsOf(await stream.next());
    expect(Object.keys(regions).sort()).toEqual(['board', 'controls', 'moves', 'reserves', 'status']);
    expect(regions.moves).toContain('No moves yet');
    await stream.close();
  });

  it('renders every streamed region exactly as the page itself renders it', async () => {
    // One set of view functions serves both, so a streamed page and a reloaded
    // one cannot drift apart — and the client's skip-if-unchanged rule has
    // something to bite on for the regions Alpine does not rewrite.
    const { app, aoife, gameId } = await gameInPlay();
    const page = await (await app.request(`/games/${gameId}`, withCookie({}, aoife))).text();

    const stream = reader(await openStream(app, `/games/${gameId}/stream`, aoife));
    const regions = regionsOf(await stream.next());

    for (const html of Object.values(regions)) {
      expect(page).toContain(html);
    }
    await stream.close();
  });

  it('pushes the opponent’s move to a player who is only watching the page', async () => {
    const { app, aoife, takashi, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    await stream.next(); // the opening frame

    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    const regions = regionsOf(await stream.next());
    expect(regions.moves).toContain('a1');
    expect(regions.status).toContain('Your turn');
    await stream.close();
  });

  it('pushes the board’s own standing, so the click-builder wakes with the turn', async () => {
    // The move form arriving is only half of it: the board must also start
    // accepting clicks. Its standing therefore rides inside the streamed board
    // region, never in the `x-data` config the stream leaves alone.
    const { app, aoife, takashi, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    expect(regionsOf(await stream.next()).board).toContain('data-can-move="0"');

    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    const board = regionsOf(await stream.next()).board ?? '';
    expect(board).toContain('data-can-move="1"');
    expect(board).toContain('data-viewer-seat="2"');
    await stream.close();
  });

  it('pushes the move form to the player whose turn it has become', async () => {
    // A fresh board beside a form that still says "waiting" is the very
    // inconsistency the stream exists to remove.
    const { app, aoife, takashi, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    expect(regionsOf(await stream.next()).controls).not.toContain('Play move');

    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    expect(regionsOf(await stream.next()).controls).toContain('Play move');
    await stream.close();
  });

  it('keeps the board and the history in step across near-simultaneous moves', async () => {
    const { app, aoife, takashi, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    await stream.next();

    // Both players move while the stream is not being read. However the frames
    // fall out, each must be a whole position — a board, a move list and a
    // stone count that agree — and the last must be the position after both.
    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));
    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'e5' }), takashi));

    let regions: Record<string, string> = {};
    for (let frames = 0; frames < 4; frames++) {
      regions = regionsOf(await stream.next());
      const listed = (regions.moves ?? '').match(/>[a-e][1-5]</g)?.length ?? 0;
      const placed = (regions.board ?? '').match(/data-height="1"/g)?.length ?? 0;
      expect(placed, 'the board and the move list are a move apart').toBe(listed);
      // Each stone placed is one fewer in a reserve, both starting at 21.
      expect(regions.reserves).toContain(String(21 - Math.ceil(listed / 2)));
      if (listed === 2) break;
    }

    expect(regions.moves).toContain('a1');
    expect(regions.moves).toContain('e5');
    expect(regions.board).toContain('data-square="a1" data-height="1"');
    expect(regions.board).toContain('data-square="e5" data-height="1"');
    await stream.close();
  });

  it('pushes the ending when a player resigns', async () => {
    const { app, aoife, takashi, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    await stream.next();

    await app.request(`/games/${gameId}/resign`, withCookie(form({}), aoife));

    expect(regionsOf(await stream.next()).status).toContain('wins by resignation');
    await stream.close();
  });

  it('refuses a spectator an unshared game, permanently — no stream to reconnect to', async () => {
    const { app, aoife, spectator, gameId } = await gameInPlay();
    await app.request(`/games/${gameId}/share`, withCookie(form({ on: '0' }), aoife));

    const res = await openStream(app, `/games/${gameId}/stream`, spectator);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
  });

  it('lets a spectator watch a shared game live', async () => {
    const { app, aoife, spectator, gameId } = await gameInPlay();

    const stream = reader(await openStream(app, `/games/${gameId}/stream`, spectator));
    await stream.next();
    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    expect(regionsOf(await stream.next()).moves).toContain('a1');
    await stream.close();
  });

  it('tells a watching spectator the game is gone once it stops being shared', async () => {
    const { app, aoife, spectator, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, spectator));
    await stream.next();

    await app.request(`/games/${gameId}/share`, withCookie(form({ on: '0' }), aoife));

    expect((await stream.next()).event).toBe('gone');
  });

  it('tells the players an admin has removed the game', async () => {
    const { app, db, takashi, gameId } = await gameInPlay();
    await insertUser(db, { id: 4, username: 'root', password: 'a good password', role: 'admin' });
    const admin = await signIn(app, 'root', 'a good password');
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    await stream.next();

    await app.request(`/games/${gameId}/admin-delete`, withCookie(form({}), admin));

    // The game is still theirs to see, carrying the removal notice.
    expect(regionsOf(await stream.next()).status).toContain('removed by an admin');
    await stream.close();
  });

  it('stops streaming to a session that has been ended', async () => {
    // A stream outlives the request that opened it, so ending every session
    // (ticket 07) has to end the open streams too.
    const { app, aoife, takashi, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    await stream.next();

    await app.request(
      '/account/password',
      withCookie(form({ old_password: 'a good password', new_password: 'another good one' }), takashi),
    );
    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    expect(await stream.ended()).toBe(true);
  });

  it('stops streaming to a player an admin has blocked', async () => {
    const { app, db, aoife, takashi, gameId } = await gameInPlay();
    await insertUser(db, { id: 4, username: 'root', password: 'a good password', role: 'admin' });
    const admin = await signIn(app, 'root', 'a good password');
    const stream = reader(await openStream(app, `/games/${gameId}/stream`, takashi));
    await stream.next();

    await app.request('/admin/users/2/block', withCookie(form({}), admin));
    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    expect(await stream.ended()).toBe(true);
  });

  it('answers a game that does not exist the way the page does', async () => {
    const { app, aoife } = await gameInPlay();

    expect((await openStream(app, '/games/9999/stream', aoife)).status).toBe(404);
    expect((await openStream(app, '/games/nonsense/stream', aoife)).status).toBe(404);
  });

  it('sends a heartbeat when nothing has happened, so an idle connection stays up', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'aoife', password: 'a good password' });
    await insertUser(db, { id: 2, username: 'takashi', password: 'a good password' });
    const aoife = await signIn(app, 'aoife', 'a good password');
    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), aoife));
    const gameId = (db.prepare('SELECT id FROM games').get() as { id: number }).id;

    // An app of its own, beating fast enough to observe.
    const quick = createApp({
      persistence: createPersistence(db),
      metrics: new Metrics(),
      logger: silent,
      heartbeatMs: 1,
    });
    const stream = reader(await openStream(quick, `/games/${gameId}/stream`, aoife));
    await stream.next();

    expect((await stream.next()).event).toBe('ping');
    await stream.close();
  });
});

describe('GET /games/stream', () => {
  it('pushes the player’s own list when one of their games changes', async () => {
    const { app, aoife, gameId } = await gameInPlay();
    const stream = reader(await openStream(app, '/games/stream', aoife));
    // Whose turn it is is on the list, so the list moves with the game. Aoife
    // holds seat 1, so her own name fills the "to move" cell until she plays.
    expect(regionsOf(await stream.next()).games).toContain('Aoife Nolan');

    await app.request(`/games/${gameId}/move`, withCookie(form({ move: 'a1' }), aoife));

    const games = regionsOf(await stream.next()).games ?? '';
    expect(games).not.toContain('Aoife Nolan');
    expect(games).toContain('Takashi Mori');
    await stream.close();
  });

  it('shows a newly proposed game without a reload', async () => {
    const { app, takashi } = await gameInPlay();
    const stream = reader(await openStream(app, '/games/stream', takashi));
    await stream.next();

    await app.request('/games', withCookie(form({ board_size: '6', join_type: 'open' }), takashi));

    expect(regionsOf(await stream.next()).games).toContain('6×6');
    await stream.close();
  });

  it('refuses an admin, who has no games of their own', async () => {
    const { app, db } = await gameInPlay();
    await insertUser(db, { id: 4, username: 'root', password: 'a good password', role: 'admin' });
    const admin = await signIn(app, 'root', 'a good password');

    expect((await openStream(app, '/games/stream', admin)).status).toBe(403);
  });
});

describe('GET /games/find/stream', () => {
  it('shows a proposal appearing under the same filters the search used', async () => {
    const { app, takashi, spectator } = await gameInPlay();
    const stream = reader(await openStream(app, '/games/find/stream?board_size=6', spectator));
    expect(regionsOf(await stream.next()).games).toContain('No proposals match');

    await app.request('/games', withCookie(form({ board_size: '6', join_type: 'open' }), takashi));

    expect(regionsOf(await stream.next()).games).toContain('6×6');
    await stream.close();
  });

  it('keeps a proposal that the filters exclude out of the stream’s answer', async () => {
    const { app, takashi, spectator } = await gameInPlay();
    const stream = reader(await openStream(app, '/games/find/stream?board_size=6', spectator));
    await stream.next();

    await app.request('/games', withCookie(form({ board_size: '5', join_type: 'open' }), takashi));

    expect(regionsOf(await stream.next()).games).toContain('No proposals match');
    await stream.close();
  });

  it('refuses a search it cannot run rather than streaming an empty one', async () => {
    const { app, spectator } = await gameInPlay();

    expect((await openStream(app, '/games/find/stream?board_size=7', spectator)).status).toBe(400);
  });
});

describe('the streamed pages', () => {
  it('carry the stream component and the regions it swaps', async () => {
    const { app, aoife, gameId } = await gameInPlay();

    const html = await (await app.request(`/games/${gameId}`, withCookie({}, aoife))).text();

    expect(html).toContain(`takStream(`);
    expect(html).toContain(`/games/${gameId}/stream`);
    for (const name of ['status', 'board', 'controls', 'reserves', 'moves']) {
      expect(html).toContain(`data-region="${name}"`);
    }
  });

  it('keep the click-builder’s scope outside every region the stream replaces', async () => {
    const { app, aoife, gameId } = await gameInPlay();

    const html = await (await app.request(`/games/${gameId}`, withCookie({}, aoife))).text();

    // The board region opens after the takBoard scope does, so a swap can
    // never take the scope with it (ADR-0007).
    expect(html.indexOf('x-data="takBoard(')).toBeLessThan(html.indexOf('data-region="board"'));
  });

  it('leave the propose form outside the stream, so a draft survives an update', async () => {
    const { app, aoife } = await gameInPlay();

    const html = await (await app.request('/games', withCookie({}, aoife))).text();

    expect(html).toContain('/games/stream');
    expect(html.indexOf('data-region="games"')).toBeLessThan(html.indexOf('action="/games"'));
  });

  it('point the search stream at the filters the page was drawn with', async () => {
    const { app, spectator } = await gameInPlay();

    const html = await (await app.request('/games/find?board_size=6', withCookie({}, spectator))).text();

    expect(html).toContain('/games/find/stream?board_size=6');
  });
});
