import { describe, expect, it } from 'vitest';
import {
  attributeSelector,
  COMPONENTS,
  datasetKey,
  METHODS,
} from '../src/contract.js';
import { boardComponent } from '../src/client/board-adapter.js';

/**
 * The markup contract (ADR-0011): the strings shared between the server's
 * pages and the bundled client. The derivations are unit-tested here, and the
 * Alpine vocabulary is pinned against the adapter's actual surface — the guard
 * that makes a silent rename on either side a failing test.
 */

describe('datasetKey', () => {
  it('derives the dataset key from a data- attribute', () => {
    expect(datasetKey('data-square')).toBe('square');
    expect(datasetKey('data-height')).toBe('height');
    expect(datasetKey('data-top')).toBe('top');
    expect(datasetKey('data-stack')).toBe('stack');
    expect(datasetKey('data-region')).toBe('region');
  });

  it('camel-cases a kebab-cased attribute', () => {
    expect(datasetKey('data-can-move')).toBe('canMove');
    expect(datasetKey('data-viewer-seat')).toBe('viewerSeat');
    expect(datasetKey('data-self-play')).toBe('selfPlay');
    expect(datasetKey('data-move-number')).toBe('moveNumber');
    expect(datasetKey('data-total-moves')).toBe('totalMoves');
  });

  it('leaves a single-token name alone', () => {
    expect(datasetKey('data-tps')).toBe('tps');
    expect(datasetKey('data-total')).toBe('total');
  });
});

describe('attributeSelector', () => {
  it('wraps an attribute in a selector', () => {
    expect(attributeSelector('data-region')).toBe('[data-region]');
  });
});

describe('the markup contract vs the adapter surface', () => {
  it('exposes every method the markup calls, under the names it calls', () => {
    const component = boardComponent({ size: 5 });
    for (const name of Object.values(METHODS)) {
      expect(typeof component[name]).toBe('function');
    }
  });

  it('registers the components the markup invokes, under the names it invokes', () => {
    expect(COMPONENTS.board).toBe('takBoard');
    expect(COMPONENTS.stream).toBe('takStream');
  });
});
