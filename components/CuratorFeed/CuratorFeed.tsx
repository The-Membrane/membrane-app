// CURATOR ACTION FEED — what vault curators changed on Ethereum mainnet, and who holds
// what. Owner spec "Risk Manager Tooling — Planning Spec" (2026-10-05), data product #8.
//
// DeFi Dojo research (621 verified records): curator exposure + rate-spike attribution
// came up in 10 messages from 6 authors; after the Resolv / Stream / msUSD incidents
// members asked which vaults were exposed. Steakhouse cutting rsETH in 2025 was a signal
// anyone could have followed — this page makes such moves visible as they happen.
//
// COLOUR RULES (spec): a submitted change inside its timelock window = PENDING, amber;
// executed or resolved = history, grey; exits of one collateral by ≥ 2 curators inside
// the window (24–72h) = red. COPY RULES: factual only — what the chain recorded, who, how
// much, when. Never "safe", never a prediction. Every figure carries its provenance.
//
// §07 ORACLE ABOVE MARKET is its own file (OracleGapSection.tsx): one small card per
// market, the viewer's markets framed. The compact card at the end of this file leads each
// item with a short headline (lib/curatorFeed/headlines.ts).

import React, { useCallback, useMemo, useState } from 'react'
import NextLink from 'next/link'
import { Box, HStack, Input, Link, Stack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Eyebrow, SectionHeading, Stamp } from '@/components/Carry/atoms'
import { Card } from '@/components/ui/Card'
import { useChainRoute } from '@/hooks/useChainRoute'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { compact, durationText, utc } from '@/lib/curatorFeed/format'
import {
  cardSummary,
  clusterLine,
  currentClusters,
  gapLine,
  rowLine,
  type Line,
} from '@/lib/curatorFeed/headlines'
import type {
  AttributionView,
  ClusterView,
  ExposureResponse,
  FeedResponse,
  FeedRow,
  Group,
  MarketFlagView,
  OracleGapResponse,
  ShiftView,
  SpikeView,
  VaultExposureView,
} from '@/lib/curatorFeed/service'
import type { Tone } from '@/lib/curatorFeed/status'

import { Chip, getJson, LABEL, Mono } from './atoms'
import { OracleGapSection } from './OracleGapSection'

const TONE: Record<Tone, string> = {
  amber: SEMANTIC_COLORS.warning,
  red: SEMANTIC_COLORS.danger,
  grey: SEMANTIC_COLORS.textTertiary,
}
const PROTOCOL: Record<string, string> = {
  'morpho-v1': 'MetaMorpho',
  'morpho-v2': 'Vault V2',
  'euler-earn': 'Euler Earn',
  'aave-v3': 'Aave v3',
}
const GROUPS: { key: Group; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'exits', label: 'exits' },
  { key: 'caps', label: 'caps' },
  { key: 'queues', label: 'queues' },
  { key: 'timelock', label: 'timelocks' },
  { key: 'roles', label: 'roles' },
  { key: 'protocol', label: 'aave' },
]
const ETHERSCAN = 'https://etherscan.io'

const Tag: React.FC<{ tone: Tone; wrap?: boolean; children: React.ReactNode }> = ({
  tone,
  wrap,
  children,
}) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    color={TONE[tone]}
    border="1px solid"
    borderColor={TONE[tone]}
    px="4px"
    whiteSpace={wrap ? 'normal' : 'nowrap'}
    overflowWrap="anywhere"
  >
    {children}
  </Text>
)

const statusLabel = (r: FeedRow, nowS: number): string => {
  if (r.status === 'pending')
    return `pending · ${durationText(Math.max(0, (r.validAt ?? nowS) - nowS))} left`
  if (r.status === 'executable') return 'timelock elapsed · not executed'
  if (r.status === 'cleared') return 'no longer pending'
  return r.status
}

/** "zero timelock: increaseAbsoluteCap, addAdapter +1" — V1 / Euler Earn report `timelock`. */
const zeroText = (fns: string[]): string =>
  fns.length === 1 && fns[0] === 'timelock'
    ? 'timelock 0'
    : `timelock 0: ${fns.slice(0, 2).join(', ')}${fns.length > 2 ? ` +${fns.length - 2}` : ''}`

// ── rows ───────────────────────────────────────────────────────────────────────

const ActionRow: React.FC<{ r: FeedRow; nowS: number }> = ({ r, nowS }) => (
  <Box
    borderLeft="2px solid"
    borderColor={TONE[r.tone]}
    pl={SPACING.sm}
    py={SPACING.xs}
    borderBottom="1px solid"
    borderBottomColor={SEMANTIC_COLORS.borderSubtle}
  >
    <HStack spacing={SPACING.sm} flexWrap="wrap" align="baseline">
      <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
        {utc(r.ts)}
      </Mono>
      <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
        {PROTOCOL[r.protocol]}
      </Mono>
      <Mono size="11px" color={SEMANTIC_COLORS.textPrimary} title={r.vault}>
        {r.vaultName}
      </Mono>
      <Mono size="10px">{r.curatorName}</Mono>
      <Tag tone={r.tone}>
        {r.inCluster ? `cluster · ${statusLabel(r, nowS)}` : statusLabel(r, nowS)}
      </Tag>
      {r.zeroTimelock.length > 0 && (
        <Box
          as="span"
          title={`Runs in one transaction at the last read: ${r.zeroTimelock.join(', ')}`}
        >
          <Tag tone="grey" wrap>
            {zeroText(r.zeroTimelock)}
          </Tag>
        </Box>
      )}
    </HStack>
    <Mono
      size="12px"
      color={r.tone === 'grey' ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary}
    >
      {r.text}{' '}
      <Link
        href={`${ETHERSCAN}/tx/${r.tx}`}
        isExternal
        color={SEMANTIC_COLORS.textTertiary}
        fontSize="10px"
      >
        tx ↗
      </Link>
    </Mono>
  </Box>
)

