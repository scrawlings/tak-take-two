import { err, ok, type Result } from 'neverthrow';

/**
 * ADR-0008: the two games lists ("Your games", "Find a game") each narrow
 * and sort through a handful of query-string filters. Before this module, "what's a
 * valid `sort`", its label, its default, and whether it counts as narrowing
 * the default view were declared separately in `app.ts`, `games.ts`, and
 * `views.ts` — restatements of the same facts, one of which (`views.ts`'s
 * narrowed-ness check) fell out of step with a new filter in ticket 06. This
 * module is the one declaration: a schema per list, and the generic
 * machinery — parse, resolve-a-partial-over-its-defaults, narrowed-ness, the
 * query string a page/stream/redirect carries — that reads it. `app.ts`
 * parses with it, `games.ts` takes the validated result as its query type,
 * `views.ts` renders labels and builds URLs from it.
 *
 * A validation failure's code is one of `FilterErrorCode` below, a subset of
 * `games.ts`'s `GameErrorCode` — a `FilterError` is structurally a `GameError`
 * (same two fields, a narrower `code` union), so `app.ts` can hand one to
 * `statusForGameError` and `games.ts`'s own error-shaped results without this
 * module importing anything from `games.ts` at all: the dependency runs one
 * way, exactly as the two-way "app.ts and games.ts and views.ts import this;
 * it imports none of them" design called for.
 */

export interface FilterOption<V extends string | number> {
  readonly value: V;
  readonly label: string;
}

/** The codes a filter can be invalid under — a subset of `games.ts`'s `GameErrorCode`, kept in sync by hand (four codes, unlikely to drift). */
export type FilterErrorCode = 'invalid-status' | 'invalid-sort' | 'invalid-board-size' | 'invalid-join-type';

export interface FilterError {
  readonly code: FilterErrorCode;
  readonly message: string;
}

/** One value from a fixed set of strings — `status`, `sort`, `direction`, `joinType`. */
export interface SelectFilter<V extends string> {
  readonly kind: 'select';
  /** The query-string / form-field name. */
  readonly param: string;
  readonly options: readonly FilterOption<V>[];
  /**
   * `null`: absent/blank resolves to `null` ("any" — `status`, `joinType`).
   * A real value: absent/blank resolves to it instead, and the filter's
   * resolved type drops `null` entirely (`sort`, `direction` — a list is
   * always sorted some way, so nothing downstream should have to ask).
   */
  readonly default: V | null;
  /** False for `sort`/`direction`: they reorder the list, they never narrow it. Defaults true. */
  readonly narrows?: boolean;
  readonly invalid: FilterError;
}

/** One value from a fixed set of numbers — `boardSize`. */
export interface NumericSelectFilter<V extends number> {
  readonly kind: 'numeric-select';
  readonly param: string;
  readonly options: readonly FilterOption<V>[];
  readonly narrows?: boolean;
  readonly invalid: FilterError;
}

/** A presence-based boolean — `showRemoved`, `curated`: a checkbox submits its value only when checked. */
export interface ToggleFilter {
  readonly kind: 'toggle';
  readonly param: string;
  readonly narrows?: boolean;
}

/** Trimmed free text — `proposerDisplayName`. A blank value means "any". */
export interface TextFilter {
  readonly kind: 'text';
  readonly param: string;
  readonly narrows?: boolean;
}

export type FilterSpec = SelectFilter<string> | NumericSelectFilter<number> | ToggleFilter | TextFilter;

export type Schema = Readonly<Record<string, FilterSpec>>;

type FilterValue<F extends FilterSpec> = F extends SelectFilter<infer V>
  ? (F['default'] extends null ? V | null : V)
  : F extends NumericSelectFilter<infer V>
    ? V | null
    : F extends ToggleFilter
      ? boolean
      : F extends TextFilter
        ? string | null
        : never;

/** A schema's resolved, validated shape — every filter present, at its own default when absent. */
export type ParsedQuery<S extends Schema> = { readonly [K in keyof S]: FilterValue<S[K]> };

/** A raw value getter: a query string, a form body, and a re-parsed `return_to` all look like this to a schema. */
export type RawGet = (param: string) => string | undefined;

/** Parse every filter in `schema` via `get`, failing on the first value that isn't one of its declared options. */
export function parseQuery<S extends Schema>(schema: S, get: RawGet): Result<ParsedQuery<S>, FilterError> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(schema)) {
    const spec = schema[key]!;
    const raw = get(spec.param);
    switch (spec.kind) {
      case 'select': {
        if (raw === undefined || raw === '') {
          result[key] = spec.default;
          break;
        }
        const match = spec.options.find((o) => o.value === raw);
        if (!match) return err({ code: spec.invalid.code, message: spec.invalid.message });
        result[key] = match.value;
        break;
      }
      case 'numeric-select': {
        if (raw === undefined || raw === '') {
          result[key] = null;
          break;
        }
        const numeric = Number(raw);
        const match = spec.options.find((o) => o.value === numeric);
        if (!match) return err({ code: spec.invalid.code, message: spec.invalid.message });
        result[key] = match.value;
        break;
      }
      case 'toggle':
        result[key] = raw !== undefined;
        break;
      case 'text': {
        const trimmed = raw?.trim();
        result[key] = trimmed ? trimmed : null;
        break;
      }
    }
  }
  return ok(result as ParsedQuery<S>);
}

/** Every filter at its own default — the view a bad or missing `return_to` silently falls back to. */
export function defaultQuery<S extends Schema>(schema: S): ParsedQuery<S> {
  return parseQuery(schema, () => undefined)._unsafeUnwrap();
}

