import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { readCurveMarketCurve, readPsmMarketCurve, readVenueNav } from './depthCurve.mjs'

const config = JSON.parse(
  readFileSync(new URL('../../tools/venue-recorder.config.json', import.meta.url), 'utf8'),
)
const byName = (name) => config.venues.find((venue) => venue.name === name)
const scrv = byName('scrvUSD')
const curve = scrv.depthMarkets.find((market) => market.enabled)
const susds = byName('sUSDS')
const psm = susds.depthMarkets.find((market) => market.enabled)
const blockNumber = 26_069_593n

test('vault NAV refuses a mismatched underlying rather than valuing the wrong asset at $1', async () => {
  const client = {
    readContract: async ({ functionName }) => {
      if (functionName === 'decimals') return 18
      if (functionName === 'asset') return susds.underlying
      if (functionName === 'convertToAssets' || functionName === 'previewRedeem') return 10n ** 18n
      throw new Error(`unexpected ${functionName}`)
    },
  }
  assert.equal(await readVenueNav(client, scrv, blockNumber), null)
})

test('vault NAV refuses missing decimals and zero assets', async () => {
  const client = {
    readContract: async ({ address, functionName }) => {
      if (functionName === 'decimals') {
        if (address.toLowerCase() === scrv.underlying.toLowerCase()) throw new Error('unavailable')
        return scrv.decimals
      }
      if (functionName === 'asset') return scrv.underlying
      if (functionName === 'convertToAssets') return 0n
      if (functionName === 'previewRedeem') return 0n
      throw new Error(`unexpected ${functionName}`)
    },
  }
  assert.equal(await readVenueNav(client, scrv, blockNumber), null)
  const zeroAssetsClient = {
    readContract: async ({ functionName }) => {
      if (functionName === 'decimals') return scrv.decimals
      if (functionName === 'asset') return scrv.underlying
      if (functionName === 'convertToAssets' || functionName === 'previewRedeem') return 0n
      throw new Error(`unexpected ${functionName}`)
    },
  }
  assert.equal(await readVenueNav(zeroAssetsClient, scrv, blockNumber), null)
})

test('Curve route refuses a pool whose on-chain coins differ from configured tokens', async () => {
  const client = {
    readContract: async ({ functionName, args }) => {
      if (functionName === 'coins') return args[0] === 0n ? susds.underlying : curve.token1
      throw new Error(`unexpected ${functionName}`)
    },
  }
  const result = await readCurveMarketCurve(client, scrv, curve, null, blockNumber)
  assert.match(result.error, /differ from configured route tokens/)
})

test('Curve route refuses missing token decimals and zero NAV', async () => {
  const client = {
    readContract: async ({ functionName, args }) => {
      if (functionName === 'coins') return args[0] === 0n ? curve.token0 : curve.token1
      throw new Error(`unexpected ${functionName}`)
    },
  }
  assert.match(
    (await readCurveMarketCurve(client, scrv, curve, { navUsd: 1, redeemRatio: 1 }, blockNumber))
      .error,
    /pool token decimals read failed/,
  )
  const withDecimals = {
    readContract: async (args) =>
      args.functionName === 'decimals'
        ? 18
        : args.functionName === 'balances'
          ? 1_000_000n * 10n ** 18n
          : client.readContract(args),
  }
  assert.match(
    (
      await readCurveMarketCurve(
        withDecimals,
        scrv,
        curve,
        { navUsd: 0, redeemRatio: 1 },
        blockNumber,
      )
    ).error,
    /venue NAV.*invalid/,
  )
})

test('PSM route refuses missing on-chain gem and pocket identity', async () => {
  const client = {
    readContract: async ({ address, functionName }) => {
      if (address === psm.wrapper) {
        if (functionName === 'psm') return psm.address
        if (functionName === 'pocket') return psm.buffer
        if (functionName === 'usds') return susds.underlying
      }
      if (functionName === 'tout') return 0n
      throw new Error('identity read unavailable')
    },
  }
  const result = await readPsmMarketCurve(client, susds, psm, null, blockNumber)
  assert.match(result.error, /gem\(\) missing/)
})

