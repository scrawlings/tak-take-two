# 04 — Core: TPS

**What to build:** Generate a TPS string for any position, and parse/validate TPS positions structurally and by material consistency. Starting games from a TPS position remains deferred.

**Blocked by:** 01 — Core: board model, place moves, win detection; 02 — Core: stack moves

**Status:** ready-for-agent

- [ ] Any position generates a TPS string conforming to the spec (rows top-down, stacks bottom-to-top, x-runs, S/C suffixes, turn, move counter).
- [ ] A well-formed TPS string parses back to the same position.
- [ ] Structural validation rejects malformed input; material validation rejects impossible positions (stone counts beyond reserves, walls/capstones not on top, too many capstones, etc.).
- [ ] Every failure returns a typed error — nothing throws.
