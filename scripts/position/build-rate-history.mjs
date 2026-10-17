// Build the bounded, measured-only /position rate table. No forecasts or user flows.
// MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets node scripts/position/build-rate-history.mjs
// Defaults to the sibling membrane-datasets checkout; ROOT remains a compatibility alias.
// --check compares the exact deterministic output without rewriting the checked-in file.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MAX_DAYS = 90
const DAY = 86400
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
export const ASSETS = {
  USDC: {
    key: 'aave-core-usdc',
    token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    aToken: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    debtToken: '0x72e95b8931767c79ba4eee721354d6e99a61d004',
  },
  USDT: {
    key: 'aave-core-usdt',
    token: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    aToken: '0x23878914efe38d27c4d67ab83ed1b93a74d4086a',
    debtToken: '0x6df1c1e379bc5a00a7b4c6e67a203333772f45a8',
  },
}
const INPUTS = [
  'depositor-balances/reserve-state.csv',
  'depositor-balances/blocks.csv',
  'depositor-balances/PROVENANCE.md',
  'venue-stress/summary.json',
  'venue-stress/PROVENANCE.md',
]
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fail = (message) => {
  throw new Error(`rate history: ${message}`)
}
const lower = (value) => String(value ?? '').toLowerCase()
const dateTs = (date) => Date.parse(`${date}T00:00:00Z`) / 1000
const dateOf = (timestamp) => new Date(timestamp * 1000).toISOString().slice(0, 10)

/** Pin the last input-changing revision; unrelated study commits do not rewrite this artifact. */
export function datasetCommit(root, paths = INPUTS) {
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...paths], {
    encoding: 'utf8',
  })
  if (status.trim()) fail('input files have uncommitted changes')
  const commit = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', ...paths], {
    encoding: 'utf8',
  }).trim()
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) fail('datasets commit')
  return commit
}

/** RFC 4180 subset including quoted commas, quotes and embedded newlines. */
export function parseCsv(text) {
  const rows = []
  let row = [],
    cell = '',
    quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell.replace(/\r$/, ''))
      cell = ''
      if (c === '\n') {
        if (row.some(Boolean)) rows.push(row)
        row = []
      }
    } else cell += c
  }
  if (quoted) fail('unterminated CSV quote')
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''))
    rows.push(row)
  }
  const header = rows.shift()
  if (!header || new Set(header).size !== header.length) fail('CSV header')
  return rows.map((values) => {
    if (values.length !== header.length) fail('CSV row width')
    return Object.fromEntries(header.map((key, i) => [key, values[i]]))
  })
}

function regimeOf(row) {
  const rayKeys = ['optimal', 'base', 'slope1', 'slope2']
  if (
    !/^0x[0-9a-f]{40}$/.test(lower(row.strategy)) ||
    !/^\d+$/.test(row.RF_bps) ||
    Number(row.RF_bps) > 10000 ||
    rayKeys.some((key) => !/^\d+$/.test(row[key] ?? ''))
  )
    return null
  return {
    strategy: lower(row.strategy),
    reserveFactorBps: Number(row.RF_bps),
    optimalUtilizationRay: row.optimal,
    baseBorrowRay: row.base,
    slope1Ray: row.slope1,
    slope2Ray: row.slope2,
    aTokenAddress: lower(row.aToken_rd),
    variableDebtTokenAddress: lower(row.variableDebtToken),
  }
}

/**
 * A shared nominal date grid labels snapshots, never freshness. Each actual observation
 * keeps the independently proved blocks.csv timestamp (usually just BEFORE midnight).
 * Gaps and the first point of each changed IRM regime have null APR; no interpolation.
 */
