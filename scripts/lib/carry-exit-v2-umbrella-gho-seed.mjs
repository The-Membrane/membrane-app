import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { UMBRELLA_GHO_ROUTE } from './carry-exit-v2-umbrella-gho-proof.mjs'
export const UMBRELLA_GHO_SEED_SHA256 =
  'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const sha = (value) => createHash('sha256').update(value).digest('hex')
export function readUmbrellaGhoV2SeedHolders() {
  const bytes = readFileSync(
    new URL('../route-cohort/aug-2026-ab-vault-seed.json', import.meta.url),
  )
  if (sha(bytes) !== UMBRELLA_GHO_SEED_SHA256) throw Error('umbrella_seed_digest_invalid')
  const owners = JSON.parse(bytes)
    .positions.filter(
      (p) =>
        p.vault.toLowerCase() === UMBRELLA_GHO_ROUTE.destination &&
        p.routeIds.includes(UMBRELLA_GHO_ROUTE.routeKey),
    )
    .map((p) => p.owner.toLowerCase())
  if (
    owners.length !== 21 ||
    new Set(owners).size !== 21 ||
    owners.some((h) => !/^0x[0-9a-f]{40}$/.test(h))
  )
    throw Error('umbrella_seed_identity_invalid')
  return owners
}
