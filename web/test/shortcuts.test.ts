import { describe, expect, it } from 'vitest';
import { isTypingTarget, resolveShortcut, stepReview } from '../src/client/shortcuts.js';

/** The shortcuts module at its interface (ADR-0006): a keystroke and the
 *  focused element in, the action it means (or none) out. No DOM. */

describe('resolveShortcut', () => {
  const bindings: ReadonlyArray<[string, string]> = [
    ['Enter', 'play'],
    ['[', 'back'],
    [']', 'forward'],
    ['u', 'takeback'],
    ['Escape', 'cancel'],
    ['?', 'help'],
  ];

  for (const [key, action] of bindings) {
    it(`maps "${key}" to "${action}"`, () => {
      expect(resolveShortcut({ key }, null)).toBe(action);
    });
  }

  it('is null for a key with no binding', () => {
    expect(resolveShortcut({ key: 'x' }, null)).toBeNull();
    expect(resolveShortcut({ key: 'U' }, null)).toBeNull(); // case-sensitive: not the take-back binding
  });

  it('is null for a modified chord, so browser/OS shortcuts are left alone', () => {
    expect(resolveShortcut({ key: 'Enter', ctrlKey: true }, null)).toBeNull();
    expect(resolveShortcut({ key: '[', metaKey: true }, null)).toBeNull();
    expect(resolveShortcut({ key: 'u', altKey: true }, null)).toBeNull();
  });

  it('is null while focus is in an input, a textarea, or a select', () => {
    expect(resolveShortcut({ key: 'u' }, { tagName: 'INPUT' })).toBeNull();
    expect(resolveShortcut({ key: 'u' }, { tagName: 'input' })).toBeNull();
    expect(resolveShortcut({ key: 'u' }, { tagName: 'TEXTAREA' })).toBeNull();
    expect(resolveShortcut({ key: 'u' }, { tagName: 'SELECT' })).toBeNull();
  });

  it('is null while focus is on a contenteditable element, regardless of its tag', () => {
    expect(resolveShortcut({ key: 'u' }, { tagName: 'DIV', isContentEditable: true })).toBeNull();
  });

  it('still resolves while focus is on an ordinary element, like a board button', () => {
    expect(resolveShortcut({ key: 'u' }, { tagName: 'BUTTON' })).toBe('takeback');
  });

  it('resolves when there is no focused element at all', () => {
    expect(resolveShortcut({ key: '?' }, undefined)).toBe('help');
  });
});

describe('stepReview', () => {
  it('is a no-op with no history at all', () => {
    expect(stepReview(null, 0, -1)).toEqual({ kind: 'noop' });
    expect(stepReview(null, 0, 1)).toEqual({ kind: 'noop' });
  });

  it('backs up from live to the last move — the same position a click on it would show', () => {
    expect(stepReview(null, 3, -1)).toEqual({ kind: 'goto', move: 3 });
  });

  it('backs up one further move at a time', () => {
    expect(stepReview(3, 3, -1)).toEqual({ kind: 'goto', move: 2 });
    expect(stepReview(2, 3, -1)).toEqual({ kind: 'goto', move: 1 });
  });

  it('is a no-op backing up past the first move — "the start"', () => {
    expect(stepReview(1, 3, -1)).toEqual({ kind: 'noop' });
  });

  it('is a no-op stepping forward while already live', () => {
    expect(stepReview(null, 3, 1)).toEqual({ kind: 'noop' });
  });

  it('steps forward one move at a time', () => {
    expect(stepReview(1, 3, 1)).toEqual({ kind: 'goto', move: 2 });
  });

  it('goes live stepping forward from the last move — that position and live are the same one', () => {
    expect(stepReview(3, 3, 1)).toEqual({ kind: 'live' });
  });
});

describe('isTypingTarget', () => {
  it('is false for no target', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it('is true for input/textarea/select, case-insensitively', () => {
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'Select' })).toBe(true);
  });

  it('is false for other elements', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
  });
});
