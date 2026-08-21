import { breadcrumb, escapeHtml, region, renderShell, streamed, type Regions } from './html.js';
import type { SessionUser } from './auth.js';
import type { ExportFormat, GameExport, GameView } from './games.js';
import { gamePath } from './paths.js';
import {
  BOARD_CLASS,
  CAN_MOVE_ATTR,
  COMPONENTS,
  FLAG_OFF,
  FLAG_ON,
  HEIGHT_ATTR,
  METHODS,
  MOVE_LINK_CLASS,
  MOVE_MODEL,
  MOVE_NUMBER_ATTR,
  SELF_PLAY_ATTR,
  SQUARE_ATTR,
  STACK_ATTR,
  stoneGlyph,
  TOP_ATTR,
  TOTAL_ATTR,
  TOTAL_MOVES_ATTR,
  TPS_ATTR,
  VIEWER_SEAT_ATTR,
  type BoardConfig,
} from './contract.js';

/**
 * The game screen (CONTEXT.md: the board, its controls, review mode) and the
 * export page it links to. Every rule these render is already decided in
 * `game-views.ts` (ADR-0011); nothing here reads a game, authorises anything,
 * or re-derives a rule — a render function is `GameView -> string`, which is
 * what lets `game-screen.test.ts` call one with a hand-built view.
 */

/** A page for a game the viewer cannot see or that no longer exists. */
export function renderNotFoundPage(): string {
  return `<div class="narrow">
  <h1>Not found</h1>
  <p class="lede">There is no game here — it may have been deleted, or it is not shared with you.</p>
  <p class="actions"><a class="btn btn-quiet" href="/games">Your games</a></p>
</div>`;
}

/** The colour dot for a seat. The stone glyphs themselves are one table for
 *  server and bundle, in `contract.ts` (ADR-0013). */
function playerColor(seat: 1 | 2): string {
  return seat === 1 ? '●' : '○';
}

/** The word for a seat's stones — seat 1 plays filled, seat 2 open. */
function seatColourWord(seat: 1 | 2): string {
  return seat === 1 ? 'filled' : 'open';
}

export interface GameViewPageView {
  error?: string;
}

function renderBoard(game: GameView): string {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, game.boardSize);
  const top = `<span class="axis"></span>${files.map((f) => `<span class="axis">${f}</span>`).join('')}`;
  const rows: string[] = [];
  for (const row of game.board) {
    const rank = row[0]!.rank;
    const cells = row
      .map((cell) => {
        const topStone = cell.stack.length === 0 ? null : cell.stack[cell.stack.length - 1]!;
        const glyph = topStone === null ? '·' : stoneGlyph(topStone.player, topStone.kind);
        const topAttr = topStone === null ? '' : `${topStone.player}|${topStone.kind}`;
        // Bottom to top, so the adapter can read off the top `lift` glyphs as
        // the hand a stack move carries, in the order it drops them.
        const stackAttr = cell.stack.map((s) => stoneGlyph(s.player, s.kind)).join('');
        const height = cell.stack.length > 1 ? `<span class="cell-height">${cell.stack.length}</span>` : '';
        const square = `${cell.file}${cell.rank}`;
        // What this square receives if the move is played: the builder's own
        // count, so the board shows the distribution rather than just the path.
        const drops = `<span class="cell-drops" x-show="${METHODS.dropsOn}('${square}') > 0" x-cloak x-text="${METHODS.dropsOn}('${square}')"></span>`;
        const stackTip =
          cell.stack.length === 0
            ? ''
            : `<span class="stack-tip">${[...cell.stack]
                .reverse()
                .map((s) => `<span>${stoneGlyph(s.player, s.kind)}</span>`)
                .join('')}</span>`;
        // Two overlaid spans per concern, one live and one reviewed, so a
        // stream swap (which always re-renders this whole cell, ADR-0007)
        // needs nothing beyond the same `x-show="reviewing"` toggle to keep
        // showing the reviewed position: Alpine re-binds the fresh nodes
        // against the surviving review state on every swap.
        const content = `<span x-show="!reviewing">${glyph}${height}</span><span x-show="reviewing" x-cloak x-html="${METHODS.reviewCell}('${square}')"></span>`;
        const tip = `<span x-show="!reviewing">${stackTip}</span><span x-show="reviewing" x-cloak x-html="${METHODS.reviewStackTip}('${square}')"></span>`;
        return `<button type="button" class="cell" ${SQUARE_ATTR}="${square}" ${HEIGHT_ATTR}="${cell.stack.length}" ${TOP_ATTR}="${topAttr}" ${STACK_ATTR}="${stackAttr}" x-on:click="${METHODS.cellClick}($el)" :class="{ 'is-source': ${METHODS.isSource}('${square}'), 'is-path': ${METHODS.dropsOn}('${square}') > 0 }" aria-label="${square}">${content}${drops}${tip}</button>`;
      })
      .join('');
    rows.push(`<span class="axis">${rank}</span>${cells}`);
  }
  // What the viewer may do with this board, for the adapter to read on every
  // click. It belongs here, inside the streamed region, because it changes as
  // the game does: a move passes the turn, and a joiner settles a random start.
  // Held in the `x-data` config instead, it would freeze at page load and a
  // streamed update would leave a live move form above an inert board.
  const standing = [
    `${CAN_MOVE_ATTR}="${game.canMove ? FLAG_ON : FLAG_OFF}"`,
    `${VIEWER_SEAT_ATTR}="${game.viewerSeat ?? ''}"`,
    `${SELF_PLAY_ATTR}="${game.selfPlay ? FLAG_ON : FLAG_OFF}"`,
  ].join(' ');
  return `<div class="${BOARD_CLASS}" ${standing} style="grid-template-columns: auto repeat(${game.boardSize}, 2.75rem)">${top}${rows.join('')}</div>`;
}