export function buildSeries(reserveRows, blockRows, identities) {
  const snapshots = blockRows.filter(
    (row) => row.kind === 'daily' && /^\d{4}-\d{2}-\d{2}$/.test(row.snapshot),
  )
  if (!snapshots.length) fail('no daily snapshots')
  const blocks = new Map()
  for (const row of snapshots) {
    if (blocks.has(row.snapshot)) fail(`duplicate block snapshot ${row.snapshot}`)
    blocks.set(row.snapshot, row)
  }
  const lastTarget = Math.max(...snapshots.map((row) => dateTs(row.snapshot)))
  const dates = Array.from({ length: MAX_DAYS }, (_, i) =>
    dateOf(lastTarget - (MAX_DAYS - 1 - i) * DAY),
  )
  const series = []
  for (const [symbol, asset] of Object.entries(ASSETS)) {
    // Exact underlying, pool, aToken and variable debt identity corroboration.
    const identity = identities?.[asset.key]
    if (
      lower(identity?.pool) !== POOL ||
      lower(identity?.asset) !== asset.token ||
      lower(identity?.aToken) !== asset.aToken ||
      lower(identity?.variableDebtToken) !== asset.debtToken
    ) {
      fail(`unverified identity ${asset.key}`)
    }
    const rows = new Map()
    for (const row of reserveRows.filter((r) => r.reserve === symbol && r.snapshot !== 'asof')) {
      if (rows.has(row.snapshot)) fail(`duplicate reserve snapshot ${symbol} ${row.snapshot}`)
      rows.set(row.snapshot, row)
    }
    for (const side of ['borrow', 'supply']) {
      const regimes = {}
      let previousRegime = null
      const points = dates.map((date) => {
        const row = rows.get(date),
          block = blocks.get(date)
        const point = {
          date,
          observedAt: null,
          apr: null,
          block: null,
          regime: null,
          quality: 'missing',
          missingReason: null,
        }
        const missing = (reason) => ({ ...point, missingReason: reason })
        if (!row || !block) return missing('Daily source observation missing; no forward fill')
        const target = dateTs(date),
          observedAt = Number(block.block_ts),
          blockNumber = Number(block.block)
        if (
          block.proof !== 'ok' ||
          Number(block.T) !== target ||
          !Number.isSafeInteger(observedAt) ||
          !(observedAt < target && target <= Number(block.next_ts)) ||
          !Number.isSafeInteger(blockNumber) ||
          blockNumber <= 0
        ) {
          fail(`invalid block proof ${date}`)
        }
        if (Number(row.block) !== blockNumber || Number(row.block_ts) !== observedAt)
          fail(`reserve/block timestamp mismatch ${symbol} ${date}`)
        point.observedAt = observedAt
        point.block = blockNumber
        if (
          row.listed !== '1' ||
          row.rd_status !== 'ok' ||
          row.aToken_matches !== '1' ||
          lower(row.aToken_rd) !== asset.aToken ||
          lower(row.variableDebtToken) !== asset.debtToken
        ) {
          return missing('Reserve read or exact token identity unavailable')
        }
        const regime = regimeOf(row)
        if (!regime) return missing('Rate regime unavailable')
        const regimeId = sha256(JSON.stringify(regime)).slice(0, 16)
        regimes[regimeId] = regime
        point.regime = regimeId
        const ray = row[side === 'borrow' ? 'variableBorrowRate_ray' : 'liquidityRate_ray']
        if (!/^\d+$/.test(ray ?? '')) return missing('Source APR unavailable')
        const apr = Number(ray) / 1e27
        if (!Number.isFinite(apr)) fail(`nonfinite APR ${symbol} ${date}`)
        if (previousRegime !== null && previousRegime !== regimeId) {
          previousRegime = regimeId
          return {
            ...point,
            quality: 'regime-change',
            missingReason: 'IRM or fee regime changed; line breaks at this observation',
          }
        }
        previousRegime = regimeId
        return { ...point, apr, quality: 'observed' }
      })
      series.push({
        id: `${asset.key}-${side}`,
        symbol,
        identity: {
          chainId: 1,
          protocol: 'aave-v3',
          venueAddress: POOL,
          marketId: asset.token,
          tokenAddress: asset.token,
        },
        side,
        rateConvention: 'apr',
        feeBasis:
          side === 'supply' ? 'protocol-fees-already-deducted' : 'borrower-before-incentives',
        componentScope: side === 'borrow' ? 'variable-debt-only' : 'all-supply',
        sourcePaths: INPUTS.slice(),
        sampling:
          'Daily archive snapshot immediately before nominal UTC date; observedAt is the actual block timestamp, not the date label. APR = source ray / 1e27.',
        limitations: [
          'Last 90 nominal daily slots only; irregular asof snapshot excluded.',
          'Snapshot APR at current fixed size is not accrued interest or realized earnings.',
          'No rewards, gas, Membrane charges or price changes are included.',
          side === 'borrow'
            ? 'Only the variable-rate debt component; never apply to stable, fixed or unknown-basis debt.'
            : 'Aave liquidityRate already deducts protocol reserve factor; do not deduct it again.',
          'IRM parameter and fee regime boundaries are explicit gaps; no rate is carried across them.',
        ],
        latestRegime: previousRegime,
        regimes,
        points,
      })
    }
  }
  return series
}

export function buildRateHistory(datasetsRoot) {
  const inputs = Object.fromEntries(
    INPUTS.map((path) => [path, readFileSync(resolve(datasetsRoot, path))]),
  )
  const series = buildSeries(
    parseCsv(inputs[INPUTS[0]].toString()),
    parseCsv(inputs[INPUTS[1]].toString()),
    JSON.parse(inputs['venue-stress/summary.json'].toString()).venues,
  )
  return {
    schema: 1,
    units: 'fraction/year',
    maxDays: MAX_DAYS,
    method:
      'Measured daily protocol APR only. A bounded common nominal date grid retains actual block timestamps, null gaps and IRM regime seams. No forecasts, accrual integration or user account data.',
    source: {
      repo: 'triccs/membrane-datasets',
      commit: datasetCommit(datasetsRoot),
      sha256: Object.fromEntries(INPUTS.map((path) => [path, sha256(inputs[path])])),
    },
    excluded: [
      'Morpho Steakhouse history.apr is withdraw-queue market count, not APR.',
      'LST daily ratio indices lack exact observation timestamps: do not invent midnight freshness or an exact 7-day realized interval.',
      'Other venues and tokens have no admitted supply/borrow pair in this table.',
    ],
    series,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const datasetsRoot =
    process.env.MEMBRANE_DATASETS_DIR ??
    process.env.MEMBRANE_DATASETS_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../membrane-datasets')
  const output = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../lib/position/rateHistory.generated.json',
  )
  const built = `${JSON.stringify(buildRateHistory(datasetsRoot), null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== built)
      fail('generated table differs; regenerate and review')
    process.stdout.write('rate history: deterministic source/hash/output check passed\n')
  } else {
    writeFileSync(output, built)
    process.stdout.write(`rate history: wrote 4 series × ${MAX_DAYS} bounded daily slots\n`)
  }
}
