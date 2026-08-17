import { describe, expect, it } from 'vitest';
import type { Result } from 'neverthrow';
import { createGame, generatePtn, getStack, parsePtn } from '../src/index';
import type { BoardSize, GameState, Move, ResultCode } from '../src/index';
import { must, play, place, sq } from './helpers';

/** Unwrap a PTN result (neverthrow's Result is generic over its error). */
function mustPtn<T>(r: Result<T, unknown>): T {
  if (r.isErr()) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

/** Replay a move list from an empty board, returning the final state. */
function played(moves: readonly Move[], size: BoardSize = 5): GameState {
  return moves.reduce((g, m) => play(g, m), createGame(size));
}

function rec(moves: Move[], g: GameState, m: Move): GameState {
  moves.push(m);
  return play(g, m);
}

/** The 5×5 road win from game.test.ts: P1 wins on move 6. */
function roadWinMoves(): Move[] {
  const moves: Move[] = [];
  let g = createGame(5);
  g = rec(moves, g, place('a1', 'flat'));
  g = rec(moves, g, place('a5', 'flat'));
  g = rec(moves, g, place('a3', 'flat'));
  g = rec(moves, g, place('a2', 'flat'));
  g = rec(moves, g, place('b3', 'flat'));
  g = rec(moves, g, place('a4', 'flat'));
  g = rec(moves, g, place('c3', 'flat'));
  g = rec(moves, g, place('b4', 'flat'));
  g = rec(moves, g, place('d3', 'flat'));
  g = rec(moves, g, place('b2', 'flat'));
  rec(moves, g, place('e3', 'flat'));
  return moves;
}

/** P1's capstone crushes P2's standing stone on move 4. */
function crushMoves(): Move[] {
  const moves: Move[] = [];
  let g = createGame(5);
  g = rec(moves, g, place('a1', 'flat'));
  g = rec(moves, g, place('a5', 'flat'));
  g = rec(moves, g, place('b1', 'flat'));
  g = rec(moves, g, place('b2', 'flat'));
  g = rec(moves, g, place('c1', 'capstone'));
  g = rec(moves, g, place('d1', 'standing'));
  g = rec(moves, g, { type: 'move', square: sq('c1'), direction: '>', drops: [1] });
  rec(moves, g, place('e1', 'flat'));
  return moves;
}

describe('parsePtn', () => {
  it('parses a full record: tags, numbered moves, stack moves, and a result', () => {
    const text = [
      '[Site "PlayTak.com"]',
      '[Event "Online Play"]',
      '[Date "2018.10.28"]',
      '[Time "16:10:44"]',
      '[Player1 "NohatCoder"]',
      '[Player2 "fwwwwibib"]',
      '[Clock "10:0 +20"]',
      '[Result "R-0"]',
      '[Size "6"]',
      '',
      '1. a6 f6',
      '2. d4 c4',
      '3. d3 c3',
      '4. d5 c5',
      '5. d2 Ce4',
      '6. c2 e3',
      '7. e2 b2',
      '8. Cb3 1e4<1',
      '9. 1d3<1 Sd1',
      '10. a3 1d1+1',
      'R-0',
    ].join('\n');

    const p = mustPtn(parsePtn(text));
    expect(p.size).toBe(6);
    expect(p.moves).toHaveLength(20);
    expect(p.result).toBe('R-0');
    expect(p.tags.get('Player1')).toBe('NohatCoder');
    expect(p.tags.get('Clock')).toBe('10:0 +20');
    expect(p.tags.get('Size')).toBe('6');

    // Spot-check typed moves: Cb3, 1e4<1, 1d3<1, Sd1, 1d1+1
    expect(p.moves[14]).toEqual({ type: 'place', square: sq('b3'), stone: 'capstone' });
    expect(p.moves[15]).toEqual({ type: 'move', square: sq('e4'), direction: '<', drops: [1] });
    expect(p.moves[16]).toEqual({ type: 'move', square: sq('d3'), direction: '<', drops: [1] });
    expect(p.moves[17]).toEqual({ type: 'place', square: sq('d1'), stone: 'standing' });
    expect(p.moves[19]).toEqual({ type: 'move', square: sq('d1'), direction: '+', drops: [1] });
  });

  it('enforces the opponent-stone opening', () => {
    const r = parsePtn('[Size "5"]\n1. Sa1 a2');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ptn-illegal-move');
      expect(r.error.moveNumber).toBe(1);
      expect(r.error.player).toBe(1);
      expect(r.error.ruleError?.code).toBe('opening-must-be-flat');
    }
  });

  it('rejects an illegal move and identifies the offending move', () => {
    // a1- runs off the board on player 2's second move
    const r = parsePtn('[Size "5"]\n1. a1 a5\n2. b1 a1-');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ptn-illegal-move');
      expect(r.error.moveNumber).toBe(2);
      expect(r.error.player).toBe(2);
      expect(r.error.ruleError?.code).toBe('drops-off-board');
    }
  });

  it('rejects a stack move from an empty square', () => {
    const r = parsePtn('[Size "5"]\n1. a1 a2\n2. b1 5b2>5');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ptn-illegal-move');
      expect(r.error.moveNumber).toBe(2);
      expect(r.error.player).toBe(2);
      expect(r.error.ruleError?.code).toBe('source-empty');
    }
  });

  it('rejects moves after the game has finished', () => {
    const r = parsePtn('[Size "5"]\n1. a1 a5\n2. a3 a2\n3. b3 a4\n4. c3 b4\n5. d3 b2\n6. e3 e1');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ptn-illegal-move');
      expect(r.error.moveNumber).toBe(6);
      expect(r.error.player).toBe(2);
      expect(r.error.ruleError?.code).toBe('game-finished');
    }
  });

  it('rejects moves that are off-board for the board size', () => {
    const r = parsePtn('[Size "5"]\n1. f6 f1');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ptn-illegal-move');
      expect(r.error.moveNumber).toBe(1);
      expect(r.error.ruleError?.code).toBe('square-off-board');
    }
  });

  it('parses every result code', () => {
    const codes: ResultCode[] = ['R-0', '0-R', 'F-0', '0-F', '1-0', '0-1', '1/2-1/2', '*'];
    for (const code of codes) {
      const p = mustPtn(parsePtn(`[Size "5"]\n1. a1 a2\n${code}`));
      expect(p.result).toBe(code);
    }
  });

  it('handles comments without misparsing', () => {
    const text = [
      '{a leading comment [not a tag]}',
      '[Size "5"]',
      '{the opening}',
      '1. a1 {first stone} a2',
      '{multi-line',
      'comment}',
      '2. b1 b2',
    ].join('\n');
    const p = mustPtn(parsePtn(text));
    expect(p.moves).toHaveLength(4);
    expect(p.size).toBe(5);
  });

  it('strips informational marks from moves and ignores standalone annotations', () => {
    const p = mustPtn(parsePtn('[Size "5"]\n1. a1! a2? 2. b1!! b2\''));
    expect(p.moves).toEqual([
      { type: 'place', square: sq('a1'), stone: 'flat' },
      { type: 'place', square: sq('a2'), stone: 'flat' },
      { type: 'place', square: sq('b1'), stone: 'flat' },
      { type: 'place', square: sq('b2'), stone: 'flat' },
    ]);

    const annotated = mustPtn(parsePtn('[Size "5"]\n1. a1 ! a2'));
    expect(annotated.moves).toHaveLength(2);
  });

  it('strips the crush mark and replays a capstone crush', () => {
    const p = mustPtn(parsePtn('[Size "5"]\n1. a1 a5\n2. b1 b2\n3. Cc1 d1\n4. 1c1>1* e1'));
    expect(p.moves[6]).toEqual({ type: 'move', square: sq('c1'), direction: '>', drops: [1] });
    // The crush is legal and leaves the wall flattened under the capstone.
    const state = played(p.moves);
    expect(must(getStack(state, sq('d1')))).toEqual([
      { player: 2, kind: 'flat' },
      { player: 1, kind: 'capstone' },
    ]);
  });

  it('parses every stack-move shorthand form', () => {
    // a1> — count and drop counts omitted (both 1); 2b1> — count given, drops omitted
    const p = mustPtn(parsePtn('[Size "5"]\n1. a1 a2\n2. b1 b2\n3. e1 a1>\n4. e2 2b1>'));
    expect(p.moves[5]).toEqual({ type: 'move', square: sq('a1'), direction: '>', drops: [1] });
    expect(p.moves[7]).toEqual({ type: 'move', square: sq('b1'), direction: '>', drops: [2] });
    expect(played(p.moves).outcome).toBeNull();
  });

  it('accepts the alternate arrow directions', () => {
    const p = mustPtn(parsePtn('[Size "5"]\n1. a1 a2\n2. b1 a1→'));
    expect(p.moves[3]).toEqual({ type: 'move', square: sq('a1'), direction: '>', drops: [1] });
  });

  it('accepts lowercase stone letters and the explicit F identifier', () => {
    const p = mustPtn(parsePtn('[Size "5"]\n1. Fa1 a2\n2. b1 sb2\n3. e1 a1>1c'));
    expect(p.moves[0]).toEqual({ type: 'place', square: sq('a1'), stone: 'flat' });
    expect(p.moves[3]).toEqual({ type: 'place', square: sq('b2'), stone: 'standing' });
    // The trailing lowercase stone letter is informational and ignored.
    expect(p.moves[5]).toEqual({ type: 'move', square: sq('a1'), direction: '>', drops: [1] });
  });

  it('rejects drop counts that do not sum to the lift count', () => {
    const r = parsePtn('[Size "5"]\n1. a1 a2\n2. b1 5b4>21');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ptn-drops-mismatch');
      expect(r.error.token).toBe('5b4>21');
    }
  });

  it('rejects a drop count of zero', () => {
    const r = parsePtn('[Size "5"]\n1. a1 a2\n2. b1 2a1>10');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('ptn-bad-drops');
  });

  it('rejects malformed move tokens', () => {
    for (const bad of ['z1', 'a7', 'a1x', 'x9', '1/2']) {
      const r = parsePtn(`[Size "5"]\n1. a1 a2\n2. b1 ${bad}`);
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.code).toBe('ptn-invalid-token');
    }
  });

  it('rejects an unterminated comment', () => {
    const r = parsePtn('[Size "5"]\n1. a1 {oops');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('ptn-unterminated-comment');
  });

  it('requires a valid [Size] tag', () => {
    const missing = parsePtn('1. a1 a2');
    expect(missing.isErr()).toBe(true);
    if (missing.isErr()) expect(missing.error.code).toBe('ptn-missing-size');

    for (const size of ['7', '5x5', '']) {
      const r = parsePtn(`[Size "${size}"]\n1. a1 a2`);
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.code).toBe('ptn-bad-size');
    }
  });

  it('rejects a malformed tag', () => {
    const r = parsePtn('[Size "5"\n1. a1 a2');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('ptn-bad-tag');
  });

  it('rejects inconsistent or missing move numbers', () => {
    const skipped = parsePtn('[Size "5"]\n1. a1 a2\n3. b1 b2');
    expect(skipped.isErr()).toBe(true);
    if (skipped.isErr()) expect(skipped.error.code).toBe('ptn-bad-move-number');

    const unnumbered = parsePtn('[Size "5"]\na1 a2');
    expect(unnumbered.isErr()).toBe(true);
    if (unnumbered.isErr()) expect(unnumbered.error.code).toBe('ptn-bad-move-number');

    const midMove = parsePtn('[Size "5"]\n1. a1 a2\n2. b1 2. c1');
    expect(midMove.isErr()).toBe(true);
    if (midMove.isErr()) expect(midMove.error.code).toBe('ptn-bad-move-number');

    const ellipsis = parsePtn('[Size "5"]\n1. a1 a2\n2... b1');
    expect(ellipsis.isErr()).toBe(true);
    if (ellipsis.isErr()) expect(ellipsis.error.code).toBe('ptn-bad-move-number');
  });

  it('rejects moves or numbers after the result, and duplicate results', () => {
    const after = parsePtn('[Size "5"]\n1. a1 a2 R-0 b1');
    expect(after.isErr()).toBe(true);
    if (after.isErr()) expect(after.error.code).toBe('ptn-move-after-result');

    const dup = parsePtn('[Size "5"]\n1. a1 a2 R-0 F-0');
    expect(dup.isErr()).toBe(true);
    if (dup.isErr()) expect(dup.error.code).toBe('ptn-duplicate-result');
  });

  it('accepts a record ending after player 1\'s move (a prefix)', () => {
    const p = mustPtn(parsePtn('[Size "5"]\n1. a1 a2\n2. b1'));
    expect(p.moves).toHaveLength(3);
    expect(p.result).toBeNull();
  });

  it('accepts tags-only records and a record with only a result', () => {
    const empty = mustPtn(parsePtn('[Size "5"]'));
    expect(empty.moves).toEqual([]);
    expect(empty.result).toBeNull();
    expect(empty.size).toBe(5);

    const onlyResult = mustPtn(parsePtn('[Size "5"]\n\nR-0'));
    expect(onlyResult.moves).toEqual([]);
    expect(onlyResult.result).toBe('R-0');
  });

  it('parses multiple tags on one line with leading whitespace', () => {
    const p = mustPtn(parsePtn('   [Site "PlayTak.com"]   [Size "5"]\n1. a1 a2'));
    expect(p.tags.get('Site')).toBe('PlayTak.com');
    expect(p.size).toBe(5);
  });
});