function renderGameStatus(game: GameView): string {
  if (game.adminRemoved) {
    return `<p class="notice">This game was removed by an admin.</p>`;
  }
  if (game.state === 'proposed') {
    // Who starts is the proposer's choice, and until a random start is resolved
    // at join the seat is only a promise — say so rather than guess.
    const starter =
      game.proposerSeat === null
        ? 'A coin flip will decide who starts.'
        : game.proposerSeat === 1
          ? `${escapeHtml(game.proposer.displayName)} will start.`
          : `${game.opponent === null ? 'The joiner' : escapeHtml(game.opponent.displayName)} will start.`;
    return `<p class="lede">Proposed by ${escapeHtml(game.proposer.displayName)}${game.imported ? ', starting from an imported record' : ''}. Waiting for an opponent. ${starter}</p>`;
  }
  if (game.state === 'finished') {
    return `<p class="lede">${escapeHtml(game.resultText ?? 'Finished')}.</p>`;
  }

  if (game.selfPlay) {
    // One account holds both seats (CONTEXT.md: Self-play), so the only
    // meaningful "who" is the colour whose turn it is.
    const youPlay = game.viewerSeat !== null ? 'You play both colours. ' : '';
    const seat = game.toMoveSeat;
    if (seat === null) {
      return `<p class="lede">Self-play — ${escapeHtml(game.proposer.displayName)}. ${youPlay}</p>`;
    }
    const colour = seat === 1 ? 'Filled' : 'Open';
    const turn =
      game.isOpeningTurn && game.stoneSeat !== null
        ? `${colour}'s opening places an ${seatColourWord(game.stoneSeat)} stone.`
        : `${colour} to move.`;
    return `<p class="lede">Self-play — ${escapeHtml(game.proposer.displayName)}. ${youPlay}${turn}</p>`;
  }

  const youPlay =
    game.viewerSeat === null
      ? ''
      : `You play ${playerColor(game.viewerSeat)} (${seatColourWord(game.viewerSeat)}). `;
  let turn: string;
  if (game.canMove && game.isOpeningTurn && game.stoneSeat !== null) {
    turn = `Your turn — your opening move places your opponent's stone (${seatColourWord(game.stoneSeat)}).`;
  } else if (game.canMove) {
    turn = 'Your turn.';
  } else {
    turn = `${game.toMove ? escapeHtml(game.toMove.displayName) : '—'} to move.`;
  }
  return `<p class="lede">${escapeHtml(game.proposer.displayName)} vs ${escapeHtml(game.opponent?.displayName ?? '—')}. ${youPlay}${turn}</p>`;
}

