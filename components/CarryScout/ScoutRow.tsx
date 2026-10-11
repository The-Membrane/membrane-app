// One scout row: rank + status, venue, the two carry columns, stability, readiness and the
// segue. Every number carries its label class (TVL and the 90-day stability are DeFiLlama's,
// so `reported`). Non-USDC rows are greyed out: "not deployable yet (vaults hold USDC)" — with
// a grayscale filter, not opacity, so their text keeps its contrast.
// (b) is "≤ x% · curator-set" until shares are given. An Unverified row has no CTA.
// The venue APY opens its sources (hover, focus or tap): a vault row's figure is the average of
// its sources (lib/carryScan/venueApy.ts). A row whose contract is behind a /carry route CLASS
// stays listed and says so: "also behind /carry route <label>" (owner ruling 2, 2026-10-11).

import React, { useState } from 'react'
import { Box, Link, Text } from '@chakra-ui/react'

import { BreakdownRows, ClassTag } from '@/components/NetApy/BreakdownRows'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { carryBPair, WITH_REWARDS_NOTE } from '@/lib/carryScan/columns'
import { formatCarryB, pct, sizeLabel, spread, usdCompact } from '@/lib/carryScan/format'
import { ctaFor, NOT_DEPLOYABLE_LABEL, type LaunchEnv } from '@/lib/carryScan/readiness'
import { sizeUsdOf, THRESHOLDS, type ScoutRow as Row, type SizeKey } from '@/lib/carryScan/types'
import type { MembraneShareInput, BreakdownRow } from '@/lib/netApy/breakdown'
import type { LabelClass } from '@/lib/netApy/types'

import { ApySources, methodTag, RAISE_WHEN_OPEN } from './ApySources'

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

const Chip: React.FC<{ children: React.ReactNode; color?: string; title?: string }> = ({
  children,
  color,
  title,
}) => (
  <Text
    as="span"
    title={title}
    display="inline-block"
    px="6px"
    py="1px"
    mr="4px"
    border="1px solid"
    borderColor={color ?? SEMANTIC_COLORS.borderSubtle}
    color={color ?? SEMANTIC_COLORS.textSecondary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="8.5px"
    letterSpacing="0.14em"
    textTransform="uppercase"
  >
    {children}
  </Text>
)

const Cell: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <Box minW={0}>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="8.5px"
      letterSpacing="0.18em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
    >
      {label}
    </Text>
    {children}
  </Box>
)

/**
 * How a not-deployable (non-USDC) row is greyed out. Grayscale keeps each colour's luminance,
 * so text keeps its contrast; opacity 0.62 dropped textSecondary from 5.58:1 to 2.77:1 on the
 * dark theme (WCAG AA asks 4.5:1).
 */
export const NOT_DEPLOYABLE_FILTER = 'grayscale(1)'

const STATUS_COLOR: Record<string, string> = {
  NEW: SEMANTIC_COLORS.success,
  STILL: SEMANTIC_COLORS.textSecondary,
  RETURNING: SEMANTIC_COLORS.info,
}

const uuidOf = (r: Row): string | null =>
  r.aliases.find((a) => a.startsWith('llama:'))?.slice('llama:'.length) ?? null

export interface ScoutRowProps {
  row: Row
  sizeKey: SizeKey
  /** Validated what-if shares; empty = curator-set (upper bound). */
  share: MembraneShareInput
  launch: LaunchEnv
  /** Rank at the selected size (re-ranked client-side), or null. */
  rank: number | null
}

