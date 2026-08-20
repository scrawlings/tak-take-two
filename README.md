# tak-take-two

A website for hosting games of [Tak](https://ustak.org/play-beautiful-game-tak/), the abstract board game by James Ernest and Patrick Rothfuss. For more insight into the game community and a place to play online now, have a look at [Play Tak](https://playtak.com).

Originally conceived to support play-by-mail in the tradition of keeping games on a physical board, but the board and move interface in the system can certainly be used to play on their own. This is the second implementation in TypeScript (earlier work exists in Clojure and a first TypeScript pass). 

While this is largely coded by Claude and Deepseek, I've guided it with a heavy hand and a consistent process that documents what is done and why, attending to testability and robustness though close attention to modularisation - it's code written to be understood and interacted with by humans, (written so as not to upset my friends in security, and ops, and other programmers).

## Status

Implemented and playable: The initial tranche of work represented by the tickets in `.scratch/tak-host` are implemented. This allows a server to be set up locally with self terminated TLS and an admin user managed user access control system, state persisted in a local sqlite database, requiring Typescript/Node.js to build and run.

Planned further work, specced under `.scratch/`: computer opponents and a move-suggesting coach (`bots`), a headless training harness (`bot-training`), UI usability work — a history scrubber, keyboard shortcuts, and ongoing security model improvement including session timeouts, etc.

If you're interested in this project from a coding point of view, some of the interesting details include:
- The Tak rules engine (stack moves, the carry limit, capstone flattening, the decided-position vs finished-game distinction)
- The PTN/TPS text formats with their round-trip constraints
- The game-lifecycle features (share-based visibility, one pending request per game, seat semantics, self-play). 
- The server itself, lightweight user management, observability and history, https and password login implementations.

If you're interested in the ML bot training aspect, that's coming but some initial thoughts.
- Game learning algorithms for Go and Chess have some advantage because the board state is naturally represented in a fixed sized piece, but Tak has cell states that include varied size stacks of pieces, as well as moves that can move multiple pieces at once and change the state of other pieces.
- There isn't a deep history of expert games, unlike the long history of game records for professional play for Chess and Go.
- And interesting area of game server and tournament security is detecting cheating when people look to bots to guide their moves. It's a big problem on popular Go and Chess servers. The event recording and observability features built in already are intended to provide support for this type of analysis in future. This is a project built to give me new things to learn.

## Further reading

- [Design](./docs/design.md) — the consolidated design
- [Domain glossary](./CONTEXT.md) - an extensive glossary that also give insight into the range of concepts in the system
- [Architecture decisions](./docs/adr/) - particularly when a considered decision to choose one technical direction over another has been required