/**
 * The sticky bar review mode replaces the move form with (ticket 01): which
 * move is showing, a snap-to-end button, and — when the live position is
 * waiting on the viewer while they are scrubbed away — a plain statement of
 * that, so review can never quietly hide that the game needs them. `canMove`
 * is server-decided and this region re-renders on every game change (ADR-0007
 * always replaces `controls`), so the phrase is always current; only its
 * visibility is client state.
 */
function renderReviewBar(game: GameView): string {
  const waiting = game.canMove ? `<p class="review-waiting">Your turn — they’re waiting on you.</p>` : '';
  return `<div class="review-bar panel" x-show="reviewing" x-cloak>
  <p>Viewing move <span x-text="reviewAt"></span> of ${game.moves.length}.</p>
  <p class="review-pulse" ${TOTAL_MOVES_ATTR}="${game.moves.length}" x-show="${METHODS.newMoveWhileReviewing}($el)" x-cloak>New move.</p>
  ${waiting}
  <p class="actions"><button type="button" class="btn btn-sm" x-on:click="${METHODS.snapToEnd}()">Snap to end</button></p>
</div>`;
}

function renderGameControls(game: GameView): string {
  const reviewBar = renderReviewBar(game);
  if (game.state === 'finished') return reviewBar;
  const parts: string[] = [reviewBar];

  if (game.pending !== null) {
    // The single pending request/offer: the respondent may accept or reject;
    // the requester waits. Either way, no move form while pending.
    const requester = escapeHtml(game.pending.requester.displayName);
    if (game.canRespond) {
      const text =
        game.pending.kind === 'draw'
          ? `${requester} offers a draw.`
          : `${requester} requests a take-back of their last move.`;
      const kind = game.pending.kind === 'draw' ? 'draw' : 'take-back';
      parts.push(`
<div class="notice">
  <p>${text}</p>
  <p class="actions">
    <form method="post" action="${gamePath(game.id, `${kind}/accept`)}"><button type="submit" class="btn btn-sm">Accept</button></form>
    <form method="post" action="${gamePath(game.id, `${kind}/reject`)}"><button type="submit" class="btn btn-quiet btn-sm">Reject</button></form>
  </p>
</div>`);
    } else {
      const waiting =
        game.pending.kind === 'draw'
          ? 'Draw offered — waiting for a response.'
          : 'Take-back requested — waiting for a response.';
      parts.push(`<p class="notice">${waiting}</p>`);
    }
  } else if (game.canMove && game.stoneSeat !== null) {
    // The picker shows the glyph of the stone about to be placed, which on an
    // opening turn is the opponent's — `game-views.ts` decides that, this reads it.
    const placing = game.stoneSeat;
    const stoneButtons = (['flat', 'standing', 'capstone'] as const)
      .map(
        (kind) => `<button type="button" class="stone-btn" x-on:click="${METHODS.pick}('${kind}')" :class="{ 'is-selected': stone === '${kind}' }" :aria-pressed="stone === '${kind}'" aria-label="Place a ${kind} stone"><span class="stone-glyph">${stoneGlyph(placing, kind)}</span><span class="stone-btn-name">${kind}</span></button>`,
      )
      .join('');
    parts.push(`
<form class="panel" method="post" action="${gamePath(game.id, 'move')}" x-show="!reviewing" x-cloak>
  <div class="field">
    <label for="move">Your move</label>
    <input id="move" name="move" x-model="${MOVE_MODEL}" placeholder="a1, Sa1, or 5b4&gt;212" autocomplete="off" spellcheck="false">
    <p class="hint">Type Portable Tak Notation, or build it by clicking the board above.</p>
  </div>
  <div class="field">
    <span class="label" id="stone-label">Stone to place</span>
    <div class="stone-picker" role="group" aria-labelledby="stone-label">
      ${stoneButtons}
    </div>
  </div>
  <div class="field" x-show="source !== null" x-cloak>
    <span class="label" id="lift-label">Stones to lift</span>
    <div class="stepper" role="group" aria-labelledby="lift-label">
      <button type="button" class="step-btn" x-on:click="${METHODS.bumpLift}(-1)" :disabled="lift <= liftFloor" aria-label="Lift one stone fewer">−</button>
      <span class="stepper-value" x-text="lift + ' of ' + (source ? source.height : 0)"></span>
      <button type="button" class="step-btn" x-on:click="${METHODS.bumpLift}(1)" :disabled="lift >= liftCeiling" aria-label="Lift one stone more">+</button>
      <button type="button" class="btn btn-quiet btn-sm" x-on:click="${METHODS.cancel}()">Cancel</button>
    </div>
    <p class="hint">Holding <span x-text="lift"></span> from <span class="mono" x-text="sourceSquare"></span> — click a square in a straight line, or the source again to put them back.</p>
    <p class="stack-partition mono" aria-hidden="true" x-text="partition"></p>
  </div>
  <div class="field" x-show="path.length > 0" x-cloak>
    <span class="label" id="drops-label">Stones dropped</span>
    <div class="drop-row" role="group" aria-labelledby="drops-label">
      <template x-for="(step, i) in path" :key="step.square">
        <span class="drop-step">
          <span class="mono drop-square" x-text="step.square"></span>
          <button type="button" class="step-btn" x-on:click="${METHODS.shiftDrop}(i, -1)" :disabled="!${METHODS.canShiftDrop}(i, -1)" :aria-label="'Move a stone from ' + step.square + ' to the square before it'">◀</button>
          <span class="drop-count" x-text="step.drops"></span>
          <button type="button" class="step-btn" x-on:click="${METHODS.shiftDrop}(i, 1)" :disabled="!${METHODS.canShiftDrop}(i, 1)" :aria-label="'Move a stone from ' + step.square + ' to the square after it'">▶</button>
        </span>
      </template>
    </div>
    <p class="hint">The arrows shift one stone to the neighbouring square, so raise a square by pushing a stone into it from the one beside it. Every square crossed keeps at least one stone, and the counts always add up to the lift.</p>
  </div>
  <p class="actions"><button type="submit" class="btn">Play move</button></p>
</form>`);
  }

  if (game.canOfferTakeBack || game.canOfferDraw || game.canResign) {
    parts.push(`
<div class="actions">
  ${game.canOfferTakeBack ? `<form method="post" action="${gamePath(game.id, 'take-back')}"><button type="submit" class="btn btn-quiet">Request take-back</button></form>` : ''}
  ${game.canOfferDraw ? `<form method="post" action="${gamePath(game.id, 'draw')}"><button type="submit" class="btn btn-quiet">Offer draw</button></form>` : ''}
  ${game.canResign ? `<form method="post" action="${gamePath(game.id, 'resign')}"><button type="submit" class="btn btn-quiet">Resign</button></form>` : ''}
</div>`);
  }
  return parts.join('');
}

