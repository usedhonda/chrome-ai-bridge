# Documentation

The active workflow is **v3 native browser use**. Start with [setup](user/setup.md) or the [repository overview](../README.md).

| Guide                                                   | Contents                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| [Specification](SPEC.md)                                | Architecture, provider contracts, durable state and recovery        |
| [Setup](user/setup.md)                                  | Claude Code / Codex browser setup, skill discovery, v2 migration    |
| [Workflows](user/workflows.md)                          | New requests, continuation, private code context, live verification |
| [Command reference](tool-reference.md)                  | CLI lifecycle and options                                           |
| [Troubleshooting](user/troubleshooting.md)              | Browser setup, mode selection, uncertain sends, PR verification     |
| [v3 decisions](roadmap-v3.md)                           | Scope and reasons for the redesign                                  |
| [Discord collector](user/discord-readonly-collector.md) | Separate read-only collection utility                               |

Articles under `blog/` describe the earlier extension/network-interception design. Use them as historical background, not as instructions for the normal `cab` workflow. Earlier specifications are retained in Git history; explicit `cab legacy ...` commands are the migration path for old transport users.
