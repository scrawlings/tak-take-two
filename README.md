# tak-take-two

A website for hosting games of [Tak](https://ustak.org/play-beautiful-game-tak/), the abstract board game by James Ernest and Patrick Rothfuss. For more insight into the game community and a place to play online now, have a look at [Play Tak](https://playtak.com).

Originally conceived to support play-by-mail in the tradition of keeping games on a physical board, but the board and move interface in the system can certainly be used to play on their own. This is the second implementation in TypeScript (earlier work exists in Clojure and a first TypeScript pass). 

While this is largely coded by Claude and Deepseek, I've guided it with a heavy hand and a consistent process that documents what is done and why, attending to testability and robustness though close attention to modularisation - it's code written to be understood and interacted with by humans, (written so as not to upset my friends in security, and ops, and other programmers).

## A Deliberate Portfolio Piece

If you're viewing this because you're considering me for a role, I've very deliberately steered into a domain that doesn't give me the freedom to pivot away from and ignore hard problems. Even with AI generated code and documents this should show the types of concerns that I choose to prioritise. The scale here, at well over 20k LOC (50% test code) before we start work on computer/bot players, puts it into med-large micro-service category, arguably I'm steering toward the disciplined monolith pattern.

There are a variety of elements that make this a necessarily complex system. From a portfolio perspective, as well as a platform for my own experiments in training bots to play the game, the goal is to keep the system understandable and maintainable even with the necessary complexity.

### Not just CRUD

- The domain is complex, move validity is not trivial, needing to represent move correctness on both server and client risks duplication,
- The game playing model is complex with live updates between players and spectators, representing what is allowed at any time
- Players are in competition, with the end goal of being rated against each other, so history and idenity are critical

### Game History and Representation

There are two representations threaded through the whole system: PTN which describes a game by playing forward move by move; and TPS which describes the pieces on the board at a point in time. 

Both have value in different parts of the system and future planned work: 

- Position evaluation for bot training, 
- scrubbing back and forth in game history for study,
- reproducing a game at any point to start a new game to explore different play options, 
- game play analysis to identify cheating (and potentially more general security user behaviour analysis),
- recovering and resuming games when players log out or connections fail,
- PTN representation is a standard used by the wider game playing community

This creates two representations that both describe state at any time: a series of move deltas versus a series of board/game states. Ensuring they are syncronised and using the appropriate tool at different times is a real compromise in optimisation versus clarity versus integrity of redundent representations.

### Bot Players

Computer players and building the system that can train them is one of my key interests in pursuing this project. Using AI coding has created a framework for that much more quickly then any time I've approached the problem by hand. Here are some initial thoughts:

- Game learning algorithms for Go and Chess have some advantage because the board state is naturally represented in a fixed sized piece, but Tak has cell states that include varied size stacks of pieces, as well as moves that can move multiple pieces at once and change the state of other pieces.
- There isn't a deep history of expert games, unlike the long history of game records for professional play for Chess and Go.
- Game server and tournament security is a challenge, detecting cheating when people look to bots to guide their moves. It's a big problem on popular Go and Chess servers. The event recording and observability features built in already are intended to provide support for this type of analysis in future. 

This is a project built to give me new things to learn.

### Things to find in the code

If you're interested in this project from a coding point of view, some of the interesting details include:

- The Tak rules engine (stack moves, the carry limit, capstone flattening, the decided-position vs finished-game distinction)
- The PTN/TPS text formats with their round-trip constraints
- The game-lifecycle features (share-based visibility, one pending request per game, seat semantics, self-play). 
- The server itself, lightweight user management, observability and history, https and password login implementations.

And of course it's tested, with a testing discpline focused on interfaces and avoiding knowledge of implementations.

## Status

Implemented and playable: The initial tranche of work represented by the tickets in `.scratch/tak-host` are implemented. This allows a server to be set up locally with self terminated TLS and an admin user managed user access control system, state persisted in a local sqlite database, requiring Typescript/Node.js to build and run.

Planned further work, specced under `.scratch/`: computer opponents and a move-suggesting coach (`bots`), a headless training harness (`bot-training`), and ongoing security model improvement including session timeouts, etc. And never forgetting the constant work of refactoring to maintain code quality in a growing complex system.


## Further reading

- [Design](./docs/design.md) — the consolidated design
- [Domain glossary](./CONTEXT.md) - an extensive glossary that also give insight into the range of concepts in the system
- [Architecture decisions](./docs/adr/) - particularly when a considered decision to choose one technical direction over another has been required
