// A missing score requires an observed, independently replayed capture failure.
// This module never infers missing from the wall clock or from an unverified
// provider response. Expired cases without a receipt remain pending.
import { exactUtcMicros } from './lib/carry-exit-v2-block-auditor.mjs'

const SOURCE = 'carry_exit_v2_morpho_missing'
const REQUEST = Object.freeze({
  jsonrpc: '2.0',
  id: 91,
  method: 'eth_getBlockByNumber',
  params: ['finalized', false],
})
const ID = /^[1-9][0-9]{0,18}$/
const REVERT = /\b(?:execution reverted|revert(?:ed)?)\b/i

function host(client) {
  const value = new URL(client.url)
  if (
    !['https:', 'http:'].includes(value.protocol) ||
    !value.hostname ||
    value.username ||
    value.password ||
    typeof client.send !== 'function' ||
    typeof client.provider !== 'string' ||
    !client.provider
  )
    throw Error('missing_origin_invalid')
  return value.hostname.replace(/\.$/, '').replace(/^www\./, '')
}

/** Only transport or JSON-RPC failures count. A successful header prevents a receipt. */
async function failedProbe(client) {
  try {
    const response = await client.send(structuredClone(REQUEST))
    if (response?.jsonrpc !== '2.0' || response.id !== REQUEST.id) return null
    if (Object.hasOwn(response, 'result')) return null
    if (
      !response.error ||
      typeof response.error.code !== 'number' ||
      !(
        (response.error.code <= -32000 && response.error.code >= -32099) ||
        response.error.code === -32601 ||
        response.error.code === -32603
      ) ||
      REVERT.test(String(response.error.message ?? ''))
    )
      return null
    return {
      kind: 'rpc_error',
      code: String(response.error.code),
      message: 'JSON-RPC header request unavailable',
    }
  } catch (error) {
    // Error text may contain a credential or user-supplied URL. Persist only
    // stable, bounded transport classes, never the raw exception message.
    const safe = /^rpc_http_(?:401|403|408|429|5[0-9]{2})$/.test(error?.message)
      ? error.message
      : ['TimeoutError', 'AbortError'].includes(error?.name)
        ? 'rpc_timeout'
        : error instanceof TypeError
          ? 'network_failure'
          : null
    if (!safe) return null
    return { kind: 'transport_error', code: safe, message: 'JSON-RPC header transport unavailable' }
  }
}

function windowOpen(row, at) {
  return (
    exactUtcMicros(row.targetAt) <= exactUtcMicros(at) &&
    exactUtcMicros(at) <= exactUtcMicros(row.deadlineAt)
  )
}

function captureMissingDocuments({
  row,
  primary,
  secondary,
  firstFailure,
  secondFailure,
  attemptedAt,
  verifiedAt,
}) {
  if (
    !ID.test(String(row.caseId)) ||
    ![1, 4, 24, 48, 168].includes(Number(row.horizonH)) ||
    host(primary) === host(secondary) ||
    !windowOpen(row, attemptedAt) ||
    !windowOpen(row, verifiedAt) ||
    exactUtcMicros(verifiedAt) < exactUtcMicros(attemptedAt) ||
    !firstFailure ||
    !secondFailure
  )
    throw Error('missing_evidence_invalid')
  const caseId = String(row.caseId)
  const horizonH = Number(row.horizonH)
  const request = { method: REQUEST.method, params: REQUEST.params }
  const evidenceDoc = {
    schema: 'carry_exit_v2_missing_v1',
    caseId,
    horizonH,
    targetAt: row.targetAt,
    deadlineAt: row.deadlineAt,
    attemptedAt,
    kind: 'capture_attempt',
    missingReason: 'rpc_unavailable',
    provider: primary.provider,
    source: SOURCE,
    rpcMethod: REQUEST.method,
    request,
    response: { kind: firstFailure.kind },
    error: { code: firstFailure.code, message: firstFailure.message },
  }
  const verifierDoc = {
    schema: 'carry_exit_v2_missing_verifier_v1',
    caseId,
    horizonH,
    // The INSERT computes this from PostgreSQL jsonb::text in one statement.
    evidenceSha256: null,
    checkedAt: verifiedAt,
    kind: 'rpc_replay',
    finding: 'unavailable',
    provider: secondary.provider,
    source: SOURCE,
    request,
    response: { finding: 'unavailable', kind: secondFailure.kind, code: secondFailure.code },
  }
  return { caseId, horizonH, evidenceAt: attemptedAt, verifiedAt, evidenceDoc, verifierDoc }
}

