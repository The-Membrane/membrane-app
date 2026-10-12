import type { AbiEvent } from 'viem'
import { describe, expect, it } from 'vitest'

import { decodeVenueLog, venueLogFilters } from '@/lib/exitQueue/decode'
import { ABI, topic, VENUES } from '@/lib/exitQueue/venues'

import { addr, def, mkLog } from './exitQueueFixtures'

// topic0 values observed in mainnet eth_getLogs output (or a known tx for the rare
// parameter events) on 2026-10-05. A typo in an ABI string changes the hash and fails here.
const ONCHAIN_TOPIC0: Array<[string, string]> = [
  ['lido.requested', '0xf0cb471f23fb74ea44b8252eb1881a2dca546288d9f6e90d1a0e82fe0ed342ab'],
  ['lido.finalized', '0x197874c72af6a06fb0aa4fab45fd39c7cb61ac0992159872dc3295207da7e9eb'],
  ['lido.claimed', '0x6ad26c5e238e7d002799f9a5db07e81ef14e37386ae03496d7a7ef04713e145b'],
  ['etherfi.created', '0xe8c5062a529781e00d69c769270eb1f1ae6feb921aa80d238bb7b4b919b1ab22'],
  ['etherfi.claimed', '0x31712d805743a128cf0ab8cdf453da51797d2e6f674bd1e5d77d92e1518e4921'],
  ['kelp.queued', '0xd1ff36888873897951eaf991bca7db625b8ed70bf2b0d54441907bdab02b08d7'],
  ['kelp.finalized', '0xca13475b00c46ee0ce4a479bd18ed747ff89395e96e93779ba7f18cbe1735fb4'],
  ['kelp.unlocked', '0x72e38cd9e650a56d27bba7e1a9a8d6f77dc5cc382bb38a7e56f4f1e845be910d'],
  ['kelp.delayBlocks', '0x2e56f6093fb947ef7b002dcdf68fcb314c466a1917eac6fa5b00879a7f5de63f'],
  ['ethena.withdraw', '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db'],
  ['ethena.cooldown', '0x180eacdf7dbaeecaa983d93173b4285db2f2c0de0044697e1f932bbbb73dcaa6'],
  ['ethena.transfer', '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
  ['maple.created', '0x0f07843fcc5047a6c0a2af35eec5eab563fa21efdc4473efb2303d6c2f8ec6f8'],
  ['maple.processed', '0x9fa30b5e853dc5c952287d8de37ee1d3222a7fea5494cc39f99a26b12e56e80f'],
  ['maple.removed', '0x5fa4d8243d9549d33d615899224efcef51bfcacb970a31f68862ce74c858dbf0'],
]

const lido = def('lido-steth')
const etherfi = def('etherfi-weeth')
const kelp = def('kelp-rseth')
const ethena = def('sUSDe')
const maple = def('maple-syrupusdc')
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

describe('exit-queue ABIs', () => {
  it.each(ONCHAIN_TOPIC0)('%s matches the on-chain topic0', (path, expected) => {
    const [venue, name] = path.split('.') as [keyof typeof ABI, string]
    expect(topic((ABI[venue] as unknown as Record<string, AbiEvent>)[name])).toBe(expected)
  })

  it('lists venues in data-need priority order with unique keys', () => {
    expect(VENUES.map((v) => v.key)).toEqual([
      'lido-steth',
      'beacon-exit',
      'etherfi-weeth',
      'kelp-rseth',
      'sUSDe',
      'maple-syrupusdc',
    ])
    expect(new Set(VENUES.map((v) => v.priority)).size).toBe(VENUES.length)
  })
})

describe('decodeVenueLog', () => {
  it('Lido: request, range finalization, claim, bunker mode', () => {
    const q = lido.contracts.queue
    expect(
      decodeVenueLog(
        lido,
        mkLog(
          q,
          ABI.lido.requested,
          {
            requestId: 7n,
            requestor: addr(1),
            owner: addr(2),
            amountOfStETH: 5n * 10n ** 18n,
            amountOfShares: 4n * 10n ** 18n,
          },
          { block: 1_000 },
        ),
      ),
    ).toMatchObject({
      kind: 'request',
      id: '7',
      owner: addr(2),
      amount: 5n * 10n ** 18n,
      block: 1_000,
    })
    expect(
      decodeVenueLog(
        lido,
        mkLog(
          q,
          ABI.lido.finalized,
          {
            from: 3n,
            to: 9n,
            amountOfETHLocked: 1n,
            sharesToBurn: 1n,
            timestamp: 1n,
          },
          { block: 1_010 },
        ),
      ),
    ).toMatchObject({ kind: 'finalize_range', fromId: 3n, toId: 9n })
    expect(
      decodeVenueLog(
        lido,
        mkLog(
          q,
          ABI.lido.claimed,
          { requestId: 7n, owner: addr(2), receiver: addr(3), amountOfETH: 1n },
          { block: 1_020 },
        ),
      ),
    ).toMatchObject({ kind: 'claim', id: '7' })
    expect(
      decodeVenueLog(lido, mkLog(q, ABI.lido.bunkerOn, { _sinceTimestamp: 1n }, { block: 1_030 })),
    ).toMatchObject({ kind: 'param', param: 'bunkerMode', to: true })
  })

  it('ether.fi: created, claimed, invalidated', () => {
    const q = etherfi.contracts.queue
    expect(
      decodeVenueLog(
        etherfi,
        mkLog(
          q,
          ABI.etherfi.created,
          { requestId: 12, amountOfEEth: 9n, shareOfEEth: 8n, owner: addr(5) },
          { block: 1_000 },
        ),
      ),
    ).toMatchObject({ kind: 'request', id: '12', owner: addr(5), amount: 9n })
    expect(
      decodeVenueLog(
        etherfi,
        mkLog(
          q,
          ABI.etherfi.claimed,
          { requestId: 12, amountOfEEth: 9n, shareOfEEth: 8n, owner: addr(5) },
          { block: 1_001 },
        ),
      ),
    ).toMatchObject({ kind: 'claim', id: '12' })
    expect(
      decodeVenueLog(
        etherfi,
        mkLog(q, ABI.etherfi.invalidated, { requestId: 12 }, { block: 1_002 }),
      ),
    ).toMatchObject({ kind: 'remove', id: '12' })
  })

  it('Kelp: per-asset nonce ids, amount-carrying claims, unlock hints, delay param', () => {
    const q = kelp.contracts.queue
    expect(
      decodeVenueLog(
        kelp,
        mkLog(
          q,
          ABI.kelp.queued,
          { withdrawer: addr(9), asset: ETH, rsETHUnstaked: 3n, userNonce: 41n },
          { block: 1_000 },
        ),
      ),
    ).toMatchObject({ kind: 'request', id: `${ETH}:41`, asset: ETH, owner: addr(9), amount: 3n })
    expect(
      decodeVenueLog(
        kelp,
        mkLog(
          q,
          ABI.kelp.finalized,
          { withdrawer: addr(9), asset: ETH, amountBurned: 3n, amountReceived: 2n },
          { block: 1_001 },
        ),
      ),
    ).toMatchObject({ kind: 'claim_fifo', owner: addr(9), asset: ETH, amount: 3n })
    expect(
      decodeVenueLog(
        kelp,
        mkLog(
          q,
          ABI.kelp.unlocked,
          { asset: ETH, rsEthAmount: 1n, assetAmount: 1n, rsEThPrice: 1n, assetPrice: 1n },
          { block: 1_002 },
        ),
      ),
    ).toMatchObject({ kind: 'unlock_hint', asset: ETH })
    expect(
      decodeVenueLog(
        kelp,
        mkLog(q, ABI.kelp.delayBlocks, { withdrawalDelayBlocks: 57_600n }, { block: 1_003 }),
      ),
    ).toMatchObject({ kind: 'param', param: 'withdrawalDelayBlocks', to: 57_600 })
  })

  it('sUSDe: only withdrawals INTO the silo are queue requests', () => {
    const v = ethena.contracts.vault
    const intoSilo = mkLog(
      v,
      ABI.ethena.withdraw,
      {
        sender: addr(4),
        receiver: ethena.contracts.silo,
        owner: addr(4),
        assets: 100n,
        shares: 90n,
      },
      { block: 1_000, logIndex: 3 },
    )
    expect(decodeVenueLog(ethena, intoSilo)).toMatchObject({
      kind: 'request',
      owner: addr(4),
      amount: 100n,
    })
    const instant = mkLog(
      v,
      ABI.ethena.withdraw,
      { sender: addr(4), receiver: addr(4), owner: addr(4), assets: 100n, shares: 90n },
      { block: 1_000 },
    )
    expect(decodeVenueLog(ethena, instant)).toBeNull()
  })

  it('sUSDe: cooldown change carries from and to; silo payouts are amount claims', () => {
    expect(
      decodeVenueLog(
        ethena,
        mkLog(
          ethena.contracts.vault,
          ABI.ethena.cooldown,
          { previousDuration: 604_800, newDuration: 86_400 },
          { block: 1_000 },
        ),
      ),
    ).toMatchObject({ kind: 'param', param: 'cooldownDuration', from: 604_800, to: 86_400 })
    const usde = ethena.contracts.usde
    expect(
      decodeVenueLog(
        ethena,
        mkLog(
          usde,
          ABI.ethena.transfer,
          { from: ethena.contracts.silo, to: addr(4), value: 100n },
          { block: 1_001 },
        ),
      ),
    ).toMatchObject({ kind: 'claim_amount', receiver: addr(4), amount: 100n })
    expect(
      decodeVenueLog(
        ethena,
        mkLog(
          usde,
          ABI.ethena.transfer,
          { from: addr(8), to: addr(4), value: 100n },
          { block: 1_001 },
        ),
      ),
    ).toBeNull()
  })

  it('Maple: created, processed, removed, manual', () => {
    const q = maple.contracts.queue
    const kinds = [
      mkLog(q, ABI.maple.created, { requestId: 5n, owner: addr(6), shares: 10n }, { block: 1_000 }),
      mkLog(
        q,
        ABI.maple.processed,
        { requestId: 5n, owner: addr(6), shares: 10n, assets: 11n },
        { block: 1_001 },
      ),
      mkLog(q, ABI.maple.removed, { requestId: 5n }, { block: 1_001, logIndex: 1 }),
      mkLog(
        q,
        ABI.maple.manual,
        { requestId: 5n, owner: addr(6), sharesAdded: 10n },
        { block: 1_001, logIndex: 2 },
      ),
    ].map((l) => decodeVenueLog(maple, l)?.kind)
    expect(kinds).toEqual(['request', 'process', 'remove', 'manual'])
  })

  it('returns null for an unknown topic and throws on a malformed known log', () => {
    const q = lido.contracts.queue
    const good = mkLog(
      q,
      ABI.lido.claimed,
      { requestId: 1n, owner: addr(1), receiver: addr(1), amountOfETH: 1n },
      { block: 1 },
    )
    expect(decodeVenueLog(lido, { ...good, topics: [`0x${'ab'.repeat(32)}`] })).toBeNull()
    expect(() => decodeVenueLog(lido, { ...good, data: '0x01' })).toThrow()
  })
})

describe('venueLogFilters', () => {
  it('sUSDe: the silo sits in the receiver slot of Withdraw and the from slot of Transfer', () => {
    const silo = `0x${ethena.contracts.silo.slice(2).toLowerCase().padStart(64, '0')}`
    const [withdraws, cooldowns, payouts] = venueLogFilters(ethena)
    expect(withdraws.topics).toEqual([[topic(ABI.ethena.withdraw)], null, silo])
    expect(cooldowns.topics).toEqual([[topic(ABI.ethena.cooldown)]])
    expect(payouts).toMatchObject({
      address: ethena.contracts.usde,
      topics: [[topic(ABI.ethena.transfer)], silo],
    })
  })

  it('beacon has no log filters', () => {
    expect(venueLogFilters(def('beacon-exit'))).toEqual([])
  })
})
