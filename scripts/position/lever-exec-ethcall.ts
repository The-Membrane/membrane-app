// lever-exec-ethcall.ts — a READ-ONLY end-to-end check of the /position levers on mainnet.
//
// For each venue (Aave V3, Spark, Compound V3 cUSDCv3, Morpho Blue) it finds a REAL
// borrower from recent Borrow / Withdraw logs, then runs the page's own pipeline on them:
// the adapter re-read, the re-solve (buildPositionView), the execution-time chain read and
// gates (lib/position-exec/read.ts, gates.ts) and the builders (builders.ts). Then:
//
//   (a) eth_call of the ACTION alone, from the borrower, with state overrides that grant
//       the token balance and the allowance to the spender (storage slots found by probing
//       balanceOf / allowance under an override);
//   (b) eth_simulateV1 of the whole batch [approve…, action], from the borrower, with the
//       balance override only, so the approve itself grants the allowance.
//
// Nothing is signed or sent: no key, no wallet, no transaction. eth_call / eth_simulateV1
// / eth_getLogs only, on keyless public RPCs.
//
//   npx tsx scripts/position/lever-exec-ethcall.ts

import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { simulateCalls } from 'viem/actions'

import { buildPositionView } from '@/components/PositionV0/viewModel'
import { legFor, positionKeyOf, prepareLever } from '@/components/PositionV0/leverExec'
import { erc20ApproveNoReturnAbi, erc20ReadAbi } from '@/lib/position-exec/abis'
import { leverUnits } from '@/lib/position-exec/amount'
import { actionCall, leverCalls, spenderOf, tokenOf } from '@/lib/position-exec/builders'
import { leverGates } from '@/lib/position-exec/gates'
import { readLeverChain, type ExecProtocol } from '@/lib/position-exec/read'
import { revertReason } from '@/lib/position-exec/revert'
import { simulateLever } from '@/lib/position-exec/simulate'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'
import {
  ADAPTERS,
  aaveV3Adapter,
  compoundV3Adapter,
  morphoBlueAdapter,
  runAdapter,
  sparkAdapter,
} from '@/lib/position-sim/adapters'
import { getMainnetClient } from '@/lib/position-sim/rpc'
import type { ProtocolPosition } from '@/lib/position-sim/types'

const ROOT = path.resolve(__dirname, '../..')

// The Morpho adapter fetches its discovery list from /public; serve it from disk.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.startsWith('/data/')) {
    const body = readFileSync(path.join(ROOT, 'public', url), 'utf8')
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return realFetch(input, init)
}) as typeof fetch

const logs = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com', { timeout: 30_000 }),
}) as PublicClient
const sim = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com', { timeout: 30_000 }),
}) as PublicClient

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'

// ------------------------------------------------------------------ candidates

const aaveBorrow = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const cometWithdraw = parseAbiItem(
  'event Withdraw(address indexed src, address indexed to, uint256 amount)',
)
const morphoBorrow = parseAbiItem(
  'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
)

async function recent<T>(
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  span = 1_000n,
  windows = 10,
): Promise<T[]> {
  const head = await logs.getBlockNumber()
  const out: T[] = []
  for (let i = 0; i < windows; i++) {
    const to = head - BigInt(i) * span
    try {
      out.push(...(await fetchRange(to - span + 1n, to)))
    } catch (e) {
      console.warn(
        `  getLogs ${to - span + 1n}–${to} failed: ${(e as Error).message.split('\n')[0]}`,
      )
    }
  }
  return out
}

async function aaveCandidates(pool: Address, reserves: string[]): Promise<Address[]> {
  const found = await recent((fromBlock, toBlock) =>
    logs.getLogs({
      address: pool,
      event: aaveBorrow,
      args: { reserve: reserves as Address[] },
      fromBlock,
      toBlock,
    }),
  )
  return [...new Set(found.map((l) => l.args.onBehalfOf!.toLowerCase() as Address))]
}

async function cometCandidates(comet: Address): Promise<Address[]> {
  const found = await recent((fromBlock, toBlock) =>
    logs.getLogs({ address: comet, event: cometWithdraw, fromBlock, toBlock }),
  )
  return [...new Set(found.map((l) => l.args.src!.toLowerCase() as Address))]
}

