# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| — (no skill equivalent)    | `done`               | Implemented and verified; removed from the action queue |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

`done` is a completion state, not a triage role: an agent sets it when every checklist item on the ticket is satisfied and verified, ticks the boxes, and records the work under a `## Comments` heading. The five canonical roles govern open tickets; `done` takes a ticket out of the action queue. Tickets that were completed before `done` existed may carry a legacy `needs-triage` with a note to the same effect.

Edit the right-hand column to match whatever vocabulary you actually use.
