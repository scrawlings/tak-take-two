# Game visibility is a single per-player share toggle

A game is viewable by non-participants if and only if both players have their share toggle on. Open games start with both toggles on (joining implies sharing); invited games start with both off (designated-only, private by default). Hiding a game turns your share off and removes it from your own views; if both players hide a game, it is deleted. This unifies the two "public" meanings in the original brief — proposal visibility for invited games and viewing agreement for games in play — into one concept.

Status: accepted

## Considered options

- **Separate "proposal visibility" and "spectating agreement" states** — rejected: two concepts with identical default-by-join-type semantics; a single toggle is simpler and can't drift out of sync.
- **Three-state visibility (private / invited / public)** — rejected: over-engineering; designation is a property of the proposal, not a visibility state.
