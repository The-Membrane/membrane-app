// Synthetic JSON-RPC fixture shared by the offline workflow tests and the
// explicitly opt-in SQL rollback integration check. Never use as market data.
import assert from 'node:assert/strict'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'

export const syntheticRoute = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'susds')
const holder = `0x${'1'.repeat(40)}`
const blockHash = `0x${'c'.repeat(64)}`
const parentHash = `0x${'b'.repeat(64)}`
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`

function target() {
  return {
    targetBlock: '400',
    targetHash: blockHash,
    targetBlockAt: '2026-09-30T00:00:12.000Z',
    targetParentBlock: '399',
    targetParentHash: parentHash,
    parentHeaderHash: parentHash,
    targetParentBlockAt: '2026-09-30T00:00:00.000Z',
    targetObservedAt: '2026-09-30T00:00:15.000Z',
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      chainId: '1',
      finalityTag: 'finalized',
      targetAt: '2026-09-30T00:00:00.000001Z',
      observedAt: '2026-09-30T00:00:15.000Z',
      targetHeader: {
        number: '400',
        hash: blockHash,
        parentHash,
        timestamp: '2026-09-30T00:00:12.000Z',
      },
      parentHeader: { number: '399', hash: parentHash, timestamp: '2026-09-30T00:00:00.000Z' },
      finalizedHead: { number: '402', hash: `0x${'d'.repeat(64)}` },
    },
  }
}

function responseFor(request, alteredWithdraw = false) {
  if (request.method === 'eth_getBlockByNumber') {
    const finalized = request.params[0] === 'finalized'
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        number: finalized ? '0x192' : '0x190',
        hash: finalized ? `0x${'d'.repeat(64)}` : blockHash,
        parentHash,
        timestamp: finalized ? '0x65100010' : '0x65100000',
      },
    }
  }
  if (request.method === 'eth_getCode') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: request.params[0] === holder ? '0x' : '0x6001',
    }
  }
  assert.equal(request.method, 'eth_call')
  const selector = request.params[0].data.slice(0, 10)
  const result =
    selector === '0x38d52e0f'
      ? word(BigInt(syntheticRoute.asset))
      : selector === '0x70a08231'
        ? word(2_000_000)
        : selector === '0x0a28a477'
          ? word(1_200_000)
          : selector === '0xb460af94'
            ? word(alteredWithdraw ? 900_000 : 1_000_000)
            : null
  assert.notEqual(result, null)
  return { jsonrpc: '2.0', id: request.id, result }
}

export function syntheticVerifiedMeasurementFixture(alteredSecondary = false) {
  const calls = { capture: [], primary: [], secondary: [] }
  const transport =
    (name, alteredWithdraw = false) =>
    async (request) => {
      calls[name].push(request)
      return responseFor(request, alteredWithdraw)
    }
  const input = {
    routeKey: syntheticRoute.routeKey,
    destination: syntheticRoute.destination,
    asset: syntheticRoute.asset,
    holder,
    assetsRaw: '1000000',
    target: target(),
    provider: 'synthetic-collector',
    source: 'synthetic-test',
    send: transport('capture'),
    primary: { url: 'https://primary.example/rpc', request: transport('primary') },
    secondary: {
      url: 'https://secondary.example/rpc',
      request: transport('secondary', alteredSecondary),
    },
    now: () => new Date('2026-09-30T00:00:20.000Z'),
  }
  return { input, calls }
}
