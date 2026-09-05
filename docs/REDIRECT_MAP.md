# Redirect Map

Running record of route moves and deletions, per docs/SEO_RULESET.md R3: every
route that moves or dies gets a permanent redirect in `next.config.mjs
redirects()` in the same PR, and a row here so post-migration cleanup keeps the
history.

| Old route | Now | Since | Mechanism |
|---|---|---|---|
| `/:chain/cityscape` | 308 -> `/:chain` | evm-migration, Sep 2026 | next.config redirects() |
| `/:chain/flywheel` | 308 -> `/:chain` | evm-migration, Sep 2026 | next.config redirects() |
| `/:chain/lockdrop` | 308 -> `/:chain` | evm-migration, Sep 2026 | next.config redirects() |
| `/:chain/manic` | 308 -> `/:chain` | evm-migration, Sep 2026 | next.config redirects() (top-level `/manic` stub deleted; unknown top-level paths 404 via middleware.ts) |
| `/:chain/isolated/:marketAddress/:symbol*` | 308 -> `/:chain/isolated` | evm-migration, Sep 2026 | next.config redirects() |
| `/osmosis/*`, `/osmosis-v2/*`, `/neutron/*` (legacy chains) | 308 -> `/ethereum/*` | evm-migration, Sep 2026 | middleware.ts |
| any other unknown top-level path | HTTP 404 | evm-migration, Sep 2026 | middleware.ts (previously a 307 to the homepage - a soft-404) |

Notes:
- middleware.ts runs before next.config redirects; invalid chain segments never
  reach the redirect rules.
- The `/:chain` patterns match the valid chain set only in practice, because
  middleware 404s or rewrites everything else first.
