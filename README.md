# IntentOS

A working, CLI-first experiment in model-independent agent collaboration. A planner proposes an intent, a human operator approves its exact digest, an executor applies it to an offline simulated service, and a separate scoped verifier reads back durable evidence. Models do not receive execution capabilities.

**Status: 0.1 MVP, not a production security boundary.** IntentOS is a working name, not a cleared brand; see [competitive notes](docs/COMPETITIVE-NOTES.md). All spending is integer simulation credits. No live model calls, money transfers, shell tools, or default network connectors. No dependencies or build step. Requires Node.js 24+ (native TypeScript stripping and `node:sqlite`). No Vue UI is needed for this CLI MVP.

## Run in one minute

```sh
npm test
npm run demo
npm start -- status .intentos
```

The demo explicitly approves a fixed, harmless simulated write as the local operator. It ends in `verified`, with read-back evidence and three credits charged from a twelve-credit cap. Running it again leaves the effect and charge unchanged. Nothing leaves your computer. `.intentos/` contains the two SQLite databases and is ignored by Git.

## Manual exact approval

```sh
node src/cli.ts propose ./manual task1 'Draft release notes'
# Inspect the displayed payload, cost, and hash. Copy the exact hash below.
node src/cli.ts approve ./manual task1 <hash>
node src/cli.ts execute ./manual task1
node src/cli.ts verify ./manual task1
node src/cli.ts status ./manual
```

Use `deny` instead of `approve` to reject an intent. Executing a pending or denied intent fails. A rejected or failed intent cannot be silently amended or reapproved: create a new intent ID and obtain a fresh exact approval. A proposal with the same ID and same payload is idempotent; changed payloads conflict. The CLI is a trusted local operator tool, not an authentication service. Anyone able to operate it or modify its files is inside the host trust boundary.

After interruption, run `node src/cli.ts recover ./manual`, then `verify` each applied intent. Recovery replays durable `executing` records using their original idempotency token. It does not approve pending work. Applied jobs await verifier action. `status` exposes the full local state and checks the audit hash chain.

## Implemented

- Scoped, unforgeable-by-copy in-process actor capability objects, with separate planner, approver, executor, verifier roles.
- Strict JSON proposals for one allowlisted action: append an immutable simulated `put` effect to a service ledger. It does not write arbitrary filesystem paths or execute commands.
- Approval digest binds intent ID, action, canonical validated payload, runtime-fixed cost, and policy version.
- SQLite `BEGIN IMMEDIATE` transactions, WAL, `synchronous=FULL`, persisted budget, and a transactional hash-linked audit trail.
- Runtime-fixed cost of 3 integer credits; spend is reserved/charged atomically before execution. Restart cannot raise an existing cap.
- Service idempotency tokens prevent duplicate effects across retry and crash windows.
- Independent read-only service connection for deterministic verification. Executor claims alone cannot produce `verified`.
- Interchangeable deterministic offline, OpenAI Chat Completions, and Anthropic Messages proposal adapters. Provider adapters require an explicit injected transport, model and key; CLI never imports a network transport or reads credentials.

Provider wire formats are covered with mock HTTP responses. No real provider compatibility or latency has been tested. Reference contracts: [OpenAI Chat](https://developers.openai.com/api/reference/typescript/resources/chat) and [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create). The transport owner is responsible for timeouts, size limits, credential handling, and any actual provider billing; simulated execution credits do not cap API bills.

## Verification

`npm test` uses Node's test runner with isolated temporary databases, mocked transport, and actual child-process termination. It covers success, wrong digest, denial, role/scope violations, copied capabilities, immutable IDs, budget overflow, persistence, simultaneous workers, service idempotency conflicts, evidence tampering, audit tampering, and process death before effect, after effect, and before acknowledgment commit. No network is used by tests. Node strips types; this dependency-free MVP does **not** run a TypeScript static type checker.

See [architecture and guarantees](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md), and [MIT license](LICENSE).
