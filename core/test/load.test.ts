import { describe, expect, it } from 'vitest';
import type { Result } from 'neverthrow';
import {
  createGame,
  createTakGame,
  formatMove,
  fromPtnText,
  generatePtn,
  generateTps,
  loadGame,
  playMove,
  positionsOf,
  resultCode,
  turnOf,
} from '../src/index';
import type { BoardSize, GameState, Move, ResultCode, StoredGame, StoredMove, TakGame } from '../src/index';
import { move, place, play } from './helpers';

/** Unwrap a loader/PTN result (both error shapes are just data). */
function mustTak<T>(r: Result<T, unknown>): T {
  if (r.isErr()) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function mustErr<T, E>(r: Result<T, E>): E {
  if (r.isOk()) throw new Error(`expected err, got ${JSON.stringify(r.value)}`);
  return r.error;
}

/** Replay a move list with the raw rules engine, for cross-checking the loader. */
function engineReplay(moves: readonly Move[], size: BoardSize = 5): GameState {
  return moves.reduce((g, m) => play(g, m), createGame(size));
}

/**
 * Write a record the way the store's write seam does: each live move is
 * validated by the core, then stored as canonical notation plus the TPS of the
 * position it produced.
 */
function writeRecord(
  size: BoardSize,
  imported: readonly Move[],
  live: readonly Move[],
  result: string | null = null,
): StoredGame {
  const importedPtn = imported.length === 0 ? null : mustTak(generatePtn(imported, size));
  let game: TakGame = importedPtn === null ? createTakGame(size) : mustTak(fromPtnText(importedPtn));
  const moves: StoredMove[] = [];
  let playedAt = 1_000;
  for (const m of live) {
    game = mustTak(playMove(game, m, playedAt));
    moves.push({ notation: formatMove(m), playedAt, position: generateTps(game.state) });
    playedAt += 1_000;
  }
  return { size, importedPtn, moves, result };
}

/** The opening pair plus two more moves — enough history to slice. */
const OPENING: Move[] = [place('a1', 'flat'), place('a5', 'flat'), place('c3', 'flat'), place('c4', 'flat')];

/** The 5×5 road win from the aggregate tests: P1 completes a3–e3 on move 11. */
function roadWinMoves(): Move[] {
  return [
    place('a1', 'flat'),
    place('a5', 'flat'),
    place('a3', 'flat'),
    place('a2', 'flat'),
    place('b3', 'flat'),
    place('a4', 'flat'),
    place('c3', 'flat'),
    place('b4', 'flat'),
    place('d3', 'flat'),
    place('b2', 'flat'),
    place('e3', 'flat'),
  ];
}

describe('loadGame: the loaded state is the fully-replayed state', () => {
  it('loads an empty record as a new game', () => {
    const loaded = mustTak(loadGame(writeRecord(5, [], [])));
    expect(loaded.state).toEqual(createGame(5));
    expect(loaded.history).toEqual([]);
    expect(loaded.fixedMoves).toBe(0);
    expect(loaded.result).toBeNull();
  });

  it('loads a live-only record', () => {
    const record = writeRecord(5, [], OPENING);
    const loaded = mustTak(loadGame(record));
    expect(loaded.state).toEqual(engineReplay(OPENING));
    expect(loaded.fixedMoves).toBe(0);
    expect(loaded.history.map((r) => r.move)).toEqual(OPENING);
    expect(loaded.history.map((r) => r.playedAt)).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  it('loads an imported-only record', () => {
    const record = writeRecord(5, OPENING, []);
    const loaded = mustTak(loadGame(record));
    expect(loaded.state).toEqual(engineReplay(OPENING));
    expect(loaded.fixedMoves).toBe(4);
    expect(loaded.history.map((r) => r.playedAt)).toEqual([null, null, null, null]);
  });

  it('loads an imported+live record, keeping the imported moves fixed', () => {
    const live = [place('e1', 'flat'), place('e5', 'flat')];
    const record = writeRecord(5, OPENING, live);
    const loaded = mustTak(loadGame(record));
    expect(loaded.state).toEqual(engineReplay([...OPENING, ...live]));
    expect(loaded.fixedMoves).toBe(4);
    expect(loaded.history.map((r) => r.move)).toEqual([...OPENING, ...live]);
    expect(loaded.history.map((r) => r.playedAt)).toEqual([null, null, null, null, 1_000, 2_000]);
  });

  it('loads a 6×6 record', () => {
    const opening = [place('a1', 'flat'), place('f6', 'flat'), place('c3', 'flat')];
    const loaded = mustTak(loadGame(writeRecord(6, [], opening)));
    expect(loaded.state).toEqual(engineReplay(opening, 6));
  });

  it('restores the engine outcome a decided position carries', () => {
    const moves = roadWinMoves();
    const loaded = mustTak(loadGame(writeRecord(5, [], moves, 'R-0')));
    expect(loaded.state).toEqual(engineReplay(moves));
    expect(loaded.state.outcome).toEqual({ type: 'road', winner: 1 });
  });

  it('restores a position reached by a stack move', () => {
    const moves = [
      place('a1', 'flat'),
      place('a5', 'flat'),
      place('b1', 'flat'),
      place('b2', 'flat'),
      move('b1', '+', [1]),
    ];
    const loaded = mustTak(loadGame(writeRecord(5, [], moves)));
    expect(loaded.state).toEqual(engineReplay(moves));
  });
});

describe('loadGame: the snapshot is the read path, replay is the fallback', () => {
  it('reads the last stored position rather than replaying', () => {
    const record = writeRecord(5, [], OPENING);
    // Corrupt an *earlier* snapshot: the fast path never looks at it.
    const moves = record.moves.map((m, i) => (i === 0 ? { ...m, position: 'nonsense' } : m));
    expect(mustTak(loadGame({ ...record, moves })).state).toEqual(engineReplay(OPENING));
  });

  it('falls back to replay when the last snapshot is null', () => {
    const record = writeRecord(5, [], OPENING);
    const moves = record.moves.map((m, i) => (i === OPENING.length - 1 ? { ...m, position: null } : m));
    const loaded = mustTak(loadGame({ ...record, moves }));
    expect(loaded.state).toEqual(engineReplay(OPENING));
  });

  it('replays from the imported position when the last snapshot is null', () => {
    const live = [place('e1', 'flat'), place('e5', 'flat')];
    const record = writeRecord(5, OPENING, live);
    const moves = record.moves.map((m) => ({ ...m, position: null }));
    expect(mustTak(loadGame({ ...record, moves })).state).toEqual(engineReplay([...OPENING, ...live]));
  });
});

describe('loadGame: the stored result string decides how the game ended', () => {
  const ends: ReadonlyArray<readonly [ResultCode, unknown]> = [
    ['R-0', { kind: 'board', outcome: { type: 'road', winner: 1 } }],
    ['0-R', { kind: 'board', outcome: { type: 'road', winner: 2 } }],
    ['F-0', { kind: 'board', outcome: { type: 'flat', winner: 1 } }],
    ['0-F', { kind: 'board', outcome: { type: 'flat', winner: 2 } }],
    ['1-0', { kind: 'resign', winner: 1 }],
    ['0-1', { kind: 'resign', winner: 2 }],
    ['1/2-1/2', { kind: 'mutual-draw' }],
    ['*', null],
  ];

  for (const [code, end] of ends) {
    it(`maps ${code}`, () => {
      const loaded = mustTak(loadGame(writeRecord(5, [], OPENING, code)));
      expect(loaded.result).toEqual(end);
      if (end !== null) expect(resultCode(loaded)).toBe(code === '*' ? null : code);
    });
  }

  it('leaves an unfinished record in play', () => {
    expect(mustTak(loadGame(writeRecord(5, [], OPENING))).result).toBeNull();
  });

  it('falls back to the board when the stored result says nothing', () => {
    // A won position ends the game whether or not the store got the word out;
    // this is what a full replay reports, so the two must not disagree.
    const loaded = mustTak(loadGame(writeRecord(5, [], roadWinMoves(), null)));
    expect(loaded.result).toEqual({ kind: 'board', outcome: { type: 'road', winner: 1 } });

    const importedPtn = mustTak(generatePtn(roadWinMoves(), 5));
    const fromImport = mustTak(loadGame({ size: 5, importedPtn, moves: [], result: null }));
    expect(fromImport.result).toEqual({ kind: 'board', outcome: { type: 'road', winner: 1 } });
  });

  it('knows a resigned game is finished though the position is open', () => {
    const loaded = mustTak(loadGame(writeRecord(5, [], OPENING, '1-0')));
    expect(loaded.state.outcome).toBeNull();
    expect(loaded.result).toEqual({ kind: 'resign', winner: 1 });
  });

  it('ignores the imported record\'s own result tag', () => {
    const importedPtn = mustTak(generatePtn(OPENING, 5, { result: '1-0' }));
    const loaded = mustTak(loadGame({ size: 5, importedPtn, moves: [], result: null }));
    expect(loaded.result).toBeNull();
  });
});

describe('positionsOf', () => {
  const live = [place('e1', 'flat'), place('e5', 'flat')];
  const all = [...OPENING, ...live];

  /** A position, as `positionsOf` reports it, for cross-checking against a fresh engine replay. */
  const tpsOf = (moves: readonly Move[], size: BoardSize = 5): string => generateTps(engineReplay(moves, size));

  it('is the empty board at 0', () => {
    const positions = mustTak(positionsOf(writeRecord(5, OPENING, live)));
    expect(positions[0]).toBe(generateTps(createGame(5)));
  });

  it('is the position inside imported history at each index', () => {
    const record = writeRecord(5, OPENING, live);
    const positions = mustTak(positionsOf(record));
    expect(positions[2]).toBe(tpsOf(OPENING.slice(0, 2)));
  });

  it('is the post-import position at fixedMoves', () => {
    const record = writeRecord(5, OPENING, live);
    const positions = mustTak(positionsOf(record));
    expect(positions[4]).toBe(tpsOf(OPENING));
  });

  it('is the stored snapshot inside live moves, used verbatim', () => {
    const record = writeRecord(5, OPENING, live);
    const positions = mustTak(positionsOf(record));
    expect(positions[5]).toBe(record.moves[0]!.position);
    expect(positions[5]).toBe(tpsOf(all.slice(0, 5)));
  });

  it('catches a garbled snapshot anywhere in the live moves, not just the last one', () => {
    // `positionsOf` restores every live move's own snapshot (the same trust
    // boundary `liveState` uses for the one `loadGame` needs), so a garbled
    // one is caught wherever it is, not just at the position actually read.
    const record = writeRecord(5, OPENING, live);
    const moves = record.moves.map((m, i) => (i === 0 ? { ...m, position: 'nonsense' } : m));
    expect(mustErr(positionsOf({ ...record, moves })).code).toBe('corrupt-record');
  });

  it('is the loaded state at the total', () => {
    const record = writeRecord(5, OPENING, live);
    const positions = mustTak(positionsOf(record));
    expect(positions[6]).toBe(generateTps(mustTak(loadGame(record)).state));
  });

  it('falls back to replay when a live snapshot is null', () => {
    const record = writeRecord(5, [], all);
    const moves = record.moves.map((m, i) => (i === 3 ? { ...m, position: null } : m));
    const positions = mustTak(positionsOf({ ...record, moves }));
    expect(positions[4]).toBe(tpsOf(all.slice(0, 4)));
  });
});

describe('turnOf', () => {
  it('is the player to move in a stored position', () => {
    const live = [place('e1', 'flat'), place('e5', 'flat')];
    const record = writeRecord(5, OPENING, live);
    const snapshot = record.moves.at(-1)!.position!;
    expect(mustTak(turnOf(snapshot, 5))).toEqual(loadGame(record)._unsafeUnwrap().state.playerToMove);
  });

  it('rejects a stored position that no longer parses', () => {
    expect(mustErr(turnOf('nonsense', 5)).code).toBe('corrupt-record');
  });

  it('rejects a stored position whose size is not the record\'s', () => {
    const record = writeRecord(6, [], OPENING);
    const snapshot = record.moves.at(-1)!.position!;
    expect(mustErr(turnOf(snapshot, 5)).code).toBe('corrupt-record');
  });
});

describe('corrupt records', () => {
  const corrupt = (record: StoredGame): string => {
    const error = mustErr(loadGame(record));
    expect(error.code).toBe('corrupt-record');
    return error.message;
  };

  it('rejects imported PTN that no longer parses', () => {
    expect(corrupt({ size: 5, importedPtn: '[Size "5"]\n1. zz9', moves: [], result: null })).toMatch(/imported/);
  });

  it('rejects an imported record whose size is not the record\'s', () => {
    const importedPtn = mustTak(generatePtn([place('a1', 'flat'), place('f6', 'flat')], 6));
    expect(corrupt({ size: 5, importedPtn, moves: [], result: null })).toMatch(/6/);
  });

  it('rejects a stored move that no longer parses', () => {
    const record = writeRecord(5, [], OPENING);
    const moves = record.moves.map((m, i) => (i === 1 ? { ...m, notation: 'zz9' } : m));
    expect(corrupt({ ...record, moves })).toMatch(/move 2/);
  });

  it('rejects a stored position that no longer parses', () => {
    const record = writeRecord(5, [], OPENING);
    const moves = record.moves.map((m, i) => (i === OPENING.length - 1 ? { ...m, position: 'nonsense' } : m));
    expect(corrupt({ ...record, moves })).toMatch(/position/);
  });

  it('rejects a stored move that no longer replays', () => {
    const record = writeRecord(5, [], OPENING);
    // Drop every snapshot so the fallback replays, then make move 3 illegal:
    // a1 is already occupied by the opening.
    const moves = record.moves.map((m, i) => ({ ...m, position: null, notation: i === 2 ? 'a1' : m.notation }));
    expect(corrupt({ ...record, moves })).toMatch(/move 3/);
  });

  it('rejects a stored result that is not a PTN result code', () => {
    expect(corrupt(writeRecord(5, [], OPENING, 'winner: me'))).toMatch(/winner: me/);
  });

  it('never names a game id — the store composes that', () => {
    const record = writeRecord(5, [], OPENING);
    const moves = record.moves.map((m, i) => (i === 1 ? { ...m, notation: 'zz9' } : m));
    expect(corrupt({ ...record, moves })).not.toMatch(/game \d/);
  });

  it('reports corruption from positionsOf too', () => {
    const record = writeRecord(5, [], OPENING);
    const moves = record.moves.map((m, i) => (i === 1 ? { ...m, position: 'nonsense' } : m));
    expect(mustErr(positionsOf({ ...record, moves })).code).toBe('corrupt-record');
  });
});

describe('loadGame: a snapshot carries no verdict, so the loader recovers it', () => {
  // P1 holds all 21 stones and the capstone on the board, so their reserve is
  // empty; the board is far from full and neither player has a road. Only the
  // kind of the last move decides whether this position ended the game.
  const EXHAUSTED = 'x5/x5/x5/x5/111111111111111111111,1C,x3 2 12';

  const loadedAfter = (notation: string): TakGame =>
    mustTak(
      loadGame({
        size: 5,
        importedPtn: null,
        result: null,
        moves: [{ notation, playedAt: 1_000, position: EXHAUSTED }],
      }),
    );

  it('ends the game when the last move placed the mover\'s final stone', () => {
    expect(loadedAfter('a1').state.outcome).toEqual({ type: 'flat', winner: 1 });
  });

  it('leaves the game open when the last move was a stack move', () => {
    // A stack move places nothing, so an empty reserve does not end anything.
    expect(loadedAfter('2a1>11').state.outcome).toBeNull();
  });
});
