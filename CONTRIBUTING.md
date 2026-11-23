# Contributing

Use Node 24 or newer. Use the pinned Node version in `.node-version` for reproducible checks. Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, and `npm test` before submitting changes. Keep the default demo deterministic and offline. Include a fault/recovery test for changes to authorization, budgets, idempotency, or state transitions. Never commit credentials, local databases, or private proposal data. Document trust-boundary changes and avoid claiming stronger guarantees than the tested service contract. Contributions are accepted under the MIT license.

## Keep the README current

The README is the project's front door. Every app improvement should update it in the same pull request: explain what changed in terms of what someone can do, keep the quickstart and capability/limitation claims accurate, and refresh the demo captures from an actual run when the visible behavior changes. Mark work that is still only on the roadmap as planned. Screenshots should have alt text and use safe demo data.
