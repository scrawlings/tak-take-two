import { describe, it, expect } from 'vitest';
import {
  FIND_GAMES_SCHEMA,
  MY_GAMES_SCHEMA,
  defaultQuery,
  isNarrowed,
  matchesBasePath,
  parseQuery,
  parseReturnTo,
  queryString,
  resolveQuery,
  type FilterErrorCode,
  type RawGet,
} from '../src/list-query.js';
import type { GameErrorCode } from '../src/game-views.js';

/**
 * The subset invariant (ADR-0013): every code a filter can fail under must
 * remain a game error code, because `app.ts` hands a `FilterError` straight to
 * `statusForGameError`. `game-views.ts` composes `FilterErrorCode` into
 * `GameErrorCode` by construction, so this can only break if someone
 * re-decouples the modules — and when it does, this type fails to compile.
 */
type _FilterCodesAreGameCodes = FilterErrorCode extends GameErrorCode ? true : never;
// The type above is the guard — a filter code that stops being a game code
// turns it into `never`, which fails this compile-time assignment.
void (null as unknown as _FilterCodesAreGameCodes);

/** A `RawGet` from a plain object, the shape both a query string and a form body reduce to in the tests below. */
function get(values: Record<string, string | undefined>): RawGet {
  return (param) => values[param];
}

describe('parseQuery', () => {
  it('resolves every filter to its absent state when nothing was submitted', () => {
    const parsed = parseQuery(MY_GAMES_SCHEMA, get({}))._unsafeUnwrap();
    expect(parsed).toEqual({ status: null, sort: 'activity', direction: 'desc', showRemoved: false });
  });

  it('parses a valid select value', () => {
    const parsed = parseQuery(MY_GAMES_SCHEMA, get({ status: 'finished' }))._unsafeUnwrap();
    expect(parsed.status).toBe('finished');
  });

  it('treats a blank select value the same as absent', () => {
    const parsed = parseQuery(MY_GAMES_SCHEMA, get({ status: '' }))._unsafeUnwrap();
    expect(parsed.status).toBeNull();
  });

  it('refuses a select value outside the declared options', () => {
    const result = parseQuery(MY_GAMES_SCHEMA, get({ status: 'archived' }));
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'invalid-status',
      message: 'Choose proposed, in play, or finished.',
    });
  });

  it('refuses an unrecognised sort and a bad direction under the same code, each with its own message', () => {
    expect(parseQuery(MY_GAMES_SCHEMA, get({ sort: 'popularity' }))._unsafeUnwrapErr()).toEqual({
      code: 'invalid-sort',
      message: 'Choose activity, created, or size to sort by.',
    });
    expect(parseQuery(MY_GAMES_SCHEMA, get({ direction: 'sideways' }))._unsafeUnwrapErr()).toEqual({
      code: 'invalid-sort',
      message: 'Sort direction must be ascending or descending.',
    });
  });

  it('reads a toggle as on only when the param is present, blank or not', () => {
    expect(parseQuery(MY_GAMES_SCHEMA, get({}))._unsafeUnwrap().showRemoved).toBe(false);
    expect(parseQuery(MY_GAMES_SCHEMA, get({ show_removed: '1' }))._unsafeUnwrap().showRemoved).toBe(true);
    expect(parseQuery(MY_GAMES_SCHEMA, get({ show_removed: '' }))._unsafeUnwrap().showRemoved).toBe(true);
  });

  it('parses a numeric-select value and refuses one outside the declared options', () => {
    expect(parseQuery(FIND_GAMES_SCHEMA, get({ board_size: '6' }))._unsafeUnwrap().boardSize).toBe(6);
    expect(parseQuery(FIND_GAMES_SCHEMA, get({ board_size: '7' }))._unsafeUnwrapErr()).toEqual({
      code: 'invalid-board-size',
      message: 'Board size must be 5 or 6.',
    });
  });

  it('trims free text and treats blank (or whitespace-only) as absent', () => {
    expect(parseQuery(FIND_GAMES_SCHEMA, get({ proposer: '  Nolan  ' }))._unsafeUnwrap().proposerDisplayName).toBe(
      'Nolan',
    );
    expect(parseQuery(FIND_GAMES_SCHEMA, get({ proposer: '   ' }))._unsafeUnwrap().proposerDisplayName).toBeNull();
    expect(parseQuery(FIND_GAMES_SCHEMA, get({}))._unsafeUnwrap().proposerDisplayName).toBeNull();
  });
});

describe('isNarrowed', () => {
  it('is false for the default view', () => {
    expect(isNarrowed(MY_GAMES_SCHEMA, defaultQuery(MY_GAMES_SCHEMA))).toBe(false);
  });

  it('is true once a narrowing filter is set', () => {
    expect(isNarrowed(MY_GAMES_SCHEMA, parseQuery(MY_GAMES_SCHEMA, get({ status: 'finished' }))._unsafeUnwrap())).toBe(
      true,
    );
    expect(
      isNarrowed(MY_GAMES_SCHEMA, parseQuery(MY_GAMES_SCHEMA, get({ show_removed: '1' }))._unsafeUnwrap()),
    ).toBe(true);
  });

  it('stays false for sort and direction alone — they reorder, they never narrow', () => {
    const reordered = parseQuery(MY_GAMES_SCHEMA, get({ sort: 'size', direction: 'asc' }))._unsafeUnwrap();
    expect(isNarrowed(MY_GAMES_SCHEMA, reordered)).toBe(false);
  });

  it('is true once curated is on, with no other find filter set', () => {
    const curated = parseQuery(FIND_GAMES_SCHEMA, get({ curated: '1' }))._unsafeUnwrap();
    expect(isNarrowed(FIND_GAMES_SCHEMA, curated)).toBe(true);
  });
});