async function morphoCandidates(): Promise<Address[]> {
  const list = JSON.parse(
    readFileSync(path.join(ROOT, 'public/data/oct10-2025/protocols.json'), 'utf8'),
  ).morphoBlue.markets as Record<string, { loanToken: string; collateralSymbol: string }>
  const ids = Object.entries(list)
    .filter(
      ([, m]) =>
        [USDC, USDT, DAI].includes(m.loanToken.toLowerCase()) &&
        /eth|btc/i.test(m.collateralSymbol),
    )
    .map(([id]) => id as Hex)
  const found = await recent((fromBlock, toBlock) =>
    logs.getLogs({
      address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
      event: morphoBorrow,
      args: { id: ids },
      fromBlock,
      toBlock,
    }),
  )
  return [...new Set(found.map((l) => l.args.onBehalf!.toLowerCase() as Address))]
}

// ------------------------------------------------------------------ storage slots

/** The mapping slot whose override balanceOf(holder) reads back (Solidity and Vyper key order). */
async function balanceSlot(token: Address, holder: Address): Promise<Hex | null> {
  const probe = 0x1234567890abcdefn
  for (let s = 0; s < 60; s++) {
    for (const key of [
      keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(s)]),
      ),
      keccak256(
        encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(s), holder]),
      ),
    ]) {
      try {
        const { data } = await sim.call({
          to: token,
          data: encodeFunctionData({
            abi: erc20ReadAbi,
            functionName: 'balanceOf',
            args: [holder],
          }),
          stateOverride: [{ address: token, stateDiff: [{ slot: key, value: pad(toHex(probe)) }] }],
        })
        if (
          data &&
          decodeFunctionResult({ abi: erc20ReadAbi, functionName: 'balanceOf', data }) === probe
        )
          return key
      } catch {
        /* next */
      }
    }
  }
  return null
}

async function allowanceSlot(
  token: Address,
  owner: Address,
  spender: Address,
): Promise<Hex | null> {
  const probe = 0x1234567890abcdefn
  for (let s = 0; s < 60; s++) {
    const inner = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, BigInt(s)]),
    )
    const key = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner]),
    )
    try {
      const { data } = await sim.call({
        to: token,
        data: encodeFunctionData({
          abi: erc20ReadAbi,
          functionName: 'allowance',
          args: [owner, spender],
        }),
        stateOverride: [{ address: token, stateDiff: [{ slot: key, value: pad(toHex(probe)) }] }],
      })
      if (
        data &&
        decodeFunctionResult({ abi: erc20ReadAbi, functionName: 'allowance', data }) === probe
      )
        return key
    } catch {
      /* next */
    }
  }
  return null
}

// ------------------------------------------------------------------ one venue

interface VenueCase {
  protocol: ExecProtocol
  label: string
  read: (a: Address) => Promise<ProtocolPosition[]>
  candidates: () => Promise<Address[]>
  /** Compound: only this Comet. */
  market?: string
}

const firstRepay = (p: ProtocolPosition) =>
  buildPositionView(p, TOUCH_TABLE).forecast?.byHorizon['7d'].actions.find(
    (r) => r.kind === 'repay',
  )