/**
 * `partial` resolved over `schema`'s defaults: an omitted field, or one
 * explicitly set to `undefined`, falls back; anything else — including an
 * explicit `null` on a nullable filter — is kept as given. Callers (mostly
 * tests) that pass only the fields they care about get the rest filled in
 * without restating what "filled in" means.
 */
export function resolveQuery<S extends Schema>(schema: S, partial: Partial<ParsedQuery<S>>): ParsedQuery<S> {
  const result: Record<string, unknown> = { ...defaultQuery(schema) };
  for (const key of Object.keys(schema)) {
    const value = partial[key as keyof S];
    if (value !== undefined) result[key] = value;
  }
  return result as ParsedQuery<S>;
}

/**
 * Whether `parsed` deviates from the default view — the one statement of it,
 * so the "Clear" link and the empty-state message on the page and on a
 * streamed frame can never disagree. A filter opts out via `narrows: false`
 * (`sort`/`direction`: they reorder, they never narrow).
 */
export function isNarrowed<S extends Schema>(schema: S, parsed: ParsedQuery<S>): boolean {
  return Object.keys(schema).some((key) => {
    const spec = schema[key]!;
    if (spec.narrows === false) return false;
    const value = parsed[key as keyof S];
    if (spec.kind === 'toggle') return value === true;
    if (spec.kind === 'select') return value !== spec.default;
    return value !== null;
  });
}

/** `parsed` as a query string (leading `?`, or `''` when every filter is at its default/absent). */
export function queryString<S extends Schema>(schema: S, parsed: ParsedQuery<S>): string {
  const q = new URLSearchParams();
  for (const key of Object.keys(schema)) {
    const spec = schema[key]!;
    const value = parsed[key as keyof S];
    if (value === null || value === false) continue;
    if (spec.kind === 'select' && value === spec.default) continue;
    q.set(spec.param, value === true ? '1' : String(value));
  }
  const search = q.toString();
  return search === '' ? '' : `?${search}`;
}

/** Whether `raw` names `basePath` itself, or `basePath` with a query string — never a deeper path. */
export function matchesBasePath(basePath: string, raw: string | null | undefined): boolean {
  return !!raw && (raw === basePath || raw.startsWith(`${basePath}?`));
}

/**
 * Re-derives a list's query from a `return_to` URL a form carried through a
 * POST (hide/join/follow) — a POST has no query string of its own to read
 * the list's filters back from. Falls back to the default view silently when
 * `return_to` is missing, doesn't belong to this list (`basePath`), or no
 * longer parses: it is never something the user typed this request, so there
 * is nothing of theirs to hold up as wrong.
 */
export function parseReturnTo<S extends Schema>(
  schema: S,
  basePath: string,
  raw: string | null | undefined,
): ParsedQuery<S> {
  if (!matchesBasePath(basePath, raw)) return defaultQuery(schema);
  const search = raw!.slice(basePath.length).replace(/^\?/, '');
  const params = new URLSearchParams(search);
  const parsed = parseQuery(schema, (param) => params.get(param) ?? undefined);
  return parsed.isOk() ? parsed.value : defaultQuery(schema);
}

/** "Your games": status filter, sort, and the removed-tombstones toggle (tickets 03, 06). */
export const MY_GAMES_SCHEMA = {
  status: {
    kind: 'select',
    param: 'status',
    options: [
      { value: 'proposed', label: 'proposed' },
      { value: 'in_play', label: 'in play' },
      { value: 'finished', label: 'finished' },
    ],
    default: null,
    invalid: { code: 'invalid-status', message: 'Choose proposed, in play, or finished.' },
  },
  sort: {
    kind: 'select',
    param: 'sort',
    options: [
      { value: 'activity', label: 'last activity' },
      { value: 'created', label: 'creation date' },
      { value: 'size', label: 'board size' },
    ],
    default: 'activity',
    narrows: false,
    invalid: { code: 'invalid-sort', message: 'Choose activity, created, or size to sort by.' },
  },
  direction: {
    kind: 'select',
    param: 'direction',
    options: [
      { value: 'desc', label: 'descending (newest/largest first)' },
      { value: 'asc', label: 'ascending (oldest/smallest first)' },
    ],
    default: 'desc',
    narrows: false,
    invalid: { code: 'invalid-sort', message: 'Sort direction must be ascending or descending.' },
  },
  showRemoved: { kind: 'toggle', param: 'show_removed' },
} as const satisfies Schema;

export type MyGamesQuery = ParsedQuery<typeof MY_GAMES_SCHEMA>;
export const MY_GAMES_DEFAULT: MyGamesQuery = defaultQuery(MY_GAMES_SCHEMA);

/** "Find a game": board size, join type, proposer text, and the curated (followed-players) toggle (ticket 04). */
export const FIND_GAMES_SCHEMA = {
  boardSize: {
    kind: 'numeric-select',
    param: 'board_size',
    options: [
      { value: 5, label: '5×5' },
      { value: 6, label: '6×6' },
    ],
    invalid: { code: 'invalid-board-size', message: 'Board size must be 5 or 6.' },
  },
  joinType: {
    kind: 'select',
    param: 'join_type',
    options: [
      { value: 'open', label: 'open to anyone' },
      { value: 'invited', label: 'invitations to me' },
    ],
    default: null,
    invalid: { code: 'invalid-join-type', message: 'Choose an open or an invited game.' },
  },
  proposerDisplayName: { kind: 'text', param: 'proposer' },
  curated: { kind: 'toggle', param: 'curated' },
} as const satisfies Schema;

export type FindGamesSearch = ParsedQuery<typeof FIND_GAMES_SCHEMA>;
export const FIND_GAMES_DEFAULT: FindGamesSearch = defaultQuery(FIND_GAMES_SCHEMA);
