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

import React, { useMemo, useState } from 'react'
import NextLink from 'next/link'
import { Box, HStack, Input, Link, Stack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Eyebrow, SectionHeading, Stamp } from '@/components/Carry/atoms'
import { Card } from '@/components/ui/Card'
import { useChainRoute } from '@/hooks/useChainRoute'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { compact, durationText, utc } from '@/lib/curatorFeed/format'
import type {
  AttributionView,
  ClusterView,
  ExposureResponse,
  FeedResponse,
  FeedRow,
  Group,
  SpikeView,
  VaultExposureView,
} from '@/lib/curatorFeed/service'
import type { Tone } from '@/lib/curatorFeed/status'

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

const Mono: React.FC<{
  children: React.ReactNode
  color?: string
  size?: string
  as?: 'span' | 'p'
  title?: string
}> = ({ children, color, size = '11px', as = 'p', title }) => (
  <Text
    as={as}
    title={title}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={size}
    color={color ?? SEMANTIC_COLORS.textSecondary}
    sx={{ fontVariantNumeric: 'tabular-nums' }}
  >
    {children}
  </Text>
)

const Chip: React.FC<{ active?: boolean; onClick?: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <Box
    as="button"
    type="button"
    onClick={onClick}
    aria-pressed={active}
    px={SPACING.sm}
    py="2px"
    border="1px solid"
    borderRadius={0}
    borderColor={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
    color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.12em"
    textTransform="uppercase"
    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
  >
    {children}
  </Box>
)

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

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const body = await r.json()
  if (!r.ok) throw new Error(body?.error ?? `${url} ${r.status}`)
  return body as T
}

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
              {v.totalUsd !== undefined ? `$${compact(v.totalUsd)}` : v.loanSymbol} ·{' '}
              {v.allocations.length} allocation{v.allocations.length === 1 ? '' : 's'}
            </Mono>
          </HStack>
          {open === v.vault && (
            <Box pl={SPACING.base} pb={SPACING.sm}>
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
                  </Mono>
                  <Mono size="11px">
                    {compact(a.amount)} {v.loanSymbol}
                    {a.usd !== undefined ? ` ($${compact(a.usd)})` : ''} ·{' '}
                    {(a.share * 100).toFixed(1)}%
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
        adapters, Euler Earn strategies) at the head block. USD at collection-time prices.
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
                      {h.usd !== undefined ? ` ($${compact(h.usd)})` : ''} ·{' '}
                      {(h.shareOfVault * 100).toFixed(1)}% of vault
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

/** Compact card: open clusters and the next timelocks to elapse. Links to the full page. */
export const CuratorFeedCard: React.FC = () => {
  const { chainName } = useChainRoute()
  const { data } = useQuery<FeedResponse>({
    queryKey: ['curator_feed_card'],
    queryFn: () => getJson('/api/curator-feed?group=exits&limit=5'),
    staleTime: 5 * 60_000,
  })
  const nowS = data?.meta.now ?? Math.floor(Date.now() / 1000)
  return (
    <Card p={SPACING.base}>
      <HStack justify="space-between" align="baseline">
        <Eyebrow>Curator actions</Eyebrow>
        <Link
          as={NextLink}
          href={`/${chainName}/curator-feed`}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          color={SEMANTIC_COLORS.textSecondary}
        >
          full feed →
        </Link>
      </HStack>
      {!data && <Mono size="11px">loading…</Mono>}
      {data?.clusters.slice(0, 2).map((c) => (
        <Mono key={`${c.collateral}:${c.start}`} size="12px" color={SEMANTIC_COLORS.danger}>
          {c.text} ({utc(c.end).slice(0, 10)})
        </Mono>
      ))}
      {data?.open
        .filter((r) => r.status === 'pending')
        .slice(0, 3)
        .map((r) => (
          <ActionRow key={r.id} r={r} nowS={nowS} />
        ))}
      {data?.rows.slice(0, 3).map((r) => (
        <ActionRow key={r.id} r={r} nowS={nowS} />
      ))}
    </Card>
  )
}

export default CuratorFeed
