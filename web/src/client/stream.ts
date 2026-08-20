/**
 * The live-update component (ticket 14, ADR-0007): one `EventSource` per
 * streamed page, swapping the regions the server re-rendered.
 *
 * The server sends whole regions of finished HTML rather than a diff or a
 * move, so the streamed page and the page a reload would serve come from the
 * same view functions and can never disagree. Every region in a frame is
 * applied together, so the board and the move list are never a move apart.
 *
 * The HTML assigned here is our own: it comes from the same escaping view
 * functions that rendered the page (`escapeHtml` on every user-supplied
 * string), over a same-origin authenticated stream the route authorises per
 * frame. It is server-rendered markup arriving late, not user input.
 *
 * A region whose HTML is unchanged is not written to. That spares the regions
 * carrying no Alpine directives — the status line, the move list, the reserves,
 * the list tables — whose markup is byte-identical to what the server sent, so
 * an unrelated change costs them nothing. It does *not* spare the board and the
 * controls: Alpine rewrites the nodes it binds (`x-cloak` removed, `x-text`
 * filled, `:class` applied), so their live `innerHTML` no longer matches the
 * server's string and every frame replaces them.
 *
 * What protects the click-builder is therefore placement, exactly as ADR-0007
 * said: the composition state lives on the `takBoard` scope *wrapping* the
 * board and controls regions, which this component never replaces. The nodes
 * swapped in re-bind against that surviving scope — `x-model="move"` refills
 * the move field, `:class` re-marks the source square — so a half-composed
 * move survives being redrawn.
 */

import { attributeSelector, datasetKey, REGION_ATTR, type StreamConfig } from '../contract.js';

export interface StreamComponent {
  /** Whether the connection is up. The page shows a quiet notice when it is not. */
  live: boolean;
  /** The regions this page exposes, by `data-region` name. */
  regions: Record<string, HTMLElement>;
  /** The open connection, so it can be closed on teardown. */
  source: EventSource | null;
  /** Alpine's root element, injected by Alpine itself. */
  $root?: HTMLElement;
  init(): void;
  destroy(): void;
  apply(payload: string): void;
  opened(): void;
  dropped(): void;
  gone(): void;
}

/** The regions a page exposes, read once from the markup the server sent. */
function findRegions(root: HTMLElement | undefined): Record<string, HTMLElement> {
  const found: Record<string, HTMLElement> = {};
  if (root === undefined) return found;
  root.querySelectorAll<HTMLElement>(attributeSelector(REGION_ATTR)).forEach((element) => {
    const name = element.dataset[datasetKey(REGION_ATTR)];
    if (name !== undefined && name !== '') found[name] = element;
  });
  return found;
}

export function streamComponent(config: StreamConfig): StreamComponent {
  return {
    live: true,
    regions: {},
    source: null,

    init(): void {
      this.regions = findRegions(this.$root);
      // Guarded so the component can be imported and driven by a test, as the
      // board adapter is: this module is a browser bundle, but the swap rule
      // is ordinary data and worth pinning.
      if (typeof EventSource === 'undefined') return;
      const source = new EventSource(config.url);
      this.source = source;
      source.addEventListener('open', () => this.opened());
      source.addEventListener('error', () => this.dropped());
      source.addEventListener('state', (event) => this.apply((event as MessageEvent<string>).data));
      source.addEventListener('gone', () => this.gone());
    },

    /** Alpine calls this when the component leaves the page. */
    destroy(): void {
      this.source?.close();
      this.source = null;
    },

    apply(payload: string): void {
      let frame: { regions?: Record<string, string> };
      try {
        frame = JSON.parse(payload) as { regions?: Record<string, string> };
      } catch {
        // A frame we cannot read is a frame we cannot trust; the page stays as
        // it is and the next one will be along.
        return;
      }
      const regions = frame.regions ?? {};
      for (const name of Object.keys(regions)) {
        const html = regions[name];
        const region = this.regions[name];
        if (region === undefined || html === undefined) continue;
        if (region.innerHTML !== html) region.innerHTML = html;
      }
    },

    opened(): void {
      this.live = true;
    },

    /** The browser reconnects on its own; this only says so on the page. */
    dropped(): void {
      this.live = false;
    },

    /**
     * The game is no longer this viewer's to watch — removed, deleted, or
     * unshared. Stop listening, or the browser would reconnect into a refusal
     * every few seconds, and ask the page route for the honest answer.
     */
    gone(): void {
      this.destroy();
      if (typeof location !== 'undefined') location.reload();
    },
  };
}