/**
 * The pair of export links offered at one point in the game (ticket 15): the
 * PTN through that move, and the TPS of the position after it. `through`
 * numbers the full history, so move 0 is the starting position.
 */
function exportLinks(gameId: number, through: number | null): string {
  // `&amp;` because this is an HTML attribute, not a bare URL; the browser
  // hands the server back a plain `&`.
  const query = (format: string): string =>
    `${gamePath(gameId, 'export')}?format=${format}${through === null ? '' : `&amp;through=${through}`}`;
  const at = through === null ? 'the whole game' : `move ${through}`;
  // Every export is recorded in the activity trail, so keep crawlers from
  // walking two links per move and filling it with exports nobody asked for.
  const link = (format: string, title: string): string =>
    `<a class="export-link" rel="nofollow" href="${query(format)}" title="${title}">${format.toUpperCase()}</a>`;
  return (
    link('ptn', `Copy the PTN through ${at}`) +
    link('tps', `Copy the TPS of the position after ${at}`)
  );
}

function renderHistory(game: GameView): string {
  const whole = `<p class="hint">Copy the record: ${exportLinks(game.id, null)} for the whole game, or from any move below.</p>`;
  if (game.moves.length === 0) {
    // Even with no moves there is a position to copy — the empty board.
    return `<div class="block"><h2>Moves</h2><p class="lede">No moves yet.</p>${whole}</div>`;
  }
  const total = game.moves.length;
  const lines: string[] = [];
  for (let i = 0; i < game.moves.length; i += 2) {
    const turn = i / 2 + 1;
    // Clicking a move scrubs to the position right after it (ticket 01): the
    // element carries its own TPS and move number, the same self-contained
    // idiom the board cells use, so the adapter needs nothing beyond the
    // click target.
    const cell = (m: GameView['moves'][number]): string =>
      `<button type="button" class="${MOVE_LINK_CLASS} mono" ${MOVE_NUMBER_ATTR}="${m.number}" ${TPS_ATTR}="${escapeHtml(m.tps)}" ${TOTAL_ATTR}="${total}" x-on:click="${METHODS.scrubTo}($el)" :class="{ 'is-reviewed': reviewAt === ${m.number} }">${escapeHtml(m.notation)}</button> <span class="dim">${escapeHtml(m.player.displayName)}</span> ${exportLinks(game.id, m.number)}`;
    const second = game.moves[i + 1];
    lines.push(`<li><span class="mono">${turn}.</span> ${cell(game.moves[i]!)}${second ? ` ${cell(second)}` : ''}</li>`);
  }
  const imported = game.moves.some((m) => m.imported);
  const note = imported ? '<p class="hint">Imported moves are fixed history.</p>' : '';
  return `<div class="block"><h2>Moves</h2><ol class="moves">${lines.join('')}</ol>${note}${whole}</div>`;
}