async function runCase(c: VenueCase): Promise<void> {
  console.log(`\n== ${c.label}`)
  const candidates = await c.candidates()
  console.log(`  ${candidates.length} recent borrowers`)
  let found = false
  for (const who of candidates.slice(0, 40)) {
    let positions: ProtocolPosition[]
    try {
      positions = await c.read(who)
    } catch (e) {
      continue
    }
    for (const p of positions) {
      if (c.market && p.marketId?.toLowerCase() !== c.market.toLowerCase()) continue
      const view = buildPositionView(p, TOUCH_TABLE)
      const row = view.forecast?.byHorizon['7d'].actions.find((r) => r.kind === 'repay')
      if (!row) continue
      const leg = legFor(p, row)
      const amount = leverUnits(row.amount, row.amountDecimals, leg.decimals)
      const read = await readLeverChain(sim, {
        protocol: c.protocol,
        kind: 'repay',
        owner: who,
        token: leg.address,
        amount,
        marketId: p.marketId,
        block: p.provenance.block ? BigInt(p.provenance.block) : null,
      })
      const gates = leverGates({
        kind: 'repay',
        symbol: leg.symbol,
        token: leg.address,
        legDecimals: leg.decimals,
        amount,
        shown: 2,
        read,
      })
      const venueGates = gates.filter((g) => g.id !== 'balance')
      if (venueGates.some((g) => !g.ok)) {
        console.log(
          `  ${short(who)} ${row.action}: gate ${venueGates.find((g) => !g.ok)!.text}; next`,
        )
        continue
      }
      const action = actionCall(read.action)
      const token = tokenOf(read.action)
      const spender = spenderOf(read.action)
      console.log(
        `  borrower ${short(who)} · ${positionKeyOf(p).slice(0, 40)} · block ${p.provenance.block}`,
      )
      console.log(`  lever    ${row.text}`)
      console.log(
        `  amount   ${amount} units of ${leg.symbol} (${leg.decimals} decimals) · balance ${read.balance} · allowance ${read.allowance}`,
      )
      console.log(
        `  action   ${action.functionName} on ${short(action.address)} · spender ${short(spender)}`,
      )

      const bal = await balanceSlot(token, who)
      const alw = await allowanceSlot(token, who, spender)
      if (!bal || !alw) {
        console.log(`  storage slots not found (balance ${bal}, allowance ${alw}); next`)
        continue
      }
      const big = pad(toHex(amount * 10n))
      const data = encodeFunctionData({
        abi: action.abi,
        functionName: action.functionName,
        args: action.args as never,
      })
      // (a) the action alone, balance and allowance granted by override
      try {
        const res = await sim.call({
          account: who,
          to: action.address,
          data,
          stateOverride: [
            {
              address: token,
              stateDiff: [
                { slot: bal, value: big },
                { slot: alw, value: big },
              ],
            },
          ],
        })
        let decoded = ''
        try {
          decoded = res.data
            ? ` · returns ${String(decodeFunctionResult({ abi: action.abi, functionName: action.functionName, data: res.data }))}`
            : ''
        } catch {
          decoded = ` · returns ${res.data}`
        }
        console.log(`  (a) eth_call ${action.functionName}: OK, no revert${decoded}`)
      } catch (e) {
        console.log(`  (a) eth_call ${action.functionName}: REVERT ${revertReason(e)}`)
      }
      // (b) the whole batch from a zero allowance: [approve(amount), action], balance granted.
      // (c) the zero-first path: a smaller allowance standing (1 unit), so
      //     [approve(0), approve(amount), action] — the order USDT requires.
      for (const [tag, standing] of [
        ['(b)', 0n],
        ['(c)', 1n],
      ] as const) {
        const calls = leverCalls(read.action, standing)
        try {
          const { results } = await simulateCalls(sim, {
            account: who,
            calls: calls.map((x) => ({
              to: x.address,
              abi: x.abi,
              functionName: x.functionName,
              args: x.args ?? [],
            })),
            stateOverrides: [
              {
                address: token,
                stateDiff: [
                  { slot: bal, value: big },
                  { slot: alw, value: pad(toHex(standing)) },
                ],
              },
            ],
          } as Parameters<typeof simulateCalls>[1])
          console.log(
            `  ${tag} eth_simulateV1 allowance ${standing} → [${calls.map((x) => `${x.functionName}(${x.functionName === 'approve' ? String(x.args?.[1]) : '…'})`).join(', ')}]: ${results
              .map(
                (r) =>
                  `${r.status}${r.status === 'success' ? ` ${r.gasUsed} gas` : ` ${revertReason(r.error)}`}`,
              )
              .join(' · ')}`,
          )
        } catch (e) {
          console.log(`  ${tag} eth_simulateV1: unavailable ${revertReason(e)}`)
        }
      }
      if (token.toLowerCase() === USDT) {
        // Why (c) exists: on USDT a non-zero → non-zero approve reverts.
        try {
          await sim.call({
            account: who,
            to: token,
            data: encodeFunctionData({
              abi: erc20ApproveNoReturnAbi,
              functionName: 'approve',
              args: [spender, amount],
            }),
            stateOverride: [{ address: token, stateDiff: [{ slot: alw, value: pad(toHex(1n)) }] }],
          })
          console.log('  (d) USDT approve(amount) over a standing 1: did NOT revert')
        } catch (e) {
          console.log(
            `  (d) USDT approve(amount) over a standing 1: reverts (${revertReason(e).split('\n')[0]}), so the reset to 0 is needed`,
          )
        }
      }
      await appPath(c, who, p, row, '(e)')
      found = true
      break
    }
    if (found) break
  }
  if (!found) {
    console.log('  no candidate with a repay lever found')
    return
  }
  // (f) the page's own path on the first recent borrower who HOLDS the repay amount, so every gate passes.
  for (const who of candidates.slice(0, 120)) {
    let positions: ProtocolPosition[]
    try {
      positions = await c.read(who)
    } catch {
      continue
    }
    for (const p of positions) {
      if (c.market && p.marketId?.toLowerCase() !== c.market.toLowerCase()) continue
      const row = buildPositionView(p, TOUCH_TABLE).forecast?.byHorizon['7d'].actions.find(
        (r) => r.kind === 'repay',
      )
      if (!row) continue
      const leg = legFor(p, row)
      const bal = await sim.readContract({
        address: leg.address as Address,
        abi: erc20ReadAbi,
        functionName: 'balanceOf',
        args: [who],
      })
      if (bal < leverUnits(row.amount, row.amountDecimals, leg.decimals)) continue
      await appPath(c, who, p, row, '(f)')
      return
    }
  }
  console.log('  (f) no recent borrower holds their repay amount')
}