export const ScoutRowView: React.FC<ScoutRowProps> = ({ row, sizeKey, share, launch, rank }) => {
  const [open, setOpen] = useState(false)
  const k = sizeKey
  const greyed = row.readiness.tier === 'not-deployable'
  const b =
    share.protocolShare !== undefined || share.curatorShare !== undefined
      ? carryBPair(row.venueNetBase[k], row.venueNet[k], share)
      : row.carryB[k]
  const a = row.carryA[k]
  const aBase = row.carryABase[k]
  const bench = row.bench[k]
  const net = row.venueNet[k]
  const uuid = uuidOf(row)
  const cta = ctaFor(row, launch)
  const breakdown = row.breakdown as {
    rows?: BreakdownRow[]
    anchor?: { blockNumber?: string }
  } | null

  return (
    <Box
      as="li"
      listStyleType="none"
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      py={SPACING.sm}
      filter={greyed ? NOT_DEPLOYABLE_FILTER : undefined}
      sx={RAISE_WHEN_OPEN}
      data-testid="scout-row"
    >
      <Box display="flex" alignItems="baseline" gap={SPACING.sm} flexWrap="wrap">
        <Mono as="span" size="13px" color={SEMANTIC_COLORS.textPrimary}>
          {rank !== null ? `#${rank}` : '—'}
        </Mono>
        {row.status ? (
          <Chip color={STATUS_COLOR[row.status]}>
            {row.status === 'STILL' ? `still · ${row.weeksInRow}w` : row.status.toLowerCase()}
          </Chip>
        ) : null}
        <Text
          as="span"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize="16px"
          color={SEMANTIC_COLORS.textPrimary}
          wordBreak="break-word"
        >
          {row.label}
        </Text>
        <Mono as="span">
          {row.protocol} · {row.stable} · {row.kind}
        </Mono>
        {greyed ? <Chip>{NOT_DEPLOYABLE_LABEL}</Chip> : null}
        {row.flags.includes('basis-trading') ? (
          <Chip color={SEMANTIC_COLORS.warning}>basis trading</Chip>
        ) : null}
        {row.flags.includes('source-disagreement') ? (
          <Chip color={SEMANTIC_COLORS.warning} title={disagreementTitle(row)}>
            source disagreement{spreadPp(row) ? ` · ${spreadPp(row)}` : ''}
          </Chip>
        ) : null}
      </Box>
      {row.alsoBehindRoutes?.length ? (
        <Mono size="10px" color={SEMANTIC_COLORS.info}>
          {row.alsoBehindRoutes.map((l) => `also behind /carry route ${l}`).join(' · ')}
        </Mono>
      ) : null}

      <Box
        mt={SPACING.xs}
        display="grid"
        gridTemplateColumns="repeat(auto-fit, minmax(128px, 1fr))"
        columnGap={SPACING.md}
        rowGap={SPACING.xs}
      >
        <Cell label="TVL · history">
          <Mono>
            {usdCompact(row.tvlUsd)} · {row.count}d <ClassTag c="reported" />
          </Mono>
          <Box>
            <Chip>≥{THRESHOLDS.minCount}d</Chip>
            {row.count >= THRESHOLDS.badgeCount ? <Chip>≥{THRESHOLDS.badgeCount}d</Chip> : null}
            {row.persistent ? <Chip color={SEMANTIC_COLORS.success}>persistent</Chip> : null}
          </Box>
        </Cell>
        <Cell label={`Venue net @ ${sizeLabel(sizeUsdOf(k))}`}>
          <ApySources
            venueApy={row.venueApy}
            atSize={net}
            sizeUsd={sizeUsdOf(k)}
            rowLabel={row.label}
          >
            <Mono as="span" color={SEMANTIC_COLORS.textPrimary}>
              {net.apy === null ? (net.note ?? '—') : pct(net.apy)}
            </Mono>{' '}
            <Mono as="span" size="9.5px" color={SEMANTIC_COLORS.textTertiary}>
              {methodTag(row.venueApy)}
            </Mono>
          </ApySources>
          <Box>
            <ClassTag c={net.labelClass} />
          </Box>
        </Cell>
        <Cell label="Benchmark borrow">
          {bench ? (
            <>
              <Mono title={bench.venue}>
                {pct(bench.apy)} · {bench.venue}
              </Mono>
              <ClassTag c={bench.labelClass as LabelClass} />
            </>
          ) : (
            <Mono>no same-stable borrow</Mono>
          )}
        </Cell>
        <Cell label="(a) market carry">
          {a ? (
            <>
              <Mono
                size="13px"
                color={(a.apy ?? 0) > 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
              >
                {spread(a.apy)} <ClassTag c={a.labelClass} />
              </Mono>
              <Mono size="10px">
                base only {spread(aBase?.apy)}
                {aBase ? (
                  <>
                    {' '}
                    <ClassTag c={aBase.labelClass} />
                  </>
                ) : null}
              </Mono>
            </>
          ) : (
            <Mono>{net.apy === null ? 'unranked at this size' : '—'}</Mono>
          )}
        </Cell>
        <Cell label="(b) Membrane carry">
          <Mono size="13px" color={SEMANTIC_COLORS.textPrimary}>
            {formatCarryB(b.base)} <ClassTag c={b.base.labelClass} />
          </Mono>
          <Mono size="10px" title={WITH_REWARDS_NOTE}>
            with rewards {formatCarryB(b.withRewards)} · {WITH_REWARDS_NOTE}{' '}
            <ClassTag c={b.withRewards.labelClass} />
          </Mono>
        </Cell>
        <Cell label="Stability (90d)">
          <Mono>
            {row.stability?.sigma90Pp !== null && row.stability?.sigma90Pp !== undefined
              ? `σ ${row.stability.sigma90Pp.toFixed(2)}pp`
              : 'σ —'}{' '}
            ·{' '}
            {row.stability?.spikeRatio !== null && row.stability?.spikeRatio !== undefined
              ? `${row.stability.spikeRatio.toFixed(2)}× median`
              : '—'}{' '}
            <ClassTag c="reported" />
          </Mono>
        </Cell>
        <Cell label="Readiness">
          <Chip
            color={row.readiness.tier.startsWith('ready') ? SEMANTIC_COLORS.info : undefined}
            title={row.readiness.blockers.join('\n')}
          >
            {row.readiness.tier}
          </Chip>
          <Mono size="10px">
            {row.readiness.blockers.length
              ? `${row.readiness.blockers.length} blocker${row.readiness.blockers.length > 1 ? 's' : ''}`
              : 'no blockers'}
          </Mono>
        </Cell>
      </Box>

      <Box mt={SPACING.xs} display="flex" gap={SPACING.md} flexWrap="wrap" alignItems="baseline">
        <Box
          as="button"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          letterSpacing="0.12em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.primary}
        >
          {open ? 'hide breakdown' : 'breakdown'}
        </Box>
        {row.address ? (
          <Link
            href={`https://etherscan.io/address/${row.address}`}
            isExternal
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textSecondary}
            textDecoration="underline"
          >
            etherscan
          </Link>
        ) : null}
        {uuid ? (
          <Link
            href={`https://defillama.com/yields/pool/${uuid}`}
            isExternal
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textSecondary}
            textDecoration="underline"
          >
            defillama
          </Link>
        ) : null}
        {cta ? (
          <Box
            as="button"
            type="button"
            disabled={!cta.enabled}
            title={row.readiness.route}
            data-testid="scout-cta"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={cta.enabled ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textTertiary}
            cursor={cta.enabled ? 'pointer' : 'not-allowed'}
            textAlign="left"
          >
            {cta.label}
          </Box>
        ) : null}
      </Box>

      {open ? (
        <Box
          mt={SPACING.sm}
          pl={SPACING.sm}
          borderLeft="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {breakdown?.rows?.length ? (
            <>
              <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                on-chain IRM at block {breakdown.anchor?.blockNumber ?? '—'}, at $100K (supply side,
                no share given)
              </Mono>
              <BreakdownRows rows={breakdown.rows} />
            </>
          ) : row.venueApy.method === 'average' ? (
            <Mono size="10.5px">
              Averaged APY {pct(row.venueApy.withRewards)} (base {pct(row.venueApy.base)}) from{' '}
              {new Set(row.venueApy.sources.filter((x) => x.averaged).map((x) => x.source)).size}{' '}
              sources × TVL/(TVL+size) → {pct(net.apy)} at {sizeLabel(sizeUsdOf(k))}. DeFiLlama
              alone: {pct(row.apy)}. 30-day mean {pct(row.apyMean30d)} (DeFiLlama) − this week’s
              benchmark = {spread(row.carryA30d)}.
            </Mono>
          ) : (
            <Mono size="10.5px">
              DeFiLlama APY {pct(row.apy)}
              {row.apyBase !== null ? ` (base ${pct(row.apyBase)}` : ''}
              {row.apyReward !== null
                ? ` + rewards ${pct(row.apyReward)})`
                : row.apyBase !== null
                  ? ')'
                  : ''}{' '}
              × TVL/(TVL+size) → {pct(net.apy)} at {sizeLabel(sizeUsdOf(k))}. 30-day mean{' '}
              {pct(row.apyMean30d)} − this week’s benchmark = {spread(row.carryA30d)}.
            </Mono>
          )}
          <Mono size="10.5px">Route: {row.readiness.route}</Mono>
          {row.readiness.blockers.map((x) => (
            <Mono key={x} size="10.5px" color={SEMANTIC_COLORS.textTertiary}>
              · {x}
            </Mono>
          ))}
          {row.verification ? (
            <Mono
              size="10.5px"
              color={row.verification.ok ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.danger}
            >
              on-chain checks: {row.verification.checks.join(', ') || 'none'}
              {row.verification.failed ? ` · failed: ${row.verification.failed}` : ''}
              {row.verification.trailing7dApy !== null &&
              row.verification.trailing7dApy !== undefined
                ? ` · trailing 7d ${pct(row.verification.trailing7dApy)}`
                : ''}
            </Mono>
          ) : null}
          {row.unrankedReason ? (
            <Mono size="10.5px" color={SEMANTIC_COLORS.warning}>
              unranked: {row.unrankedReason}
            </Mono>
          ) : null}
          {row.segue.kind !== 'none' ? (
            <Box wordBreak="break-all">
              <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                segue {row.segue.kind} · impl {row.segue.implId} · venueData {row.segue.venueData}
              </Mono>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

/** The largest spread across the averaged sources, e.g. "1.32pp", or null. */
export function spreadPp(row: Row): string | null {
  const xs = [row.venueApy?.spread.base, row.venueApy?.spread.withRewards].filter(
    (x): x is number => typeof x === 'number' && Number.isFinite(x),
  )
  return xs.length ? `${(Math.max(...xs) * 100).toFixed(2)}pp` : null
}

function disagreementTitle(row: Row): string {
  return row.venueApy?.method === 'average'
    ? `The averaged sources spread more than ${THRESHOLDS.sourceDisagreementPp}pp (max − min of one basis). Open the venue APY to see each one.`
    : `7-day on-chain share-price growth is more than ${THRESHOLDS.sourceDisagreementPp}pp from DeFiLlama’s base APY (its 7-day base APY where published)`
}

export default ScoutRowView
