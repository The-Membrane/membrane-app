// Offline membership binding for one exact Vault V2 route event.
// Getter reads remain caller-supplied; this module performs no RPC or outcome read.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { compareRouteDataBytes } from './morpho-v2-route-data-proof.mjs'
import { readSealedRouteRiskManifest } from './morpho-v2-route-risk-manifest.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const HEX = /^0x[0-9a-f]+$/i
const IDENTITY = [
  'eventKey',
  'vault',
  'asset',
  'factoryCreationBlock',
  'block',
  'blockHash',
  'transactionIndex',
  'txHash',
  'logIndex',
  'fromAdapter',
  'toAdapter',
  'fromDataTopicHash',
  'toDataTopicHash',
]

const identical = (left, right) =>
  typeof left === 'string' && typeof right === 'string' && HEX.test(left) && HEX.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right

/** Select by exact coordinate and reject a truncated, absent, or ambiguous source. */
export function selectUniqueRouteAnchor(manifest, claimedAnchor) {
  if (
    manifest?.study !== 'morpho-v2-route-risk-manifest-v1' ||
    manifest.transitionCount !== 116 ||
    !Array.isArray(manifest.transitions) ||
    manifest.transitions.length !== 116 ||
    !claimedAnchor ||
    typeof claimedAnchor.eventKey !== 'string'
  )
    throw new Error('Complete route manifest and claimed event key required')
  const keys = manifest.transitions.map((row) => row.eventKey)
  if (keys.some((key) => typeof key !== 'string') || new Set(keys).size !== 116)
    throw new Error('Duplicate or invalid route event keys')
  const matches = manifest.transitions.filter((row) => row.eventKey === claimedAnchor.eventKey)
  if (matches.length !== 1) throw new Error('Route anchor absent or ambiguous in sealed source')
  const trusted = matches[0]
  for (const field of IDENTITY) {
    if (!Object.hasOwn(claimedAnchor, field) || !identical(claimedAnchor[field], trusted[field]))
      throw new Error(`Route anchor ${field} differs from sealed source`)
  }
  if (
    trusted.eventKey !== `${trusted.block}:${trusted.transactionIndex}:${trusted.logIndex}` ||
    trusted.header?.block !== trusted.block ||
    trusted.header?.hash !== trusted.blockHash
  )
    throw new Error('Sealed route anchor coordinate/header inconsistency')
  return trusted
}

/**
 * The three source readers verify pinned physical SHAs and complete checkpoints.
 * The digest of JSON.stringify(manifest) identifies the reconstructed object;
 * there is no separately persisted physical manifest file.
 */
export function bindSealedRouteEvidence({
  factoryPath,
  routePath,
  headerPath,
  claimedAnchor,
  previousBlockHash,
  beforeB,
  atB,
}) {
  if (![factoryPath, routePath, headerPath].every((path) => typeof path === 'string' && path))
    throw new Error('Explicit sealed source paths required')
  const paths = { factory: factoryPath, route: routePath, headers: headerPath }
  const sourcePhysicalSha256 = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, sha(readFileSync(path))]),
  )
  const manifest = readSealedRouteRiskManifest({ factoryPath, routePath, headerPath })
  for (const [name, path] of Object.entries(paths)) {
    if (sha(readFileSync(path)) !== sourcePhysicalSha256[name])
      throw new Error(`Sealed ${name} source changed during binding`)
  }
  const trustedAnchor = selectUniqueRouteAnchor(manifest, claimedAnchor)
  const reconstructedManifestSha256 = sha(JSON.stringify(manifest))
  const {
    manifestPhysicalSha256: _legacyName,
    caveat: _legacyCaveat,
    ...comparison
  } = compareRouteDataBytes({
    anchor: trustedAnchor,
    manifestPhysicalSha256: reconstructedManifestSha256,
    previousBlockHash,
    beforeB,
    atB,
  })
  return {
    ...comparison,
    assurance: 'sealed-source-anchor-membership;getter-reads-caller-supplied',
    sourcePhysicalSha256,
    reconstructedManifestSha256,
    anchor: Object.fromEntries(IDENTITY.map((field) => [field, trustedAnchor[field]])),
    caveat:
      'The manifest digest is reconstructed in memory from three physically verified source files; it is not the SHA of a stored manifest file. B is end-of-block, not immediately after this route event. A later same-block write can change the getter. Caller-supplied getter bytes and source-attestation fields do not prove RPC provenance, deployed implementation identity, B-1 ancestry, funding, executable withdrawal, or independent events.',
  }
}