function renderLegend(): string {
  return `<p class="hint">● flat (filled) · ○ flat (open) · ▲ wall · ■ capstone — hover a square to read its stack. Press <kbd>?</kbd> for keyboard shortcuts.</p>`;
}

/**
 * The one-line shortcuts help panel (ticket 02): server-rendered, toggled by
 * `helpVisible` on `takBoard` — the same "island" pattern as the review bar,
 * so there is no client-only copy of this text to keep in step.
 */
function renderShortcutsHelp(): string {
  return `<p class="shortcuts-help panel" x-show="helpVisible" x-cloak>
  <kbd>Enter</kbd> play the move · <kbd>[</kbd> <kbd>]</kbd> step the history · <kbd>u</kbd> request a take-back · <kbd>Esc</kbd> cancel / snap to live · <kbd>?</kbd> toggle this help
  <button type="button" class="btn btn-quiet btn-sm" x-on:click="${METHODS.toggleHelp}()">Close</button>
</p>`;
}

/** A reserve count: the live figure, or the reviewed one while scrubbed — see `renderBoard`'s cells. */
function reserveCount(seat: 1 | 2, kind: 'stones' | 'capstones', live: number): string {
  return `<span x-show="!reviewing">${live}</span><span x-show="reviewing" x-cloak x-text="${METHODS.reviewReserve}(${seat}, '${kind}')"></span>`;
}

function renderReserves(game: GameView): string {
  if (game.state === 'proposed') return '';
  const you = game.viewerSeat;
  const label = (seat: 1 | 2, name: string): string =>
    `${escapeHtml(name)}${game.selfPlay || you === seat ? ' (you)' : ''}`;
  const p1 = game.reserves[1];
  const p2 = game.reserves[2];
  return `<div class="block">
  <h2>Stones left</h2>
  <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Player</th><th>Colour</th><th>Flats</th><th>Capstones</th></tr></thead>
      <tbody>
        <tr><td>${label(1, game.proposer.displayName)}</td><td>● filled</td><td class="num">●▲ ${reserveCount(1, 'stones', p1.stones)}</td><td class="num">■ ${reserveCount(1, 'capstones', p1.capstones)}</td></tr>
        <tr><td>${label(2, game.opponent?.displayName ?? 'Opponent')}</td><td>○ open</td><td class="num">○△ ${reserveCount(2, 'stones', p2.stones)}</td><td class="num">□ ${reserveCount(2, 'capstones', p2.capstones)}</td></tr>
      </tbody>
    </table>
  </div>
</div>`;
}