const ClusterCard: React.FC<{ c: ClusterView }> = ({ c }) => (
  <Box border="1px solid" borderColor={SEMANTIC_COLORS.danger} p={SPACING.md}>
    <HStack justify="space-between" align="baseline" flexWrap="wrap">
      <HStack spacing={SPACING.sm} align="baseline">
        <Tag tone="red">{c.claim.replace(/-/g, ' ')}</Tag>
        <Mono size="13px" color={SEMANTIC_COLORS.danger}>
          {c.text}
        </Mono>
      </HStack>
      <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
        {utc(c.start)} → {utc(c.end)}
      </Mono>
    </HStack>
    <Mono size="11px">Curators: {c.curatorNames.join(', ')}</Mono>
    <Mono size="11px">Vaults: {c.vaultNames.join(', ')}</Mono>
    {c.protocolActionIds.length > 0 && (
      <Mono size="11px">
        Aave v3 also froze or set LTV 0 on {c.symbol} within the window (
        {c.protocolActionIds.length} action{c.protocolActionIds.length > 1 ? 's' : ''}).
      </Mono>
    )}
  </Box>
)

// ── sections ───────────────────────────────────────────────────────────────────

const VaultExposure: React.FC<{ collateral: string }> = ({ collateral }) => {
  const [open, setOpen] = useState<string | null>(null)
  const minUsd = collateral ? 0 : 1_000_000
  const { data, error, isLoading } = useQuery<{
    block: number
    ts: number
    vaults: VaultExposureView[]
  }>({
    queryKey: ['curator_exposure_vaults', collateral, minUsd],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=exposure&by=vault&minUsd=${minUsd}${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  })
  return (
    <Stack spacing={0} mt={SPACING.sm}>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      {data?.vaults.slice(0, 80).map((v) => (
        <Box key={v.vault} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          <HStack
            as="button"
            type="button"
            w="100%"
            justify="space-between"
            py={SPACING.xs}
            onClick={() => setOpen(open === v.vault ? null : v.vault)}
            aria-expanded={open === v.vault}
          >
            <Mono size="12px" color={SEMANTIC_COLORS.textPrimary} title={v.vault}>
              {open === v.vault ? '▾' : '▸'} {v.vaultName}{' '}
              <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                · {v.curatorName} · {PROTOCOL[v.protocol]}
              </Text>
            </Mono>
            <Mono size="11px">
              {v.liveUsd !== undefined ? `$${compact(v.liveUsd)}` : v.loanSymbol}
              {v.lockedUsd ? ` + $${compact(v.lockedUsd)} book value` : ''}
              {v.lostUsd ? ` + $${compact(v.lostUsd)} written off` : ''} · {v.allocations.length}{' '}
              allocation{v.allocations.length === 1 ? '' : 's'}
            </Mono>
          </HStack>
          {open === v.vault && (
            <Box pl={SPACING.base} pb={SPACING.sm}>
              {(v.lockedUsd || v.lostUsd) && v.totalUsd !== undefined ? (
                <Mono size="10.5px" color={SEMANTIC_COLORS.textTertiary}>
                  totalAssets() reports ${compact(v.totalUsd)}
                  {v.lockedUsd
                    ? `; $${compact(v.lockedUsd)} of it is supply in markets whose supply is locked (book value)`
                    : ''}
                  {v.lostUsd
                    ? `; $${compact(v.lostUsd)} of it is lostAssets(), written off and still counted (MetaMorpho v1.1)`
                    : ''}
                  .
                </Mono>
              ) : null}
              {Object.keys(v.timelocks).length > 0 && (
                <Mono size="10.5px" color={SEMANTIC_COLORS.textTertiary}>
                  Timelocks at the last read:{' '}
                  {Object.entries(v.timelocks)
                    .map(
                      ([f, sec]) => `${f} ${sec === 0 ? '0 (one transaction)' : durationText(sec)}`,
                    )
                    .join(' · ')}
                </Mono>
              )}
              {v.allocations.map((a) => (
                <HStack key={`${a.target}:${a.via ?? ''}`} justify="space-between" flexWrap="wrap">
                  <Mono size="11px" color={SEMANTIC_COLORS.textPrimary} title={a.target}>
                    {a.targetName}
                    {a.via ? (
                      <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                        {' '}
                        · via {a.via.slice(0, 6)}…{a.via.slice(-4)}
                      </Text>
                    ) : null}
                    {a.flags?.map((f) => (
                      <Box as="span" key={f} ml="6px">
                        <Tag tone="amber" wrap>
                          {f}
                        </Tag>
                      </Box>
                    ))}
                  </Mono>
                  <Mono size="11px">
                    {compact(a.amount)} {v.loanSymbol}
                    {a.usd !== undefined
                      ? ` ($${compact(a.usd)}${a.locked ? ' book value' : ''})`
                      : ''}{' '}
                    · {(a.share * 100).toFixed(1)}%
                  </Mono>
                </HStack>
              ))}
            </Box>
          )}
        </Box>
      ))}
    </Stack>
  )
}

const ExposureSection: React.FC<{ collateral: string }> = ({ collateral }) => {
  const [by, setBy] = useState<'collateral' | 'vault'>('collateral')
  const [open, setOpen] = useState<string | null>(null)
  const minUsd = collateral ? 0 : 1_000_000
  const { data, error, isLoading } = useQuery<ExposureResponse>({
    queryKey: ['curator_exposure', collateral, minUsd],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=exposure&minUsd=${minUsd}${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  })
  return (
    <Box>
      <SectionHeading
        index="04"
        title="Who holds which collateral"
        note={data ? `head block ${data.block} · ${utc(data.ts)}` : undefined}
      />
      <Mono size="11px">
        Supply each vault has in markets backed by the collateral (Morpho Blue positions, Vault V2
        adapters, Euler Earn strategies) at the head block. USD at collection-time prices. Supply in
        a market whose supply is locked (flag below) is book value and is shown apart. MetaMorpho
        v1.1 vaults count written-off assets (lostAssets) in totalAssets; the vault view shows them
        apart.
        {!collateral && ' Rows of at least $1M shown; filter by a symbol to see all.'}
      </Mono>
      <HStack mt={SPACING.sm} spacing={SPACING.sm}>
        <Chip active={by === 'collateral'} onClick={() => setBy('collateral')}>
          by collateral
        </Chip>
        <Chip active={by === 'vault'} onClick={() => setBy('vault')}>
          by vault
        </Chip>
      </HStack>
      {by === 'vault' && <VaultExposure collateral={collateral} />}
      {by === 'collateral' && isLoading && <Mono>loading…</Mono>}
      {by === 'collateral' && error && (
        <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>
      )}
      <Stack spacing={0} mt={SPACING.sm} display={by === 'collateral' ? 'flex' : 'none'}>
        {data?.rows.slice(0, 60).map((row) => (
          <Box
            key={row.collateral}
            borderBottom="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            <HStack
              as="button"
              type="button"
              w="100%"
              justify="space-between"
              py={SPACING.xs}
              onClick={() => setOpen(open === row.collateral ? null : row.collateral)}
              aria-expanded={open === row.collateral}
            >
              <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
                {open === row.collateral ? '▾' : '▸'} {row.symbol}
              </Mono>
              <Mono size="11px">
                ${compact(row.usd)}
                {row.lockedUsd ? ` + $${compact(row.lockedUsd)} book value` : ''}
                {row.unpriced ? ` + ${row.unpriced} unpriced` : ''} · {row.holders.length} vault
                {row.holders.length === 1 ? '' : 's'} · {row.curatorCount} curator
                {row.curatorCount === 1 ? '' : 's'}
              </Mono>
            </HStack>
            {open === row.collateral && (
              <Box pl={SPACING.base} pb={SPACING.sm}>
                {row.holders.map((h) => (
                  <HStack key={h.vault} justify="space-between" flexWrap="wrap">
                    <Mono size="11px" color={SEMANTIC_COLORS.textPrimary} title={h.vault}>
                      {h.vaultName}{' '}
                      <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                        · {h.curatorName} · {PROTOCOL[h.protocol]}
                      </Text>
                    </Mono>
                    <Mono size="11px">
                      {compact(h.amount)} {h.loanSymbol}
                      {h.usd !== undefined
                        ? ` ($${compact(h.usd)}${h.lockedUsd ? ` incl. $${compact(h.lockedUsd)} book value` : ''})`
                        : ''}{' '}
                      · {(h.shareOfVault * 100).toFixed(1)}% of vault
                    </Mono>
                  </HStack>
                ))}
              </Box>
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  )
}

const AttributionSection: React.FC<{
  collateral: string
  threshold?: number
  keptDrop?: number
}> = ({ collateral, threshold, keptDrop }) => {
  const [limit, setLimit] = useState(25)
  const { data, error, isLoading } = useQuery<{ rows: AttributionView[]; total: number }>({
    queryKey: ['curator_attribution', collateral, limit],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=attribution&limit=${limit}${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  })
  const shown = data?.rows ?? []
  const total = data?.total ?? 0
  return (
    <Box>
      <SectionHeading
        index="05"
        title="Vault withdrawals that moved a market"
        note={`${total.toLocaleString()} blocks · claim class: observed driver`}
      />
      <Mono size="11px">
        Blocks where vault reallocations withdrew at least ${compact(threshold ?? 1_000_000)} (net,
        per transaction) from a Morpho Blue market and the market’s supply fell by{' '}
        {((keptDrop ?? 0.2) * 100).toFixed(0)}% or more, the borrow rate jumped (≥ 1.5× and ≥ +2 APR
        points), or utilization ended at 99% or above. Figures compare the end of block b−1 with the
        end of block b; other transactions in the block are included. APR is simple (rate × seconds
        per year).
      </Mono>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      <Stack spacing={0} mt={SPACING.sm}>
        {shown.map((a) => (
          <Box
            key={`${a.market}:${a.block}`}
            borderLeft="2px solid"
            borderColor={
              a.spike || a.drained ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.borderSubtle
            }
            pl={SPACING.sm}
            py={SPACING.xs}
            borderBottom="1px solid"
            borderBottomColor={SEMANTIC_COLORS.borderSubtle}
          >
            <HStack spacing={SPACING.sm}>
              <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                {utc(a.ts)}
              </Mono>
              {a.spike && <Tag tone="amber">rate spike</Tag>}
              {a.drained && <Tag tone="amber">utilization ≥ 99%</Tag>}
            </HStack>
            <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
              {a.text}{' '}
              <Link
                href={`${ETHERSCAN}/tx/${a.tx}`}
                isExternal
                color={SEMANTIC_COLORS.textTertiary}
                fontSize="10px"
              >
                tx ↗
              </Link>
            </Mono>
          </Box>
        ))}
      </Stack>
      {total > shown.length && (
        <Box mt={SPACING.sm}>
          <Chip onClick={() => setLimit(Math.min(500, limit + 100))}>
            {limit >= 500 ? 'filter to see more' : `show more (${total - shown.length} left)`}
          </Chip>
        </Box>
      )}
    </Box>
  )
}

const DRIVER: Record<string, string> = {
  'vault-reallocation': 'vault reallocation',
  'vault-redemption': 'vault redemption',
  'vault-deposit': 'vault deposit',
  'supplier-withdrawal': 'supplier withdrawal',
  'supplier-deposit': 'supplier deposit',
  borrow: 'new borrows',
  repay: 'repayments',
  liquidation: 'liquidation',
  'bad-debt': 'bad debt',
}

const SpikeSection: React.FC<{ collateral: string; minSupply?: number }> = ({
  collateral,
  minSupply,
}) => {
  const [only, setOnly] = useState<'' | 'reallocation' | 'drained'>('reallocation')
  const [minUsd, setMinUsd] = useState(10_000_000)
  const [limit, setLimit] = useState(25)
  const params = useMemo(() => {
    const p = new URLSearchParams({ view: 'spikes', minUsd: String(minUsd), limit: String(limit) })
    if (only) p.set('only', only)
    if (collateral) p.set('collateral', collateral)
    return p.toString()
  }, [collateral, only, minUsd, limit])
  const { data, error, isLoading } = useQuery<{ rows: SpikeView[]; total: number }>({
    queryKey: ['curator_spikes', params],
    queryFn: () => getJson(`/api/curator-feed?${params}`),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  })
  const rows = data?.rows ?? []
  return (
    <Box>
      <SectionHeading
        index="06"
        title="Borrow-rate spikes and who moved the market"
        note={`${(data?.total ?? 0).toLocaleString()} blocks · claim class: observed driver`}
      />
      <Mono size="11px">
        Morpho Blue markets that curated vaults use, where the borrow rate the market charged jumped
        (≥ 1.5× and ≥ +2 APR points) between two consecutive accruals, with at least $
        {compact(minSupply ?? 1_000_000)} supplied before. Every supply, withdrawal, borrow,
        repayment and liquidation in the block that set the new rate is listed. A vault withdrawal
        counts as a reallocation when the same transaction holds the allocator’s reallocation leg,
        else as a redemption. Shares (≈) are first-order effects on utilization at the state before
        the block, among the flows that pushed it up.
      </Mono>
      <HStack mt={SPACING.sm} spacing={SPACING.sm} flexWrap="wrap">
        <Chip active={only === 'reallocation'} onClick={() => setOnly('reallocation')}>
          reallocation-led
        </Chip>
        <Chip active={only === 'drained'} onClick={() => setOnly('drained')}>
          utilization ≥ 99%
        </Chip>
        <Chip active={only === ''} onClick={() => setOnly('')}>
          all drivers
        </Chip>
        <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
          market supply ≥
        </Mono>
        {[1_000_000, 10_000_000, 50_000_000].map((x) => (
          <Chip key={x} active={minUsd === x} onClick={() => setMinUsd(x)}>
            ${compact(x)}
          </Chip>
        ))}
      </HStack>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      {data && rows.length === 0 && (
        <Mono size="11px">No spike matches these filters in the collected range.</Mono>
      )}
      <Stack spacing={0} mt={SPACING.sm}>
        {rows.map((s) => (
          <Box
            key={`${s.market}:${s.block}`}
            borderLeft="2px solid"
            borderColor={
              s.top === 'vault-reallocation'
                ? SEMANTIC_COLORS.warning
                : SEMANTIC_COLORS.borderSubtle
            }
            pl={SPACING.sm}
            py={SPACING.xs}
            borderBottom="1px solid"
            borderBottomColor={SEMANTIC_COLORS.borderSubtle}
          >
            <HStack spacing={SPACING.sm} flexWrap="wrap">
              <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                {utc(s.ts)}
              </Mono>
              {s.supplyUsd !== undefined && (
                <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                  supply ${compact(s.supplyUsd)}
                </Mono>
              )}
              {s.top && (
                <Tag tone={s.top === 'vault-reallocation' ? 'amber' : 'grey'}>
                  {DRIVER[s.top]} ≈ {Math.round((s.topShare ?? 0) * 100)}%
                </Tag>
              )}
              {(s.utilAfter ?? 0) >= 0.99 && <Tag tone="amber">utilization ≥ 99%</Tag>}
            </HStack>
            <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
              {s.text}{' '}
              {uniqTx(s).map((tx, i) => (
                <Link
                  key={tx}
                  href={`${ETHERSCAN}/tx/${tx}`}
                  isExternal
                  color={SEMANTIC_COLORS.textTertiary}
                  fontSize="10px"
                  mr="4px"
                >
                  tx{i ? i + 1 : ''} ↗
                </Link>
              ))}
            </Mono>
          </Box>
        ))}
      </Stack>
      {data && data.total > rows.length && (
        <Box mt={SPACING.sm}>
          <Chip onClick={() => setLimit(Math.min(500, limit + 50))}>
            {limit >= 500 ? 'filter to see more' : `show more (${data.total - rows.length} left)`}
          </Chip>
        </Box>
      )}
    </Box>
  )
}

const FLAG_TAG: Record<string, string> = {
  'oracle-fixed': 'fixed-price oracle',
  'oracle-reported': 'reported-value oracle',
  'oracle-reverting': 'oracle reverting',
  'oracle-stale': 'oracle stale',
  'one-borrower': 'one borrower',
  'supply-locked': 'supply locked',
}

const FlagsSection: React.FC<{ collateral: string }> = ({ collateral }) => {
  const [held, setHeld] = useState(true)
  const [allMarkets, setAllMarkets] = useState(false)
  const { data, error, isLoading } = useQuery<{
    block?: number
    ts?: number
    markets: MarketFlagView[]
    shifts: ShiftView[]
  }>({
    queryKey: ['curator_flags', collateral],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=flags${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  })
  const markets = (data?.markets ?? []).filter(
    (m) => !held || m.kinds.includes('oracle-reverting') || (m.curatedUsd ?? 0) > 0,
  )
  const shownMarkets = allMarkets ? markets : markets.slice(0, 20)
  return (
    <Box>
      <SectionHeading
        index="08"
        title="Market and curator flags"
        note={
          data?.block ? `block ${data.block.toLocaleString()} · ${utc(data.ts ?? 0)}` : undefined
        }
      />
      <Mono size="11px">
        Facts that kept depositors from leaving in the 2026 msY and AZND write-offs, read for every
        market curated vaults use: an oracle with no market price in its path (a fixed price, or
        only reported values such as a NAV feed); an oracle whose price() reverts, or whose feed
        stopped updating; one address owing most of a market&apos;s borrows. From the 2025 sdeUSD
        write-offs: a market fully borrowed for 7 days with no working market price, whose supply
        grows as book value. And one curator moving a position between its own vaults, then cutting
        it in the vaults that gave it up.
      </Mono>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      {data && (
        <>
          <HStack mt={SPACING.sm} spacing={SPACING.sm} flexWrap="wrap">
            <Chip active={held} onClick={() => setHeld(true)}>
              held by curated vaults or reverting
            </Chip>
            <Chip active={!held} onClick={() => setHeld(false)}>
              all flagged markets
            </Chip>
            <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
              {markets.length} markets · {data.shifts.length} curator shifts
            </Mono>
          </HStack>
          <Stack spacing={0} mt={SPACING.sm}>
            {shownMarkets.map((m) => (
              <Box
                key={m.market}
                borderLeft="2px solid"
                borderColor={
                  m.kinds.includes('oracle-reverting')
                    ? SEMANTIC_COLORS.danger
                    : SEMANTIC_COLORS.warning
                }
                pl={SPACING.sm}
                py={SPACING.xs}
                borderBottom="1px solid"
                borderBottomColor={SEMANTIC_COLORS.borderSubtle}
              >
                <HStack spacing={SPACING.sm} flexWrap="wrap" align="baseline">
                  <Mono size="12px" color={SEMANTIC_COLORS.textPrimary} title={m.market}>
                    {m.marketName}
                  </Mono>
                  {m.kinds.map((k) => (
                    <Tag key={k} tone={k === 'oracle-reverting' ? 'red' : 'amber'}>
                      {FLAG_TAG[k] ?? k}
                    </Tag>
                  ))}
                  {m.curatedUsd !== undefined && (
                    <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                      curated supply ${compact(m.curatedUsd)}
                      {m.kinds.includes('supply-locked') ? ' (book value)' : ''} · {m.vaults.length}{' '}
                      vault
                      {m.vaults.length === 1 ? '' : 's'}
                    </Mono>
                  )}
                </HStack>
                {m.texts.map((t) => (
                  <Mono key={t} size="11.5px" color={SEMANTIC_COLORS.textPrimary}>
                    {t}
                  </Mono>
                ))}
                {m.vaults.length > 0 && (
                  <Mono size="10.5px" color={SEMANTIC_COLORS.textTertiary}>
                    Held by:{' '}
                    {m.vaults
                      .slice(0, 6)
                      .map(
                        (v) =>
                          `${v.vaultName} (${v.curatorName}) ${(v.share * 100).toFixed(1)}% of vault` +
                          (m.kinds.includes('one-borrower') && v.borrowerShare !== undefined
                            ? `, ≈ ${Math.round(v.borrowerShare * 100)}% lent to that borrower`
                            : ''),
                      )
                      .join(' · ')}
                    {m.vaults.length > 6 ? ` · +${m.vaults.length - 6} more` : ''}
                  </Mono>
                )}
              </Box>
            ))}
          </Stack>
          {markets.length > 20 && (
            <Box mt={SPACING.sm}>
              <Chip onClick={() => setAllMarkets(!allMarkets)}>
                {allMarkets ? 'show fewer' : `show all ${markets.length}`}
              </Chip>
            </Box>
          )}
          <Mono size="11px" color={SEMANTIC_COLORS.textSecondary}>
            Curator shifts (claim class: possible leading signal):{' '}
            {data.shifts.length === 0 ? 'none in the collected range.' : ''}
          </Mono>
          <Stack spacing={0} mt={SPACING.xs}>
            {data.shifts.map((x) => (
              <Box
                key={`${x.market}:${x.day}:${x.curatorName}`}
                borderLeft="2px solid"
                borderColor={SEMANTIC_COLORS.warning}
                pl={SPACING.sm}
                py={SPACING.xs}
                borderBottom="1px solid"
                borderBottomColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                  {x.day}
                </Mono>
                <Mono size="11.5px" color={SEMANTIC_COLORS.textPrimary}>
                  {x.text}
                </Mono>
              </Box>
            ))}
          </Stack>
        </>
      )}
    </Box>
  )
}

/** Transactions behind the drivers that pushed utilization up (largest first), max 3. */
const uniqTx = (s: SpikeView): string[] =>
  [...new Set(s.drivers.filter((d) => d.share > 0).map((d) => d.tx))].slice(0, 3)

// ── page body ──────────────────────────────────────────────────────────────────

export const CuratorFeed: React.FC = () => {
  const [collateralInput, setCollateralInput] = useState('')
  const [collateral, setCollateral] = useState('')
  const [group, setGroup] = useState<Group>('all')
  const [windowH, setWindowH] = useState(72)
  const [limit, setLimit] = useState(100)
  const params = useMemo(() => {
    const p = new URLSearchParams({ group, window: String(windowH), limit: String(limit) })
    if (collateral) p.set('collateral', collateral)
    return p.toString()
  }, [collateral, group, windowH, limit])
  const { data, error, isLoading, isFetching } = useQuery<FeedResponse>({
    queryKey: ['curator_feed', params],
    queryFn: () => getJson(`/api/curator-feed?${params}`),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
  const nowS = data?.meta.now ?? Math.floor(Date.now() / 1000)
  const m = data?.meta
  const [showExecutable, setShowExecutable] = useState(false)
  // "watch this market": filter every section to its collateral and go to the top.
  const watch = useCallback((symbol: string) => {
    setCollateralInput(symbol)
    setCollateral(symbol)
    window.scrollTo({ top: 0 })
  }, [])
  const pending = data?.open.filter((r) => r.status === 'pending') ?? []
  const executable = data?.open.filter((r) => r.status === 'executable') ?? []

  return (
    <Box maxW="1100px" mx="auto" px={SPACING.base} py={SPACING.lg}>
      <Eyebrow>Risk tooling · Ethereum mainnet</Eyebrow>
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h1}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Curator action feed
      </Text>
      <Mono size="12px">
        Supply-cap changes, market removals, write-offs, queue changes, timelock and role changes by
        MetaMorpho, Morpho Vault V2 and Euler Earn curators, with Aave v3 cap / freeze changes as
        the protocol-level comparison. Amber: a submitted change still inside its timelock window
        (or past it and not yet executed). Grey: history. Red: the same collateral exited by two or
        more curators inside the window.
      </Mono>
      {m && (
        <Stamp>
          blocks {m.fromBlock.toLocaleString()}–{m.toBlock.toLocaleString()} · {utc(m.fromTs)} →{' '}
          {utc(m.toTs)} · collected {m.collectedAt.slice(0, 16).replace('T', ' ')} UTC ·{' '}
          {m.logs.chunks.toLocaleString()} log ranges, {m.logs.rechecked.toLocaleString()} re-read
          on a second endpoint, {m.logs.recovered.toLocaleString()} logs recovered by the re-read
          {m.lastRun
            ? ` · last run ${m.lastRun.mode}, blocks ${m.lastRun.fromBlock.toLocaleString()}–${m.lastRun.toBlock.toLocaleString()}`
            : ''}
        </Stamp>
      )}

      <HStack mt={SPACING.base} spacing={SPACING.sm} flexWrap="wrap">
        <Input
          size="sm"
          w="200px"
          borderRadius={0}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          placeholder="collateral: rsETH or 0x…"
          value={collateralInput}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCollateralInput(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) =>
            e.key === 'Enter' && setCollateral(collateralInput.trim())
          }
          onBlur={() => setCollateral(collateralInput.trim())}
          aria-label="Filter by collateral symbol or address"
        />
        {GROUPS.map((g) => (
          <Chip key={g.key} active={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}
          </Chip>
        ))}
        <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
          cluster window
        </Mono>
        {[24, 48, 72].map((h) => (
          <Chip key={h} active={windowH === h} onClick={() => setWindowH(h)}>
            {h}h
          </Chip>
        ))}
        {isFetching && <Mono size="10px">updating…</Mono>}
      </HStack>

      {error && (
        <Mono color={SEMANTIC_COLORS.danger} size="12px">
          {String((error as Error).message)}
        </Mono>
      )}
      {isLoading && <Mono>loading…</Mono>}

      {data && (
        <>
          <SectionHeading
            index="01"
            title="Clustered exits"
            note={`≥ 2 curators · ${windowH}h window · claim class: possible leading signal`}
          />
          <Mono size="11px">
            An exit counts when a vault set a cap to 0, submitted a forced removal, removed a market
            from its withdraw queue, or wrote off a Vault V2 adapter position (burnShares), and kept
            no other market with that collateral capped (read at the exit’s block). A cap moved to a
            new market with the same collateral is a migration and does not count; neither does a PT
            exit within 14 days of its maturity.
          </Mono>
          {data.clusters.length === 0 ? (
            <Mono size="11px">
              No collateral was exited by two or more curators inside a {windowH}h window in this
              range{collateral ? ` for ${collateral}` : ''}.
            </Mono>
          ) : (
            <Stack spacing={SPACING.sm}>
              {[...data.clusters]
                .sort((a, b) => b.curators.length - a.curators.length || b.end - a.end)
                .map((c) => (
                  <ClusterCard key={`${c.collateral}:${c.start}`} c={c} />
                ))}
            </Stack>
          )}

          <SectionHeading
            index="02"
            title="In a timelock window"
            note={`${pending.length} pending`}
          />
          {pending.length === 0 ? (
            <Mono size="11px">
              No submitted change is inside its timelock window
              {collateral ? ` for ${collateral}` : ''}.
            </Mono>
          ) : (
            <Box>
              {pending.map((r) => (
                <ActionRow key={r.id} r={r} nowS={nowS} />
              ))}
            </Box>
          )}
          {executable.length > 0 && (
            <Box mt={SPACING.sm}>
              <Chip active={showExecutable} onClick={() => setShowExecutable(!showExecutable)}>
                {showExecutable ? 'hide' : 'show'} {executable.length} submitted, window elapsed,
                not executed
              </Chip>
              {showExecutable && (
                <Box mt={SPACING.xs}>
                  <Mono size="10.5px">
                    These can still be executed at any time; the contract keeps them pending until
                    executed or revoked.
                  </Mono>
                  {executable.map((r) => (
                    <ActionRow key={r.id} r={r} nowS={nowS} />
                  ))}
                </Box>
              )}
            </Box>
          )}

          <SectionHeading index="03" title="Feed" note={`${data.total.toLocaleString()} actions`} />
          <Box>
            {data.rows.map((r) => (
              <ActionRow key={r.id} r={r} nowS={nowS} />
            ))}
          </Box>
          {data.nextBefore && (
            <Box mt={SPACING.sm}>
              <Chip onClick={() => setLimit(Math.min(500, limit + 100))}>
                {limit >= 500 ? 'filter to see older actions' : 'show more'}
              </Chip>
            </Box>
          )}
        </>
      )}

      <ExposureSection collateral={collateral} />
      <AttributionSection
        collateral={collateral}
        threshold={m?.thresholds.largeWithdrawUsd}
        keptDrop={m?.thresholds.keptSupplyDrop}
      />
      <SpikeSection collateral={collateral} minSupply={m?.thresholds.spikeMinSupplyUsd} />
      <OracleGapSection collateral={collateral} onWatch={watch} />
      <FlagsSection collateral={collateral} />

      {m && (
        <Card variant="subtle" mt={SPACING.xl} p={SPACING.base}>
          <Eyebrow>Sources and limits</Eyebrow>
          {[...m.sources, ...m.caveats].map((s) => (
            <Mono key={s} size="10.5px">
              · {s}
            </Mono>
          ))}
        </Card>
      )}
    </Box>
  )
}

// ── compact card ─────────────────────────────────────────────────────────────────
// Mounted on data pages (the Today edition's Safety body; the venue page), so it
// follows the newspaper rules (membrane-board design/DESIGN_RULES.md) on every page it
// sits on: a hairline rule instead of a filled card, no amber (amber means only the 8h
// window: a pending timelock is ink), red with ✖ only for a real alarm (an exit cluster
// whose last exit is inside the 72 h window, a fired oracle gap), muted ink for history
// (an older cluster included), nothing under 11px, 44px targets. Its colours
// are the app tokens, so it reads in both app themes and inside the edition.
//
// Owner, 2026-10-16: "summarized titles". One top line says whether anything fired; each
// item leads with a 2–5 word headline; vault, curator and date are small print; the full
// sentence and the transaction are in the item's fold.

/** The card's cluster window, and how long a cluster stays an alarm after its last exit
 *  (the API's default and widest window, parseFeedQuery). */
const CARD_WINDOW_HOURS = 72

/** The headline and its small print; ✖ and red only on an alarm. */
const LineText: React.FC<{ l: Line; muted?: boolean }> = ({ l, muted }) => (
  <>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="14px"
      lineHeight="20px"
      fontWeight={TYPOGRAPHY.medium}
      color={
        l.alarm
          ? SEMANTIC_COLORS.danger
          : muted
            ? SEMANTIC_COLORS.textSecondary
            : SEMANTIC_COLORS.textPrimary
      }
      overflowWrap="anywhere"
    >
      {l.mark && (
        <Box as="span" aria-hidden="true" mr="0.4em">
          {l.mark}
        </Box>
      )}
      {l.headline}
    </Text>
    {l.detail && (
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        lineHeight="16px"
        color={SEMANTIC_COLORS.textSecondary}
        overflowWrap="anywhere"
      >
        {l.detail}
      </Text>
    )}
  </>
)

/** One item: the summary row is the 44px tap target; the fold holds the full record. */
const CardItem: React.FC<{ l: Line; muted?: boolean; children: React.ReactNode }> = ({
  l,
  muted,
  children,
}) => (
  <Box
    as="details"
    borderBottom="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    sx={{
      '& > summary::-webkit-details-marker': { display: 'none' },
      '& > summary [data-fold]::before': { content: '"▸"' },
      '&[open] > summary [data-fold]::before': { content: '"▾"' },
    }}
  >
    <Box
      as="summary"
      display="flex"
      alignItems="flex-start"
      gap={SPACING.sm}
      py={SPACING.sm}
      minH="44px"
      cursor="pointer"
      listStyleType="none"
      _focusVisible={FOCUS_STYLES.ring}
    >
      <Box flex="1" minW={0}>
        <LineText l={l} muted={muted} />
      </Box>
      <Box
        as="span"
        data-fold=""
        aria-hidden="true"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        lineHeight="20px"
        color={SEMANTIC_COLORS.textSecondary}
      />
    </Box>
    <Box pb={SPACING.sm}>{children}</Box>
  </Box>
)

const TxLink: React.FC<{ tx: string }> = ({ tx }) => (
  <Link
    href={`${ETHERSCAN}/tx/${tx}`}
    isExternal
    display="inline-flex"
    alignItems="center"
    minH="44px"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="11px"
    color={SEMANTIC_COLORS.textSecondary}
    textDecoration="underline"
    _focusVisible={FOCUS_STYLES.ring}
  >
    tx ↗
  </Link>
)

const CardRow: React.FC<{ r: FeedRow; current: boolean }> = ({ r, current }) => (
  <CardItem l={rowLine(r, current)} muted={!current && r.tone === 'grey'}>
    <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
      {r.text}
    </Mono>
    {r.zeroTimelock.length > 0 && (
      <Mono
        size="11px"
        title={`Runs in one transaction at the last read: ${r.zeroTimelock.join(', ')}`}
      >
        {zeroText(r.zeroTimelock)} (one transaction, no wait)
      </Mono>
    )}
    <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
      {utc(r.ts)} · {PROTOCOL[r.protocol]}
    </Mono>
    <TxLink tx={r.tx} />
  </CardItem>
)

const ClusterItem: React.FC<{ c: ClusterView; current: boolean }> = ({ c, current }) => (
  <CardItem l={clusterLine(c, current)} muted={!current}>
    <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
      {c.text}
    </Mono>
    <Mono size="11px">Vaults: {c.vaultNames.join(', ')}</Mono>
    <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
      {utc(c.start)} → {utc(c.end)}
    </Mono>
  </CardItem>
)

/** The oracle-gap line: a block link to §07, 44px tall, its glyph inline when it wraps. */
const OracleGapLine: React.FC<{ l: Line; href: string }> = ({ l, href }) => (
  <Box borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
    <Link
      as={NextLink}
      href={href}
      display="flex"
      alignItems="flex-start"
      gap={SPACING.sm}
      py={SPACING.sm}
      minH="44px"
      _hover={{ textDecoration: 'none' }}
      _focusVisible={FOCUS_STYLES.ring}
    >
      <Box flex="1" minW={0}>
        <LineText l={l} />
      </Box>
      <Box
        as="span"
        aria-hidden="true"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        lineHeight="20px"
        color={SEMANTIC_COLORS.textSecondary}
      >
        →
      </Box>
    </Link>
  </Box>
)

/** Compact feed: the top line, open exit clusters, the oracle-gap state, the next
 *  timelocks to elapse, the latest exits. Links to the full page. */
export const CuratorFeedCard: React.FC = () => {
  const { chainName } = useChainRoute()
  const { data, isError } = useQuery<FeedResponse>({
    queryKey: ['curator_feed_card'],
    queryFn: () => getJson(`/api/curator-feed?group=exits&limit=5&window=${CARD_WINDOW_HOURS}`),
    staleTime: 5 * 60_000,
    // A missing dataset is a 503, not a blip: say so after one retry, not four.
    retry: 1,
  })
  const { data: gap, isError: gapIsError } = useQuery<OracleGapResponse>({
    queryKey: ['curator_oracle_gap_card'],
    queryFn: () => getJson('/api/curator-feed?view=oracle-gap&limit=1'),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const pending = data?.open.filter((r) => r.status === 'pending') ?? []
  const empty =
    !!data && data.clusters.length === 0 && pending.length === 0 && data.rows.length === 0
  const collected = data ? Date.parse(data.meta.collectedAt) : NaN
  const { current, past } = currentClusters(
    data?.clusters ?? [],
    data?.meta.now ?? 0,
    CARD_WINDOW_HOURS,
  )
  const currentIds = new Set(current.flatMap((c) => c.actionIds))
  // Current clusters, else the latest one as history.
  const clusters = current.length ? current.slice(0, 2) : past.slice(0, 1)
  const summary = cardSummary({
    feed: data
      ? {
          currentClusters: current.length,
          pending: pending.length,
          // Older than the window: nothing can be said about exits now (DESIGN_RULES §4).
          ...(data.meta.now - data.meta.toTs > CARD_WINDOW_HOURS * 3600
            ? { asOf: data.meta.toTs }
            : {}),
        }
      : undefined,
    feedError: !data && isError,
    gap,
    gapError: !gap && gapIsError,
  })
  const gl = gapLine(gap, !gap && gapIsError)
  return (
    <Box
      as="section"
      aria-label="Curator actions"
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      pt={SPACING.sm}
    >
      <Text {...LABEL} color={SEMANTIC_COLORS.textSecondary}>
        Curator actions
      </Text>
      {/* The answer to "do I need to care": unavailable is said, never an endless loading. */}
      <Box py={SPACING.xs} minH="32px" aria-live="polite">
        {summary ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.body}
            lineHeight="24px"
            fontWeight={TYPOGRAPHY.bold}
            color={summary.alarm ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
          >
            {summary.mark && (
              <Box as="span" aria-hidden="true" mr="0.4em">
                {summary.mark}
              </Box>
            )}
            {summary.headline}
          </Text>
        ) : (
          <Mono size="13px">—</Mono>
        )}
      </Box>
      {clusters.map((c) => (
        <ClusterItem key={`${c.collateral}:${c.start}`} c={c} current={current.includes(c)} />
      ))}
      {gl && <OracleGapLine l={gl} href={`/${chainName}/curator-feed#oracle-gap`} />}
      {/* Compact: the full feed is one link away. */}
      {pending.slice(0, 2).map((r) => (
        <CardRow key={r.id} r={r} current={currentIds.has(r.id)} />
      ))}
      {data?.rows.slice(0, 2).map((r) => (
        <CardRow key={r.id} r={r} current={currentIds.has(r.id)} />
      ))}
      {empty && <Mono size="11px">No curator exit in the feed window.</Mono>}
      <HStack justify="space-between" align="center" spacing={SPACING.base} flexWrap="wrap">
        <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
          {Number.isFinite(collected) ? `collected ${utc(Math.floor(collected / 1000))}` : ''}
        </Mono>
        <Link
          as={NextLink}
          href={`/${chainName}/curator-feed`}
          display="inline-flex"
          alignItems="center"
          minH="44px"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="13px"
          color={SEMANTIC_COLORS.textPrimary}
          textDecoration="underline"
          textUnderlineOffset="3px"
          _focusVisible={FOCUS_STYLES.ring}
        >
          Full feed →
        </Link>
      </HStack>
    </Box>
  )
}

export default CuratorFeed
