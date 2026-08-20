/**
 * The client bundle's entry point: it registers the components the bundle
 * carries (ADR-0006's build seam, ADR-0007's single runtime). The export
 * page's `takCopy` is not among them — it stays an inline script beside the
 * one page that uses it, as ADR-0006 decided.
 *
 * The bundle is inlined by the shell for pages that ask for `scripts: 'client'`
 * — the game screen and the two game lists. Each component module stays free of
 * Alpine so a test can drive it as plain data; registration happens only here.
 */

import { boardComponent } from './board-adapter.js';
import { streamComponent } from './stream.js';
import { COMPONENTS } from '../contract.js';

interface AlpineGlobal {
  data<C>(name: string, factory: (config: C) => object): void;
}

declare const Alpine: AlpineGlobal;

document.addEventListener('alpine:init', () => {
  Alpine.data(COMPONENTS.board, boardComponent);
  Alpine.data(COMPONENTS.stream, streamComponent);
});