function renderMoveSyntax(): string {
  return `<div class="block">
  <h2>Move syntax</h2>
  <ul class="moves">
    <li><span class="mono">a1</span> — place a flat stone on a1</li>
    <li><span class="mono">Sa1</span> — place a standing stone (wall)</li>
    <li><span class="mono">Ca1</span> — place a capstone</li>
    <li><span class="mono">5b4&gt;212</span> — lift 5 from b4, move right, drop 2, 1, 2</li>
    <li>Directions: <span class="mono">&lt;</span> left · <span class="mono">&gt;</span> right · <span class="mono">+</span> up · <span class="mono">-</span> down</li>
  </ul>
</div>`;
}

/**
 * Ticket 13: the viewer's own share toggle and hide button (any participant),
 * plus an admin's removal. Rendered regardless of lifecycle state — an admin
 * may still want to remove a finished game, and a participant may still want
 * to stop sharing or hide one.
 */
function renderGameManagement(game: GameView): string {
  const parts: string[] = [];
  if (game.viewerShared !== null) {
    parts.push(
      game.viewerShared
        ? `<form method="post" action="${gamePath(game.id, 'share')}"><input type="hidden" name="on" value="0"><button type="submit" class="btn btn-quiet btn-sm">Stop sharing</button></form>`
        : `<form method="post" action="${gamePath(game.id, 'share')}"><input type="hidden" name="on" value="1"><button type="submit" class="btn btn-quiet btn-sm">Share with spectators</button></form>`,
    );
  }
  if (game.canHide) {
    parts.push(
      // `return_to` naming the game's own page (ticket 05) routes a refusal
      // back here rather than the games list — the same "where did the click
      // come from" idiom the list row's hide button and the join button share.
      `<form method="post" action="${gamePath(game.id, 'hide')}"><input type="hidden" name="return_to" value="${gamePath(game.id)}"><button type="submit" class="btn btn-quiet btn-sm">Hide from my games</button></form>`,
    );
  }
  if (game.canAdminDelete) {
    parts.push(
      `<form method="post" action="${gamePath(game.id, 'admin-delete')}"><button type="submit" class="btn btn-danger btn-sm">Remove this game</button></form>`,
    );
  }
  if (parts.length === 0) return '';
  return `<div class="block"><h2>Visibility</h2><p class="hint">${
    game.viewerShared === null
      ? 'Only an admin can see this here.'
      : game.viewerShared
        ? 'Shared: anyone can view this game.'
        : 'Not shared: only the two players can view this game.'
  }</p><div class="row-actions">${parts.join('')}</div></div>`;
}

/**
 * Everything on the game screen that a move changes (ticket 14). The controls
 * and the reserves are here alongside ADR-0007's three regions because a move
 * changes them too: a fresh board beside a stale stone count, or beside a move
 * form that says it is still your turn, is exactly the inconsistency the
 * stream exists to remove.
 */
export function gameRegions(game: GameView): Regions<'status' | 'board' | 'controls' | 'reserves' | 'moves'> {
  return {
    status: renderGameStatus(game),
    board: renderBoard(game),
    controls: renderGameControls(game),
    reserves: renderReserves(game),
    moves: renderHistory(game),
  };
}