async function appPath(
  c: VenueCase,
  who: Address,
  p: ProtocolPosition,
  row: NonNullable<ReturnType<typeof firstRepay>>,
  tag: string,
): Promise<void> {
  // The page's own path, unchanged and without overrides: prepareLever (re-read,
  // re-solve, chain read, gates, calls) then simulateLever when the gates pass.
  const view = buildPositionView(p, TOUCH_TABLE)
  const prepared = await prepareLever(
    {
      owner: who,
      positionKey: positionKeyOf(p),
      protocol: c.protocol,
      title: view.title,
      kind: 'repay',
      targetPct: row.targetPct,
      level: row.level,
      horizon: '7d',
      stale: false,
      row,
      openedAt: Date.now(),
    },
    {
      readAdapter: (id, o) => runAdapter(ADAPTERS.find((a) => a.id === id)!, o),
      client: getMainnetClient(),
      table: TOUCH_TABLE,
    },
  )
  if (prepared.kind === 'gone') {
    console.log(`  ${tag} app path ${short(who)}: gone · ${prepared.reason}`)
    return
  }
  const blocked = prepared.gates.find((g) => !g.ok)
  if (blocked) {
    console.log(
      `  ${tag} app path ${short(who)}: ${prepared.row.action} · gate blocks, as the slip would: ${blocked.text}`,
    )
    return
  }
  const r = await simulateLever(getMainnetClient(), who, prepared.calls)
  console.log(
    `  ${tag} app path ${short(who)}: ${prepared.row.action} · gates pass · [${prepared.calls.map((x) => x.functionName).join(', ')}] · simulateLever ${
      r.ok
        ? `passes via ${r.method}, gas ${r.gas.join(' + ')} → ${r.bufferedGas} buffered`
        : `step ${r.step + 1}: ${r.reason}`
    }`,
  )
}

async function main() {
  const cases: VenueCase[] = [
    {
      protocol: 'aave-v3',
      label: 'Aave V3',
      read: (a) => aaveV3Adapter.read(a),
      candidates: () => aaveCandidates('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', [USDC, USDT]),
    },
    {
      protocol: 'spark',
      label: 'Spark',
      read: (a) => sparkAdapter.read(a),
      candidates: () =>
        aaveCandidates('0xC13e21B648A5Ee794902342038FF3aDAB66BE987', [USDC, USDT, DAI]),
    },
    {
      protocol: 'compound-v3',
      label: 'Compound V3 cUSDCv3',
      read: (a) => compoundV3Adapter.read(a),
      candidates: () => cometCandidates('0xc3d688B66703497DAA19211EEdff47f25384cdc3'),
      market: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    },
    {
      protocol: 'morpho-blue',
      label: 'Morpho Blue',
      read: (a) => morphoBlueAdapter.read(a),
      candidates: morphoCandidates,
    },
  ]
  const only = process.argv[2]
  for (const c of cases) {
    if (only && c.protocol !== only && c.label !== only) continue
    try {
      await runCase(c)
    } catch (e) {
      console.log(`  ${c.label} failed: ${(e as Error).message}`)
    }
  }
}

void main()
