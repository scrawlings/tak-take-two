import { describe, expect, it } from 'vitest';
import type { Result } from 'neverthrow';
import { createGame, generateTps, getStack, parseTps } from '../src/index';
import type { GameState } from '../src/index';
import { move, must, place, play, sq } from './helpers';

function mustTps<T>(r: Result<T, unknown>): T {
  if (r.isErr()) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

/** P1's capstone crushes P2's standing stone on move 4 (turn 1, move 5 after). */
function crushState(): GameState {
  let g = createGame(5);
  g = play(g, place('a1', 'flat'));
  g = play(g, place('a5', 'flat'));
  g = play(g, place('b1', 'flat'));
  g = play(g, place('b2', 'flat'));
  g = play(g, place('c1', 'capstone'));
  g = play(g, place('d1', 'standing'));
  g = play(g, move('c1', '>', [1]));
  g = play(g, place('e1', 'flat'));
  return g;
}

/** P1 wins by road on move 6 (11 half-moves). */
function roadWinState(): GameState {
  let g = createGame(5);
  g = play(g, place('a1', 'flat'));
  g = play(g, place('a5', 'flat'));
  g = play(g, place('a3', 'flat'));
  g = play(g, place('a2', 'flat'));
  g = play(g, place('b3', 'flat'));
  g = play(g, place('a4', 'flat'));
  g = play(g, place('c3', 'flat'));
  g = play(g, place('b4', 'flat'));
  g = play(g, place('d3', 'flat'));
  g = play(g, place('b2', 'flat'));
  g = play(g, place('e3', 'flat'));
  return g;
}

describe('generateTps', () => {
  it('serializes an empty board', () => {
    expect(generateTps(createGame(5))).toBe('x5/x5/x5/x5/x5 1 1');
    expect(generateTps(createGame(6))).toBe('x6/x6/x6/x6/x6/x6 1 1');
  });

  it('serializes stacks bottom-to-top with S/C suffixes', () => {
    const g = crushState();
    expect(generateTps(g)).toBe('1,x4/x5/x5/x,2,x3/2,1,x,21C,2 1 5');
  });

  it('serializes a finished game position', () => {
    const g = roadWinState();
    expect(g.outcome).toEqual({ type: 'road', winner: 1 });
    expect(generateTps(g)).toBe('1,x4/2,2,x3/1,1,1,1,1/2,2,x3/2,x4 2 6');
  });
});

describe('parseTps', () => {
  it('parses an empty board back to a fresh game', () => {
    expect(mustTps(parseTps('x5/x5/x5/x5/x5 1 1'))).toEqual(createGame(5));
    expect(mustTps(parseTps('x6/x6/x6/x6/x6/x6 1 1'))).toEqual(createGame(6));
  });

  it('parses the USTak full example', () => {
    const tps = 'x3,12,2S/x,22S,22C,11,21/121,212,12,1121C,1212S/21S,1,21,211S,12S/x,21S,2,x2 1 26';
    const g = mustTps(parseTps(tps));
    expect(g.size).toBe(5);
    expect(g.playerToMove).toBe(1);
    expect(g.moveNumber).toBe(26);
    expect(g.outcome).toBeNull();

    // Spot-check stacks: d5 = 12, c4 = 22C (S/C modifies the top stone, not a stone itself), e3 = 1212S
    expect(must(getStack(g, sq('d5')))).toEqual([
      { player: 1, kind: 'flat' },
      { player: 2, kind: 'flat' },
    ]);
    expect(must(getStack(g, sq('c4')))).toEqual([
      { player: 2, kind: 'flat' },
      { player: 2, kind: 'capstone' },
    ]);
    expect(must(getStack(g, sq('e3')))).toEqual([
      { player: 1, kind: 'flat' },
      { player: 2, kind: 'flat' },
      { player: 1, kind: 'flat' },
      { player: 2, kind: 'standing' },
    ]);

    // 19 stones + one capstone each: reserves are 2 stones and no capstones.
    expect(g.reserves).toEqual({
      1: { stones: 2, capstones: 0 },
      2: { stones: 2, capstones: 0 },
    });
  });

  it('round-trips a played position exactly', () => {
    const g = crushState();
    const parsed = mustTps(parseTps(generateTps(g)));
    expect(parsed).toEqual(g);
  });

  it('regenerates the canonical spec example', () => {
    const tps = 'x3,12,2S/x,22S,22C,11,21/121,212,12,1121C,1212S/21S,1,21,211S,12S/x,21S,2,x2 1 26';
    expect(generateTps(mustTps(parseTps(tps)))).toBe(tps);
  });

  it('tolerates surrounding whitespace', () => {
    expect(mustTps(parseTps('  x5/x5/x5/x5/x5   1   1  '))).toEqual(createGame(5));
  });

  it('rejects the wrong number of fields', () => {
    for (const tps of ['x5/x5/x5/x5/x5 1', 'x5/x5/x5/x5/x5 1 1 1', '', '   ']) {
      const r = parseTps(tps);
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.code).toBe('tps-field-count');
    }
  });

  it('rejects a bad turn', () => {
    for (const turn of ['3', '0', 'x']) {
      const r = parseTps(`x5/x5/x5/x5/x5 ${turn} 1`);
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.code).toBe('tps-bad-turn');
    }
  });

  it('rejects a bad move counter', () => {
    for (const move of ['0', '-1', '1.5', 'x', '01']) {
      const r = parseTps(`x5/x5/x5/x5/x5 1 ${move}`);
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.code).toBe('tps-bad-move-count');
    }
  });

  it('rejects boards that are not 5x5 or 6x6', () => {
    const four = parseTps('x5/x5/x5/x5 1 1');
    expect(four.isErr()).toBe(true);
    if (four.isErr()) expect(four.error.code).toBe('tps-bad-row-count');

    const seven = parseTps('x7/x7/x7/x7/x7/x7/x7 1 1');
    expect(seven.isErr()).toBe(true);
    if (seven.isErr()) expect(seven.error.code).toBe('tps-bad-row-count');
  });

  it('rejects rows of the wrong width', () => {
    for (const tps of [
      'x4/x5/x5/x5/x5 1 1',
      'x6/x5/x5/x5/x5 1 1',
      'x5/x5/x5/x5/x6 1 1',
      '1,x5/x5/x5/x5/x5 1 1', // 6 cells in a row of a 5x5
    ]) {
      const r = parseTps(tps);
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.code).toBe('tps-bad-row-width');
    }
  });

  it('rejects malformed cells', () => {
    const rows = [
      '3,x4', // player 3
      '0,x4', // zero
      'S1,x4', // stone letter before the owner
      '1S2,x3', // standing not on top
      '12S2,x2', // standing not on top
      '1s,x4', // lowercase suffix
      'x0,x4', // zero-length run
      '1C1,x3', // capstone not on top
      '1,,x3', // empty cell
    ];
    for (const row of rows) {
      const tps = `x5/x5/x5/x5/${row} 1 1`;
      const r = parseTps(tps);
      expect(r.isErr(), tps).toBe(true);
      if (r.isErr()) expect(r.error.code, tps).toBe('tps-bad-cell');
    }
  });

  it('rejects more than one capstone per player', () => {
    const r = parseTps('1C,1C,x3/x5/x5/x5/x5 1 2');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('tps-too-many-capstones');
  });

  it('rejects stone counts beyond the reserve', () => {
    const five = parseTps('1,1,1,1,1/1,1,1,1,1/1,1,1,1,1/1,1,1,1,1/1,1,x3 1 22');
    expect(five.isErr()).toBe(true);
    if (five.isErr()) expect(five.error.code).toBe('tps-stones-beyond-reserve');

    // 31 player-1 stones on a 6x6 (reserve is 30).
    const six = parseTps('1,1,1,1,1,1/1,1,1,1,1,1/1,1,1,1,1,1/1,1,1,1,1,1/1,1,1,1,1,1/1,x5 1 17');
    expect(six.isErr()).toBe(true);
    if (six.isErr()) expect(six.error.code).toBe('tps-stones-beyond-reserve');
  });

  it('rejects stone counts the move counter cannot account for', () => {
    // Counter 1, turn 1: no moves played, so the board must be empty.
    const tooMany = parseTps('x5/x5/x5/x5/1,x4 1 1');
    expect(tooMany.isErr()).toBe(true);
    if (tooMany.isErr()) expect(tooMany.error.code).toBe('tps-too-many-stones');

    // Counter 1, turn 2: exactly one move (the opening) has been played, which
    // must have placed a stone — an empty board is impossible here.
    const tooFew = parseTps('x5/x5/x5/x5/x5 2 1');
    expect(tooFew.isErr()).toBe(true);
    if (tooFew.isErr()) expect(tooFew.error.code).toBe('tps-too-few-stones');
  });

  it('accepts a mid-game position with stack moves (stones < moves played)', () => {
    // 2 stones, counter 5, turn 1 -> 8 moves played: the 6 stack moves added no stones.
    const g = mustTps(parseTps('x5/x5/x5/x5/2,1,x3 1 5'));
    expect(g.playerToMove).toBe(1);
    expect(g.moveNumber).toBe(5);
    expect(must(getStack(g, sq('a1')))).toEqual([{ player: 2, kind: 'flat' }]);
    expect(must(getStack(g, sq('b1')))).toEqual([{ player: 1, kind: 'flat' }]);
  });
});
