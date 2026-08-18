# tak-take-two

A website for hosting games of [Tak](https://ustak.org/play-beautiful-game-tak/), the abstract board game by James Ernest and Patrick Rothfuss. Players reproduce the game on their physical boards while the site records, validates, and shares their moves.

This is the second implementation in TypeScript (earlier work exists in Clojure and a first TypeScript pass).

## Status

Implemented and playable: 17 of 21 tickets are done. Players can propose games — open, invited to a named player, or carried in from a PTN record — join or self-play them, and enter moves by board click or PTN text. The site validates every move against the official rules, detects road and flat wins, and records the game. Take-backs and draw offers follow a request/accept protocol; games can be shared with spectators, hidden, or removed by an admin; any position exports as PTN or TPS.

Remaining: real-time updates (ticket 14), interactive stack-move creation (19), and two architecture tickets (20, 21).

The interesting parts are the hard ones: the Tak rules engine (stack moves, the carry limit, capstone flattening, the decided-position vs finished-game distinction), the PTN/TPS text formats with their round-trip constraints, and the game-lifecycle invariants (share-based visibility, one pending request per game, seat semantics, self-play). The [domain glossary](./CONTEXT.md) is the vocabulary the code and the [architecture decisions](./docs/adr/) speak in.

## Further reading

- [Design](./docs/design.md) — the consolidated design
- [Domain glossary](./CONTEXT.md)
- [Architecture decisions](./docs/adr/)
