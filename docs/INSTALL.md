# Install and verify the local release candidate

This repository is a **private npm package, version 1.0.0-rc.1**: an open-source checkout, not an npm-published service. It performs only synthetic local actions by default. No account, API key or running server is needed.

## Supported verification target

The release target is **Linux with a local filesystem and Node 24.22.3**, pinned in `.node-version`. Hosted CI is configured for Ubuntu 24.04. The package declares Node 24 as its minimum family; the exact pinned version is the release verification baseline. macOS and Windows have not been verified for this candidate and are not claimed as supported. In particular, file identity and directory synchronization require platform validation before adding another support target. NFS/shared-network filesystems are outside the tested contract.

## Fresh checkout

Check out the candidate commit selected for review, then run from its root:

```sh
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run demo -- .intentos/release-check
npm run demo -- .intentos/release-check
npm run demo:queue -- .intentos/release-check
npm run demo:queue -- .intentos/release-check
npm run demo:storage
npm run demo:approvals
```

`npm ci` installs exactly the three locked **development** packages used by TypeScript checking. A first install normally needs access to the npm registry; `--offline` works only with a complete existing cache. Lifecycle scripts, audit calls and funding checks are disabled by the command above. There are no runtime dependencies. After obtaining the checkout, the tests and four demos themselves need no install or network access. `npm run verify` combines strict typecheck and tests and therefore needs the development install.

The first two demos retain local state under the selected directory; repeat runs check the same result. The storage and approval demos create and remove their own temporary directories. Always use a new empty directory for a fresh demo rather than deleting uncertain real state. Demo auto-approval and injected clocks/crashes are explicit fixed fixtures, not human authentication.

## Existing state

Do not point a new release at old files and delete whatever causes an error. See [storage upgrade and backup](STORAGE.md) and [approval migration](APPROVALS.md): unversioned adoption is conservative, format-1 stores require an explicit upgrade, and old undispatched approvals receive no invented lifetime. Maintenance requires all workers stopped. Restore complete verified pairs into a new directory; never copy one SQLite file over a live store.

## Embedding

Use the [public local API](PUBLIC-API.md) from the source checkout. The source uses native Node TypeScript stripping and is not built into a distributable JavaScript npm package. Installing this private source under `node_modules` is not a supported deployment route. A packaged JavaScript distribution would be separate work with its own tests.

See [CLI commands and exit codes](CLI.md), [security boundary](../SECURITY.md), and [release verification gates](RELEASE.md). Local success does not imply hosted CI passed; the exact candidate SHA must be checked separately before a final release decision.