export function renderGamePage(user: SessionUser, game: GameView, view: GameViewPageView = {}): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const regions = gameRegions(game);
  // Only the board's size: everything else the adapter needs changes while the
  // page is open, so it rides in the streamed board element instead.
  const boardConfig = { size: game.boardSize };

  // The `takBoard` scope sits *inside* the stream wrapper and *outside* the
  // board, controls, reserves and moves regions, so a swap replaces them while
  // the composition and review state on the scope survives (ADR-0007). The
  // swap itself is skipped when the HTML is unchanged, so an idle stream never
  // touches the board at all. Reserves and moves join board and controls here
  // (ticket 01): review needs to reach all four to show a reviewed position,
  // the same reason ticket 14 drew that boundary around board and controls.
  //
  // The keydown listener sits on this same wrapper (ticket 02): shortcuts
  // read and drive the same survives-the-stream state review does, so they
  // belong on the scope that already owns it rather than a second component.
  const live = `
${region('status', regions.status)}
${error}
${renderLegend()}
<div x-data="${COMPONENTS.board}(${escapeHtml(JSON.stringify(boardConfig satisfies BoardConfig))})" x-cloak x-on:keydown.window="${METHODS.handleKey}($event)">
  ${renderShortcutsHelp()}
  ${region('board', regions.board)}
  ${region('controls', regions.controls)}
  ${/* Deliberately not a region: share, hide and admin-removal change only by
       the viewer's own action, which is a POST and a redirect, so there is
       nothing for a stream to tell them. It sits inside the wrapper because the
       wrapper touches only what carries `data-region`. */ ''}
  ${renderGameManagement(game)}
  ${region('reserves', regions.reserves)}
  ${region('moves', regions.moves)}
</div>`;

  const body = `
${breadcrumb({ href: '/games', label: 'Games' }, `Game ${game.id}`)}
<h1>Game ${game.id}</h1>
${streamed(gamePath(game.id, 'stream'), live)}
${renderMoveSyntax()}`;
  return renderShell(`Game ${game.id}`, body, { user, path: '/games', scripts: 'client' });
}

/** Register the copy button as an Alpine component. It stays inline beside
 *  the one page that uses it, rather than joining the bundle (ADR-0006). */
const TAK_COPY_SCRIPT = `<script>
document.addEventListener('alpine:init', () => {
  Alpine.data('takCopy', () => ({
    // The clipboard API is absent over plain HTTP away from localhost, and can
    // still refuse at the point of use, so the button only shows where it
    // works. The record stays selectable either way.
    supported: Boolean(navigator.clipboard),
    copied: false,
    copy() {
      navigator.clipboard.writeText(this.$refs.record.textContent).then(
        () => {
          this.copied = true;
          setTimeout(() => { this.copied = false }, 1500);
        },
        () => { this.supported = false },
      );
    }
  }));
});
</script>`;

/**
 * The copy-out page for one export (ticket 15). The record is selectable on
 * its own (`user-select: all`), so copying works with scripting off; the Copy
 * button is an enhancement that only appears where the clipboard API exists.
 */
export function renderExportPage(user: SessionUser, gameId: number, view: GameExport): string {
  const whole = view.throughMove === view.totalMoves;
  const other: ExportFormat = view.format === 'ptn' ? 'tps' : 'ptn';
  const through = whole ? '' : `&amp;through=${view.throughMove}`;

  const what =
    view.format === 'ptn'
      ? whole
        ? 'The full game as Portable Tak Notation. Paste it anywhere that reads PTN — including this site, to carry the game in.'
        : `The game as Portable Tak Notation up to and including move ${view.throughMove} of ${view.totalMoves}. It replays on its own.`
      : whole
        ? 'The final position as the Tak Positional System describes it.'
        : `The position after move ${view.throughMove} of ${view.totalMoves}, as the Tak Positional System describes it.`;

  const body = `
${breadcrumb({ href: gamePath(gameId), label: `Game ${gameId}` }, view.format.toUpperCase())}
<h1>${view.format.toUpperCase()}</h1>
<p class="lede">${what}</p>
${TAK_COPY_SCRIPT}
<div x-data="takCopy">
  <pre class="export-text" x-ref="record">${escapeHtml(view.text)}</pre>
  <p class="actions">
    <button type="button" class="btn" x-on:click="copy()" x-show="supported" x-cloak x-text="copied ? 'Copied' : 'Copy'">Copy</button>
    <a class="btn btn-quiet" href="${gamePath(gameId, 'export')}?format=${other}${through}">Show ${other.toUpperCase()} instead</a>
    <a class="btn btn-quiet" href="${gamePath(gameId)}">Back to the game</a>
  </p>
</div>
<p class="hint">Select the record above to copy it by hand.</p>`;
  return renderShell(`${view.format.toUpperCase()} — game ${gameId}`, body, { user, path: '/games', scripts: 'alpine' });
}
