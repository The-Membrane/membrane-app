// Only fixed labels leave the process. RPC errors can contain credentialed URLs.
const CONFIGURED_RPC_MISSING = new Set([
  'Exactly one RPC URL required',
  'Configured RPC index unavailable',
  'One named RPC host required',
])
const DISK_RESERVE = new Set([
  'Vault flow disk reserve reached',
  'Near-live vault flow disk reserve reached',
])
const BLOCK_IDENTITY_OR_FINALITY = new Set([
  'Wrong RPC chain ID',
  'Quote block is not finalized on flow RPC',
  'Flow RPC quote block hash mismatch',
  'Flow RPC quote block hash drift',
  'Existing flow receipt quote block hash mismatch',
  'Vault flow receipt quote block hash mismatch',
  'Latest quote checkpoint changed during vault flow catch-up',
  'First live block not finalized on plan RPC',
  'First live RPC header disagrees with sealed receipt',
  'First live parent hash bridge mismatch',
  'Plan boundary hash drift',
  'RPC archive block number mismatch',
  'RPC block number mismatch',
  'RPC event block hash mismatch',
  'Canonical range boundary drift',
])
const RECEIPT_OR_PLAN_INVARIANT = new Set([
  'Vault flow receipt SHA mismatch',
  'Invalid vault flow receipt',
  'Vault flow coverage gap or overlap',
  'Vault flow range timestamp did not advance',
  'Vault flow frontier is not aligned to latest quote checkpoint',
  'Historical scan plan mismatch',
  'Historical coverage outside frozen scan bounds',
  'Near-live physical or logical seal mismatch',
  'Near-live plan seal or boundary mismatch',
  'Near-live receipt boundary parent hash mismatch',
  'Near-live boundary witness mismatch',
  'Near-live first receipt disagrees with plan',
  'Near-live receipt exceeds plan or predates plan',
  'Near-live boundary witness count mismatch',
  'Near-live receipt count drift',
])
const TRANSPORT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])
const TRANSPORT_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'SocketError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'FetchError',
])

function safeGet(value, key) {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}

// A diagnostic hint, not a determination of provider or data correctness.
// No messages, URLs, hosts, stack traces, or arbitrary error fields are returned.
export function classifyVaultFlowError(error) {
  const chain = []
  const seen = new Set()
  for (let current = error; current && chain.length < 5 && !seen.has(current); ) {
    seen.add(current)
    chain.push(current)
    current = safeGet(current, 'cause')
  }
  if (
    chain.some((entry) =>
      [
        safeGet(entry, 'status'),
        safeGet(entry, 'statusCode'),
        safeGet(safeGet(entry, 'response'), 'status'),
      ].some((status) => status === 429 || status === '429'),
    )
  )
    return 'rate_limited'
  for (const entry of chain) {
    const message = safeGet(entry, 'message')
    if (DISK_RESERVE.has(message)) return 'disk_reserve'
    if (CONFIGURED_RPC_MISSING.has(message)) return 'configured_rpc_missing'
    if (BLOCK_IDENTITY_OR_FINALITY.has(message)) return 'block_identity_or_finality'
    if (RECEIPT_OR_PLAN_INVARIANT.has(message)) return 'receipt_or_plan_invariant'
    if (
      TRANSPORT_CODES.has(safeGet(entry, 'code')) ||
      TRANSPORT_NAMES.has(safeGet(entry, 'name')) ||
      (safeGet(entry, 'name') === 'TypeError' && message === 'fetch failed')
    )
      return 'transport_or_timeout'
  }
  return 'unknown'
}