test('PSM route refuses missing buffer decimals', async () => {
  const client = {
    readContract: async ({ address, functionName }) => {
      if (address === psm.wrapper) {
        if (functionName === 'psm') return psm.address
        if (functionName === 'pocket') return psm.buffer
        if (functionName === 'usds') return susds.underlying
      }
      if (functionName === 'tout') return 0n
      if (functionName === 'gem') return psm.bufferToken
      if (functionName === 'pocket') return psm.buffer
      throw new Error('unavailable')
    },
  }
  assert.match(
    (await readPsmMarketCurve(client, susds, psm, { navUsd: 1, redeemRatio: 1 }, blockNumber))
      .error,
    /buffer token decimals read failed/,
  )
})

test('PSM route with matched on-chain identity retains a quoted curve', async () => {
  const client = {
    readContract: async ({ address, functionName }) => {
      if (address === psm.wrapper) {
        if (functionName === 'psm') return psm.address
        if (functionName === 'pocket') return psm.buffer
        if (functionName === 'usds') return susds.underlying
      }
      if (functionName === 'tout') return 0n
      if (functionName === 'gem') return psm.bufferToken
      if (functionName === 'pocket') return psm.buffer
      if (functionName === 'decimals') return 6
      if (functionName === 'balanceOf') return 1_000_000n * 10n ** 6n
      throw new Error(`unexpected ${functionName}`)
    },
  }
  const result = await readPsmMarketCurve(
    client,
    susds,
    psm,
    { navUsd: 1, redeemRatio: 1 },
    blockNumber,
  )
  assert.equal(result.error, undefined)
  assert.equal(result.points.length, 7)
  assert.equal(result.points[0].capacityUsd, 1_000_000)
})

test('PSM route refuses missing wrapper and each mismatched wrapper identity', async () => {
  const client = {
    readContract: async ({ address, functionName }) => {
      if (address === psm.wrapper) {
        if (functionName === 'psm') return psm.address
        if (functionName === 'pocket') return psm.buffer
        if (functionName === 'usds') return susds.underlying
      }
      throw new Error(`unexpected ${functionName}`)
    },
  }
  assert.match(
    (await readPsmMarketCurve(client, susds, { ...psm, wrapper: undefined }, null, blockNumber))
      .error,
    /wrapper address missing/,
  )
  for (const badFunction of ['psm', 'pocket', 'usds']) {
    const bad = {
      readContract: async (call) =>
        call.address === psm.wrapper && call.functionName === badFunction
          ? '0x0000000000000000000000000000000000000099'
          : client.readContract(call),
    }
    assert.match(
      (await readPsmMarketCurve(bad, susds, psm, null, blockNumber)).error,
      /wrapper (psm|pocket|usds)\(\) missing or differs/,
    )
  }
})

test('PSM route distinguishes a 100% fee from the max-uint halt sentinel', async () => {
  const client = {
    readContract: async ({ address, functionName }) => {
      if (address === psm.wrapper) {
        if (functionName === 'psm') return psm.address
        if (functionName === 'pocket') return psm.buffer
        if (functionName === 'usds') return susds.underlying
      }
      if (functionName === 'tout') return 10n ** 18n
      if (functionName === 'gem') return psm.bufferToken
      if (functionName === 'pocket') return psm.buffer
      if (functionName === 'decimals') return 6n
      if (functionName === 'balanceOf') return 1_000_000n * 10n ** 6n
      throw new Error(`unexpected ${functionName}`)
    },
  }
  const fee = await readPsmMarketCurve(
    client,
    susds,
    psm,
    { navUsd: 1, redeemRatio: 1 },
    blockNumber,
  )
  assert.equal(fee.meta.halted, false)
  const halted = {
    readContract: (call) =>
      call.functionName === 'tout' ? 2n ** 256n - 1n : client.readContract(call),
  }
  const result = await readPsmMarketCurve(
    halted,
    susds,
    psm,
    { navUsd: 1, redeemRatio: 1 },
    blockNumber,
  )
  assert.equal(result.meta.halted, true)
  assert.equal(result.points[0].capacityUsd, 0)
})