describe('queryString', () => {
  it('is empty for the default view', () => {
    expect(queryString(MY_GAMES_SCHEMA, defaultQuery(MY_GAMES_SCHEMA))).toBe('');
  });

  it('carries only the filters that were set, under their query-string names', () => {
    const parsed = parseQuery(MY_GAMES_SCHEMA, get({ status: 'proposed', sort: 'created' }))._unsafeUnwrap();
    expect(queryString(MY_GAMES_SCHEMA, parsed)).toBe('?status=proposed&sort=created');
  });

  it('emits a toggle as `1`', () => {
    const parsed = parseQuery(MY_GAMES_SCHEMA, get({ show_removed: '1' }))._unsafeUnwrap();
    expect(queryString(MY_GAMES_SCHEMA, parsed)).toBe('?show_removed=1');
  });

  it('round-trips through parseQuery', () => {
    const parsed = parseQuery(FIND_GAMES_SCHEMA, get({ board_size: '6', join_type: 'open', proposer: 'Nolan', curated: '1' }))
      ._unsafeUnwrap();
    const search = queryString(FIND_GAMES_SCHEMA, parsed);
    const reparsed = parseQuery(FIND_GAMES_SCHEMA, get(Object.fromEntries(new URLSearchParams(search))))._unsafeUnwrap();
    expect(reparsed).toEqual(parsed);
  });
});

describe('parseReturnTo', () => {
  it('re-parses a same-list return_to', () => {
    const parsed = parseReturnTo(MY_GAMES_SCHEMA, '/games', '/games?status=finished&show_removed=1');
    expect(parsed).toEqual({ status: 'finished', sort: 'activity', direction: 'desc', showRemoved: true });
  });

  it('falls back to the default view when return_to is missing', () => {
    expect(parseReturnTo(MY_GAMES_SCHEMA, '/games', undefined)).toEqual(defaultQuery(MY_GAMES_SCHEMA));
    expect(parseReturnTo(MY_GAMES_SCHEMA, '/games', null)).toEqual(defaultQuery(MY_GAMES_SCHEMA));
  });

  it('falls back when return_to belongs to a different list', () => {
    expect(parseReturnTo(MY_GAMES_SCHEMA, '/games', '/games/find?curated=1')).toEqual(defaultQuery(MY_GAMES_SCHEMA));
    expect(parseReturnTo(MY_GAMES_SCHEMA, '/games', '/games/42')).toEqual(defaultQuery(MY_GAMES_SCHEMA));
  });

  it('falls back silently when return_to no longer parses, rather than erroring', () => {
    expect(parseReturnTo(MY_GAMES_SCHEMA, '/games', '/games?status=archived')).toEqual(defaultQuery(MY_GAMES_SCHEMA));
  });

  it('matches the bare base path with no query string', () => {
    expect(parseReturnTo(MY_GAMES_SCHEMA, '/games', '/games')).toEqual(defaultQuery(MY_GAMES_SCHEMA));
  });
});

describe('matchesBasePath', () => {
  it('matches the bare base path, and the base path with a query string', () => {
    expect(matchesBasePath('/games', '/games')).toBe(true);
    expect(matchesBasePath('/games', '/games?status=finished')).toBe(true);
  });

  it('does not match a deeper path, a different list, or a missing value', () => {
    expect(matchesBasePath('/games', '/games/42')).toBe(false);
    expect(matchesBasePath('/games', '/games/find?curated=1')).toBe(false);
    expect(matchesBasePath('/games', undefined)).toBe(false);
    expect(matchesBasePath('/games', null)).toBe(false);
  });
});

describe('resolveQuery', () => {
  it('fills in every field a partial value omits', () => {
    const resolved = resolveQuery(MY_GAMES_SCHEMA, { status: 'finished' });
    expect(resolved).toEqual({ status: 'finished', sort: 'activity', direction: 'desc', showRemoved: false });
  });

  it('treats a field explicitly set to undefined the same as an omitted one', () => {
    const resolved = resolveQuery(MY_GAMES_SCHEMA, { status: 'finished', sort: undefined });
    expect(resolved.sort).toBe('activity');
  });

  it('keeps an explicit null on a nullable filter, rather than falling back', () => {
    const resolved = resolveQuery(FIND_GAMES_SCHEMA, { boardSize: null, curated: true });
    expect(resolved).toEqual({ boardSize: null, joinType: null, proposerDisplayName: null, curated: true });
  });

  it('returns the schema default outright when nothing is given', () => {
    expect(resolveQuery(MY_GAMES_SCHEMA, {})).toEqual(defaultQuery(MY_GAMES_SCHEMA));
  });
});
