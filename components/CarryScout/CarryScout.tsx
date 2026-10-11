// /[chain]/carry-scout — the weekly positive-carry scout (umbrella product #10).
//
// Ranked on (a) MARKET CARRY: the venue's net APY at a size minus the cheapest same-stable
// borrow. (b) MEMBRANE CARRY sits beside it for every row: base yield, and base + rewards
// "if vaults claim rewards (not yet)". Non-USDC rows are ranked but greyed out: "not
// deployable yet (vaults hold USDC)". Stables with no benchmark are listed unranked with
// (b) only — never another stable's borrow rate.
//
// COPY: "positive carry" is the spread measured at the last scan, never a promise. Membrane's
// charge is a curator-set share of yield; never 0%, $0 or "free". docs/CARRY_SCOUT.md.

import React, { useMemo, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { Eyebrow, Stamp } from '@/components/Carry/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CARRY_SCAN_NOTES } from '@/lib/carryScan/copy'
import { parseSharePct, shortAppSha } from '@/lib/carryScan/format'
import type { CarryScanView } from '@/lib/carryScan/load'
import { CARRY_SCOUT_LAUNCHED } from '@/lib/carryScan/readiness'
import type { ScoutRow, SizeKey } from '@/lib/carryScan/types'
import type { MembraneShareInput } from '@/lib/netApy/breakdown'
import { CARRY_CLAIMS } from '@/lib/position-sim/guarantee'

import { ScoutFilters, TAB_LABEL, type ScoutTab, type ShareText } from './ScoutFilters'
import { ScoutTable } from './ScoutTable'

const LAUNCH = { launched: CARRY_SCOUT_LAUNCHED, factoriesConfigured: false }

const EMPTY: Record<ScoutTab, string> = {
  ranked: 'No verified venue beat its same-stable borrow benchmark at this scan.',
  lp: 'No stable LP beat its benchmark at this scan.',
  'no-benchmark': 'Every listed stable had a borrow benchmark.',
  unverified: 'Every finalist verified on-chain.',
  dropped: 'Nothing dropped since last week.',
}

export interface CarryScoutProps {
  view: CarryScanView
}

export const CarryScout: React.FC<CarryScoutProps> = ({ view }) => {
  const { file } = view
  const [tab, setTab] = useState<ScoutTab>('ranked')
  const [sizeKey, setSizeKey] = useState<SizeKey>('100k')
  const [stable, setStable] = useState('All')
  const [shareText, setShareText] = useState<ShareText>({ protocol: '', curator: '' })

  const p = parseSharePct(shareText.protocol)
  const c = parseSharePct(shareText.curator)
  const shareError = p.error ?? c.error ?? null
  const share: MembraneShareInput = shareError
    ? {}
    : { protocolShare: p.value, curatorShare: c.value }

  const byList = useMemo(() => {
    const m: Record<Exclude<ScoutTab, 'dropped'>, ScoutRow[]> = {
      ranked: [],
      lp: [],
      'no-benchmark': [],
      unverified: [],
    }
    for (const r of file.rows) m[r.list].push(r)
    return m
  }, [file.rows])
  const stables = useMemo(() => [...new Set(file.rows.map((r) => r.stable))].sort(), [file.rows])
  const counts: Record<ScoutTab, number> = {
    ranked: byList.ranked.length,
    lp: byList.lp.length,
    'no-benchmark': byList['no-benchmark'].length,
    unverified: byList.unverified.length,
    dropped: file.dropped.length + file.nowOnApp.length,
  }
  const rows =
    tab === 'dropped' ? [] : byList[tab].filter((r) => stable === 'All' || r.stable === stable)

  return (
    <Box
      maxW="1140px"
      mx="auto"
      px={SPACING.base}
      py={SPACING.lg}
      bg={SEMANTIC_COLORS.bgPrimary}
      color={SEMANTIC_COLORS.textPrimary}
    >
      <Eyebrow>Weekly carry scout · {file.week}</Eyebrow>
      <Text
        as="h1"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h1}
        letterSpacing="-0.01em"
        mt={SPACING.sm}
      >
        Stable venues that beat their own borrow rate
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textSecondary}
        mt={SPACING.xs}
      >
        Ethereum stables only · not exhaustive · reported numbers are DeFiLlama’s
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textTertiary}
        mt={SPACING.xs}
        maxW="760px"
      >
        (a) market carry = the venue’s net APY at your size minus the cheapest borrow of the same
        stable. (b) Membrane carry = the venue’s yield after Membrane’s curator-set share, with no
        borrow term. Positive carry here is the spread measured at the last scan, not a promise.
      </Text>

      {view.banner ? (
        <Box
          mt={SPACING.sm}
          px={SPACING.sm}
          py={SPACING.xs}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.warning}
          role="status"
        >
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.warning}>
            {view.banner}
          </Text>
        </Box>
      ) : null}

      <ScoutFilters
        tab={tab}
        onTab={setTab}
        counts={counts}
        sizeKey={sizeKey}
        onSize={setSizeKey}
        stable={stable}
        onStable={setStable}
        stables={stables}
        share={shareText}
        onShare={setShareText}
        shareError={shareError}
      />

      {tab === 'dropped' ? (
        <Box as="ul" mt={SPACING.sm} p={0}>
          {file.nowOnApp.map((r) => (
            <Box
              as="li"
              key={r.key}
              listStyleType="none"
              py={SPACING.xs}
              borderTop="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.success}
              >
                {r.label} · {r.protocol} · {r.stable} — {r.note}
              </Text>
            </Box>
          ))}
          {file.dropped.map((r) => (
            <Box
              as="li"
              key={r.key}
              listStyleType="none"
              py={SPACING.xs}
              borderTop="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textSecondary}
              >
                {r.label} · {r.protocol} · {r.stable} — passed {r.lastPassedWeek}, failed:{' '}
                {r.failedGate}
              </Text>
            </Box>
          ))}
          {!counts.dropped ? (
            <Text
              mt={SPACING.sm}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              color={SEMANTIC_COLORS.textTertiary}
            >
              {EMPTY.dropped}
            </Text>
          ) : null}
        </Box>
      ) : (
        <ScoutTable
          rows={rows}
          ranked={tab === 'ranked' || tab === 'lp'}
          sizeKey={sizeKey}
          share={share}
          launch={LAUNCH}
          empty={EMPTY[tab]}
        />
      )}

      <Box mt={SPACING.lg}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10.5px"
          color={SEMANTIC_COLORS.textSecondary}
          maxW="760px"
        >
          {CARRY_CLAIMS[0]}
        </Text>
        {[
          ...CARRY_SCAN_NOTES,
          // This file's own rule (an older snapshot says it predates averaging) and its
          // /carry route notes (classes are annotated, never hidden; unresolved labels).
          ...(file.venueApyRule ? [file.venueApyRule] : []),
          ...(file.notes ?? []).filter((n) => n.startsWith('/carry route')),
        ].map((n) => (
          <Text
            key={n}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textTertiary}
            maxW="760px"
            mt="2px"
          >
            {n}
          </Text>
        ))}
        <Stamp>
          {TAB_LABEL.ranked.toUpperCase()} {counts.ranked} · SCAN {file.week} ·{' '}
          {new Date(file.asOf * 1000).toISOString().slice(0, 10)} · BLOCK{' '}
          {file.anchor?.blockNumber ?? '—'} · {file.rpc} · APP {shortAppSha(file.appSha) ?? '—'} ·{' '}
          {view.source === 'live' ? 'DATA BRANCH' : 'FALLBACK SNAPSHOT'} · $1.00/STABLE · NOT A
          FORECAST
        </Stamp>
      </Box>
    </Box>
  )
}

export default CarryScout