/** One actual two-origin failed capture attempt during the exact target window. */
export async function probeMorphoMissingCapture({
  row,
  primary,
  secondary,
  now = () => new Date(),
}) {
  if (host(primary) === host(secondary)) throw Error('missing_origins_not_independent')
  const startAt = now().toISOString()
  if (!windowOpen(row, startAt)) return null
  const firstFailure = await failedProbe(primary)
  if (!firstFailure) return null
  const attemptedAt = now().toISOString()
  if (!windowOpen(row, attemptedAt)) return null
  const secondFailure = await failedProbe(secondary)
  if (!secondFailure) return null
  const verifiedAt = now().toISOString()
  return captureMissingDocuments({
    row,
    primary,
    secondary,
    firstFailure,
    secondFailure,
    attemptedAt,
    verifiedAt,
  })
}

/** DB computes both JSONB digests and binds the verifier to the evidence. */
export async function writeMorphoMissingReceipt(sql, receipt) {
  const result = await sql`WITH evidence AS (
      SELECT ${JSON.stringify(receipt.evidenceDoc)}::jsonb AS doc
    ), hashed AS (
      SELECT doc, encode(sha256(convert_to(doc::text, 'UTF8')), 'hex') AS digest
      FROM evidence
    ), verified AS (
      SELECT doc AS evidence_doc, digest AS evidence_sha256,
        jsonb_set(${JSON.stringify(receipt.verifierDoc)}::jsonb,
          '{evidenceSha256}', to_jsonb(digest), true) AS verifier_doc
      FROM hashed
    ) INSERT INTO carry_exit_v2_missing_receipts (
      case_id,horizon_h,evidence_kind,missing_reason,evidence_at,evidence_doc,
      evidence_sha256,verifier_kind,verified_at,verifier_doc,verifier_sha256
    ) SELECT ${receipt.caseId}::bigint, ${receipt.horizonH}::smallint,
      'capture_attempt','rpc_unavailable',${receipt.evidenceAt}::timestamptz,
      evidence_doc,evidence_sha256,'rpc_replay',${receipt.verifiedAt}::timestamptz,
      verifier_doc,encode(sha256(convert_to(verifier_doc::text,'UTF8')),'hex')
    FROM verified WHERE true
    ON CONFLICT (case_id,horizon_h) DO NOTHING RETURNING id::text`
  return result[0]?.id ?? null
}

export async function readMorphoMissingReceipt(sql, caseId, horizonH) {
  const rows = await sql`SELECT id::text, missing_reason AS "missingReason",
      evidence_kind AS "evidenceKind", verifier_kind AS "verifierKind",
      evidence_doc->>'provider' AS "captureProvider",
      verifier_doc->>'provider' AS "verifierProvider"
    FROM carry_exit_v2_missing_receipts
    WHERE case_id = ${caseId}::bigint AND horizon_h = ${horizonH}::smallint
    LIMIT 1`
  const row = rows[0]
  if (!row) return null
  if (
    row.missingReason !== 'rpc_unavailable' ||
    row.evidenceKind !== 'capture_attempt' ||
    row.verifierKind !== 'rpc_replay' ||
    row.captureProvider === row.verifierProvider
  )
    throw Error('missing_receipt_untrusted')
  return row
}