describe('generatePtn', () => {
  it('generates a full game with tags and result', () => {
    const moves = roadWinMoves();
    const r = mustPtn(generatePtn(moves, 5, {
      tags: [['Player1', 'Alice'], ['Player2', 'Bob']],
      result: 'R-0',
    }));
    expect(r).toBe(
      '[Size "5"]\n[Player1 "Alice"]\n[Player2 "Bob"]\n[Result "R-0"]\n\n1. a1 a5\n2. a3 a2\n3. b3 a4\n4. c3 b4\n5. d3 b2\n6. e3 R-0',
    );
  });

  it('generates a prefix that replays cleanly', () => {
    const moves = roadWinMoves();
    expect(mustPtn(generatePtn(moves.slice(0, 3), 5))).toBe('[Size "5"]\n\n1. a1 a5\n2. a3');
  });

  it('formats stack moves and capstone placements canonically', () => {
    const moves = crushMoves();
    expect(mustPtn(generatePtn(moves, 5))).toBe('[Size "5"]\n\n1. a1 a5\n2. b1 b2\n3. Cc1 Sd1\n4. 1c1>1 e1');
  });

  it('round-trips through parsePtn', () => {
    const games = [roadWinMoves(), crushMoves()];
    for (const moves of games) {
      const generated = mustPtn(generatePtn(moves, 5, { result: 'R-0' }));
      const parsed = mustPtn(parsePtn(generated));
      expect(parsed.moves).toEqual(moves);
      expect(parsed.result).toBe('R-0');
      expect(parsed.size).toBe(5);
      // Generation is a fixed point.
      expect(mustPtn(generatePtn(parsed.moves, parsed.size, { result: parsed.result ?? undefined }))).toBe(generated);
    }
  });

  it('rejects an illegal move list rather than emitting it', () => {
    const r = generatePtn([{ type: 'place', square: sq('a1'), stone: 'standing' }], 5);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ptn-illegal-move');
      expect(r.error.ruleError?.code).toBe('opening-must-be-flat');
    }
  });

  it('derives [Size] and [Result] from the arguments, ignoring caller tags for them', () => {
    const r = mustPtn(generatePtn([], 6, {
      tags: [['Result', 'F-0'], ['Size', '5'], ['Player1', 'X']],
      result: 'R-0',
    }));
    expect(r).toBe('[Size "6"]\n[Player1 "X"]\n[Result "R-0"]\n\nR-0');
  });

  it('emits the result alone for an empty record', () => {
    expect(mustPtn(generatePtn([], 5, { result: 'R-0' }))).toBe('[Size "5"]\n[Result "R-0"]\n\nR-0');
  });
});
