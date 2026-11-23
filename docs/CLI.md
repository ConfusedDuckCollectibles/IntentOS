# CLI contract

Run from the checkout using the pinned Node version. Both programs support `help`, `--help`, and `--version`. Version output is a single line. Normal commands write JSON to stdout; operational errors write text to stderr. Diagnostic error text is not a stable API.

## Runtime commands

```text
node src/cli.ts COMMAND STATE_DIRECTORY [ARGUMENTS]
```

| Command | Arguments after directory | Behavior |
| --- | --- | --- |
| `demo` | none | Fixed offline proposal, fixture approval, execution and verification; directory defaults to `.intentos` |
| `queue-demo` | none | Lost-reply demonstration in `STATE_DIRECTORY/queue-demo`; directory defaults to `.intentos` |
| `propose` | `ID TEXT` | Propose the allowlisted original simulated write at `demo/result` |
| `approve` | `ID HASH [TTL_SECONDS]` | Approve exact digest, default 300 seconds, maximum 86,400 seconds |
| `deny` | `ID HASH` | Record exact rejection |
| `revoke` | `ID HASH` | Restrict exact approval; cannot undo a durable dispatch claim |
| `execute` | `ID` | Claim and perform eligible synthetic work |
| `verify` | `ID` | Read independent evidence; queue work may remain uncertain |
| `recover` | none | Replay original executing intents; return uncertain queue attempts without resending |
| `status` | none | Host-only snapshot plus audit integrity result |

Only `propose` and the demos initialize fresh state. Other commands require an existing valid pair and never create replacements. All non-demo action commands require an explicit state directory. Unknown commands, missing/excess arguments and invalid lifetime syntax fail before opening or creating stores. Use the typed host API for richer queue proposals; the CLI deliberately does not accept arbitrary tools or shell commands.

## Storage commands

```text
node src/storage-cli.ts check DIRECTORY
node src/storage-cli.ts adopt-legacy DIRECTORY --confirm-stopped-workers
node src/storage-cli.ts upgrade-approvals DIRECTORY --confirm-stopped-workers
node src/storage-cli.ts backup DIRECTORY NEW_DESTINATION --confirm-stopped-workers
node src/storage-cli.ts restore BACKUP_DIRECTORY NEW_DESTINATION --confirm-stopped-workers
```

The confirmation flag is an operator instruction, not authentication or proof every worker stopped. Backup/restore destinations must be new. Read [storage procedures](STORAGE.md) before using them.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Requested operation completed; this is not a claim that every intent is verified |
| `1` | Operational refusal/error, failed or uncertain action result, uncertain item returned by `recover`, or invalid audit reported by `status` |
| `2` | Invalid CLI usage, command, argument count, or lifetime syntax/range |

`execute` may return `applied` with exit 0: verification is still required. `status` is inspection and returns 0 for a valid audit even if some jobs are pending/uncertain. `deny` completes successfully with exit 0. A successful revocation of an already-uncertain intent can return its still-uncertain result with exit 1: inspect JSON; do not assume no state changed. A failed operation may have committed an execution intent before encountering a service failure. Never blindly rerun a business action with a new ID based on an exit code alone.

Unexpected process termination uses the OS/process exit convention, not these normal codes. Fixture workers deliberately exit 71–73 for crash tests; they are internal tools, not operator commands. See [installation and verification](INSTALL.md) for all four npm demo commands.
