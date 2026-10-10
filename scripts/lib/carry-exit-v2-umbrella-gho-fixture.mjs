import { readUmbrellaGhoV2SeedHolders } from './carry-exit-v2-umbrella-gho-seed.mjs'
import { UMBRELLA_GHO_ROUTE, umbrellaGhoCalldata } from './carry-exit-v2-umbrella-gho-proof.mjs'

export const umbrellaHolder = readUmbrellaGhoV2SeedHolders()[0]
export const umbrellaWord = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
export function umbrellaGhoFixture(options = {}) {
  const seconds = options.seconds ?? 1791331212,
    end = options.end ?? seconds - 12,
    window = options.window ?? 172800,
    balance = options.balance ?? 101n,
    required = options.required ?? 3n,
    q = options.q ?? 2n,
    paused = options.paused ?? false
  const inWindow = end > 0 && seconds >= end && seconds <= end + window
  const covered = options.covered ?? 101n,
    max = options.max ?? (inWindow && !paused ? covered : 0n)
  const blockNumber = options.blockNumber ?? 400
  const hash = options.hash ?? `0x${'c'.repeat(64)}`,
    parentHash = options.parentHash ?? `0x${'b'.repeat(64)}`,
    at = new Date(seconds * 1000).toISOString(),
    parentAt = new Date((seconds - 12) * 1000).toISOString(),
    observed = new Date((seconds + 3) * 1000).toISOString()
  const target = {
    targetBlock: String(blockNumber),
    targetHash: hash,
    targetBlockAt: at,
    targetParentBlock: String(blockNumber - 1),
    targetParentHash: parentHash,
    parentHeaderHash: parentHash,
    targetParentBlockAt: parentAt,
    targetObservedAt: observed,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      chainId: '1',
      finalityTag: 'finalized',
      targetAt: at,
      observedAt: observed,
      baselineHeader: { number: String(blockNumber), hash, parentHash, timestamp: at },
      targetHeader: { number: String(blockNumber), hash, parentHash, timestamp: at },
      parentHeader: { number: String(blockNumber - 1), hash: parentHash, timestamp: parentAt },
      finalizedHead: { number: String(blockNumber + 2), hash: `0x${'d'.repeat(64)}` },
    },
  }
  const calls = []
  const reply = async (request) => {
    calls.push(request)
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const number =
        request.params[0] === 'finalized' ? blockNumber : Number(BigInt(request.params[0]))
      result = {
        number: `0x${number.toString(16)}`,
        hash: number === blockNumber - 1 ? parentHash : hash,
        parentHash: number === blockNumber - 1 ? `0x${'a'.repeat(64)}` : parentHash,
        timestamp: `0x${(number === blockNumber - 1 ? seconds - 12 : seconds).toString(16)}`,
      }
    } else if (request.method === 'eth_getCode')
      result = request.params[0] === umbrellaHolder ? '0x' : '0x6001'
    else if (request.method === 'eth_getStorageAt')
      result = umbrellaWord(BigInt(options.implementation ?? UMBRELLA_GHO_ROUTE.implementation))
    else {
      const data = request.params[0].data
      const read = (name, args = []) => data === umbrellaGhoCalldata(name, args)
      if (data === '0x38d52e0f') result = umbrellaWord(BigInt(UMBRELLA_GHO_ROUTE.asset))
      else if (data.startsWith('0x70a08231')) result = umbrellaWord(balance)
      else if (data === '0x01e1d114') result = umbrellaWord(1000000000000000000000000n)
      else if (data === '0x18160ddd') result = umbrellaWord(1000000000000000000000000n)
      else if (read('previewWithdraw', [q])) result = umbrellaWord(required)
      else if (read('paused')) result = umbrellaWord(paused ? 1 : 0)
      else if (read('getCooldown')) result = umbrellaWord(1728000)
      else if (read('getUnstakeWindow')) result = umbrellaWord(172800)
      else if (read('getStakerCooldown', [umbrellaHolder]))
        result = `0x${[covered, end, window].map((v) => umbrellaWord(v).slice(2)).join('')}`
      else if (read('maxRedeem', [umbrellaHolder])) result = umbrellaWord(max)
      else if (read('getMaxSlashableAssets')) result = umbrellaWord(options.slashable ?? 1000n)
      else if (read('previewRedeem', [required])) result = umbrellaWord(options.preview ?? q)
      else if (read('previewRedeem', [balance])) result = umbrellaWord(options.claim ?? 100n)
      else if (read('decimals')) result = umbrellaWord(18)
      else if (read('redeem', [required, umbrellaHolder, umbrellaHolder])) {
        if (options.revert || paused || !inWindow || required > covered || required > balance)
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: 3, message: 'execution reverted' },
          }
        result = umbrellaWord(options.payout ?? q)
      } else throw Error(`unknown_fixture_call:${data}`)
    }
    return { jsonrpc: '2.0', id: request.id, result }
  }
  return {
    target,
    calls,
    reply,
    args: {
      ...UMBRELLA_GHO_ROUTE,
      holder: umbrellaHolder,
      assetsRaw: q.toString(),
      target,
      provider: 'fixture',
      source: 'carry_exit_v2_umbrella_gho_issuer',
      send: reply,
      now: () => new Date((seconds + 5) * 1000),
    },
  }
}
