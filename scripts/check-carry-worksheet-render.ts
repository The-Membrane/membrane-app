import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'

import DecisionWorksheet, { formatGho } from '../components/Carry/DecisionWorksheet'
import MarketBoards from '../components/Carry/MarketBoards'
import UsdePilotStrip from '../components/Carry/UsdePilotStrip'

const warnings: string[] = []
const priorError = console.error
console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '))

try {
  const render = (
    reading: { borrowApy: number; yieldApy: number; observedAt: string } | null,
    vaultCashGho?: number,
    withdrawalsPaused = false,
  ) =>
    renderToStaticMarkup(
      React.createElement(
        ChakraProvider,
        {},
        React.createElement(DecisionWorksheet, {
          chainName: 'ethereum',
          reading,
          readingLabel: reading ? 'Measured 1h ago' : null,
          cashReading:
            vaultCashGho === undefined
              ? null
              : {
                  vaultCashGho,
                  totalAssetsGho: 15_000,
                  withdrawalsPaused,
                  observedAt: '2026-09-27T14:00:00Z',
                },
          cashLabel: vaultCashGho === undefined ? null : 'Measured 1h ago',
        }),
      ),
    )

  const measured = render({ borrowApy: 0.04, yieldApy: 0.05, observedAt: '2026-09-27T14:00:00Z' })
  assert.match(measured, /\+100\.00 GHO/)
  assert.match(measured, /No complete cash-and-pause redemption reading yet/)
  assert.match(measured, /or a guaranteed withdrawal/)
  const cashWithin = render(
    { borrowApy: 0.04, yieldApy: 0.05, observedAt: '2026-09-27T14:00:00Z' },
    20_000,
  )
  assert.match(cashWithin, /15,000 GHO/)
  assert.match(cashWithin, /tested size is below the measured vault-side redemption ceiling/)
  const cashShort = render(
    { borrowApy: 0.04, yieldApy: 0.05, observedAt: '2026-09-27T14:00:00Z' },
    5_000,
  )
  assert.match(cashShort, /tested size exceeds the measured vault-side redemption ceiling/)
  const paused = render(
    { borrowApy: 0.04, yieldApy: 0.05, observedAt: '2026-09-27T14:00:00Z' },
    20_000,
    true,
  )
  assert.match(paused, /Vault withdrawals were paused at the last measurement/)
  assert.match(paused, />0 GHO</)
  assert.match(measured, /href="\/ethereum\/radar"/)
  assert.match(measured, /Scan a wallet’s tracked venues/)
  assert.match(measured, /5\.00%/)
  assert.match(measured, /4\.00%/)

  const adverse = render({ borrowApy: 0.04, yieldApy: -0.02, observedAt: '2026-09-27T14:00:00Z' })
  assert.match(adverse, /−600\.00 GHO/)
  assert.doesNotMatch(adverse, /No valid illustration/)

  assert.equal(formatGho(0.0001), '+0.00010 GHO')
  assert.equal(formatGho(1_234_567.89), '≈+1.23M GHO')

  const missing = render(null)
  assert.match(missing, /No rate reading/)
  assert.doesNotMatch(missing, /\+100\.00 GHO/)

  const board = renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      {},
      React.createElement(MarketBoards, { routesOnly: true, chainName: 'ethereum' }),
    ),
  )
  assert.ok(board.indexOf('Test a GHO carry size') < board.indexOf('Aug 2026'))
  const usde = renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      {},
      React.createElement(UsdePilotStrip, {
        nowMs: Date.parse('2026-09-27T18:00:00Z'),
        pilot: {
          matchedCapital: {
            matchedUsde: '0',
            completeWalletCount: 25,
            observedAt: '2026-09-27T17:26:47Z',
            ageSeconds: 0,
            stale: false,
          },
          destinationVaultTvl: {
            totalAssetsUsde: '1309391827.835479794839673563',
            observedAt: '2026-09-27T17:26:47Z',
            ageSeconds: 0,
            stale: false,
          },
          exactSpread: {
            borrowApy: 0.06526441888450002,
            yieldApy: 0.04804445599964633,
            spread: -0.01721996288485369,
            observedAt: '2026-09-27T17:33:11Z',
            ageSeconds: 0,
            stale: false,
          },
        },
      }),
    ),
  )
  assert.match(usde, /1\.31B USDe/)
  assert.match(usde, /−1\.72 pp/)
  assert.match(usde, /0 USDe/)
  assert.match(usde, /all depositors/)
  assert.match(usde, /not strategy TVL or a census/)
  assert.deepEqual(warnings, [])
  process.stdout.write('Carry worksheet SSR checks passed\n')
} finally {
  console.error = priorError
}
