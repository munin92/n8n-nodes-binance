# Contributing

The sharp edges below are written down so they are not rediscovered.

## Getting set up

```bash
npm ci          # not `npm install` — see the eslint pin below
npm run build
npm run lint
npm test        # unit tests, run against dist
npm run test:built
```

## Sharp edges

**Read-only on purpose.** The node has no order or withdrawal operation, and the credential test
rejects keys with trading, margin, futures or withdrawal rights (`/sapi/v1/account/apiRestrictions`).
Keep it that way; a sync job never needs them.

**Trades exist only per symbol.** `/api/v3/myTrades` requires `symbol` and caps a time range at 24 h,
so the node pages by `fromId` from 0 instead. Which symbols to ask for is the caller's job.

**Deposit/withdrawal history answers in 90-day windows.** `collectWindows()` walks from the start
date to now; each window pages by `offset`.

**Signature is hex HMAC-SHA256 over the exact query string** (`timestamp` and `recvWindow` included),
appended as `signature`. The test uses the example from binance-spot-api-docs.

**No runtime dependencies.** n8n rejects community packages that have them.

**`eslint` is pinned to an exact version.** `@n8n/eslint-plugin-community-nodes` declares it as an exact
peer. A caret range passes `npm install` and fails `npm ci`.

**Use `'main' as NodeConnectionType`, not `NodeConnectionType.Main`.** An older shared `n8n-workflow`
lacks the constant and n8n reports it as *"Class could not be found"*.

**`n8n-workflow` types follow the cluster's n8n**, not npm's `latest` tag. Look up
`npm view n8n@<version> dependencies.n8n-workflow`.

## The very first publish of a new package

A trusted publisher can only be configured on a package that already exists, and
`publishConfig.provenance` fails outside CI (`provider: null`). So the first
version goes out once by hand, logged in, with `--no-provenance`:

```bash
npm login
npm publish --no-provenance
npm trust github @munin92/<package> --file release.yml --repo munin92/<repo> --allow-publish
```

Without `npm login` first, the publish into the `@munin92` scope answers
`404 Not Found`, not 401. An `NPM_TOKEN` in CI does not help: tokens that bypass
2FA are being restricted for publishing, and the run fails with `EOTP` after
semantic-release has already pushed the tag — then the tag has to be published
by hand anyway.

## Commits and releases

Conventional Commits — semantic-release reads them and every push to `main`
publishes through npm trusted publishing with provenance, no token.
Merge `develop` → `main` with a merge commit, never squash: semantic-release
needs the individual commits. Do not edit the version in `package.json`.
