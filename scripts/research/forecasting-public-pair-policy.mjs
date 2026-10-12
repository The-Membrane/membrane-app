// Separate, deliberately enrolled qualification scope. Never consulted by C1/C3.
import { createHash } from 'node:crypto'

const sha = (s) => createHash('sha256').update(s).digest('hex')
const fail = (reason) => { throw new Error(`public_pair_${reason}`) }
const urls = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com']
export const PUBLIC_PAIR_POLICY = Object.freeze({
  schema: 'forecasting_public_pair_qualification_v1',
  policyId: 'forecasting-public-pair-qualification-v1',
  status: 'pending_explicit_enrollment',
  chainId: 1,
  providers: Object.freeze(urls.map((url, i) => Object.freeze({
    alias: `P${i + 1}`, url, hostSha256: sha(new URL(url).hostname), uriSha256: sha(url),
  }))),
  optionalApi: Object.freeze({ url: 'https://api.morpho.org/graphql',
    hostSha256: sha('api.morpho.org'), uriSha256: sha('https://api.morpho.org/graphql') }),
  limits: Object.freeze({ maxRequests: 7, concurrency: 1, totalDeadlineMs: 30000,
    perRequestDeadlineMs: 4000, maxResponseBytes: 262144, redirects: 'error', retries: 0 }),
  archiveSupport: 'unqualified', holderCapacity: 'unqualified',
})

export const PUBLIC_PAIR_POLICY_SHA256 = sha(JSON.stringify(PUBLIC_PAIR_POLICY))

/** An enrollment is a separate retained record, not a write to any active policy. */
export function enrollPublicPairQualification({ policySha256, scope, enrolledAtUtc, expiresAtUtc }) {
  const start = Date.parse(enrolledAtUtc), end = Date.parse(expiresAtUtc)
  if (policySha256 !== PUBLIC_PAIR_POLICY_SHA256 || scope !== 'finite-read-only-head-qualification' ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 3600000)
    fail('enrollment_invalid')
  return Object.freeze({ schema: 'forecasting_public_pair_enrollment_v1', policySha256,
    scope, enrolledAtUtc, expiresAtUtc, replacesActivePolicy: false })
}

/** Fixed read-only requests only. Egress approval and an enrollment must precede execution.
 * Head selection is intentionally two stages: both finalized numbers must agree before
 * requesting the same exact block on both hosts. No archive/eth_call qualification is implied.
 */
export function publicPairQualificationPlan(enrollment, { nowMs, agreedFinalizedBlock = null,
  includeMorphoSchemaProbe = false } = {}) {
  if (!enrollment || JSON.stringify(enrollPublicPairQualification(enrollment)) !== JSON.stringify(enrollment) ||
      !Number.isFinite(nowMs) || nowMs < Date.parse(enrollment.enrolledAtUtc) ||
      nowMs >= Date.parse(enrollment.expiresAtUtc)) fail('enrollment_expired_or_invalid')
  if (typeof includeMorphoSchemaProbe !== 'boolean' ||
      (agreedFinalizedBlock !== null && !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(agreedFinalizedBlock)))
    fail('scope_invalid')
  const requests = PUBLIC_PAIR_POLICY.providers.flatMap(({ alias, url }) => agreedFinalizedBlock === null ? [
    { alias, url, body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } },
    { alias, url, body: { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['finalized', false] } },
  ] : [{ alias, url, body: { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber',
    params: [agreedFinalizedBlock, false] } }])
  if (includeMorphoSchemaProbe && agreedFinalizedBlock !== null) requests.push({ alias: 'MORPHO_SCHEMA',
    url: PUBLIC_PAIR_POLICY.optionalApi.url, body: { query: 'query QualificationSchema { __typename }' } })
  return { policySha256: PUBLIC_PAIR_POLICY_SHA256, requests, limits: PUBLIC_PAIR_POLICY.limits,
    qualification: 'pending', archiveSupport: 'unqualified', holderCapacity: 'unqualified',
    executionAllowed: false, forecastAvailable: false }
}

/** Accept only same-chain, exact same finalized block/time/hash evidence. This proves
 * head agreement alone; it cannot promote a holder quote or historical source.
 */
export function verifyPublicPairHead({ chainIds, finalizedHeads, exactHeads }) {
  if (!Array.isArray(chainIds) || chainIds.length !== 2 || chainIds.some((x) => x !== '0x1')) fail('chain_disagreement')
  const valid = (b) => b && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(b.number) &&
    /^0x[0-9a-f]{64}$/.test(b.hash) && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(b.timestamp)
  if (![finalizedHeads, exactHeads].every((rows) => Array.isArray(rows) && rows.length === 2 && rows.every(valid)))
    fail('block_evidence_invalid')
  const identity = ({ number, hash, timestamp }) => JSON.stringify([number, hash, timestamp])
  if ([...finalizedHeads, ...exactHeads].some((b) => identity(b) !== identity(finalizedHeads[0])))
    fail('head_disagreement')
  return { policySha256: PUBLIC_PAIR_POLICY_SHA256, status: 'head_agreement_only',
    block: finalizedHeads[0].number, blockHash: finalizedHeads[0].hash,
    blockTimestamp: finalizedHeads[0].timestamp, archiveSupport: 'unqualified',
    holderCapacity: 'unqualified', executionAllowed: false, forecastAvailable: false }
}
