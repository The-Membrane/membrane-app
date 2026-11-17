import React, { useEffect, useMemo, useState } from 'react'
import { Box, HStack, Input, SimpleGrid, Text, VStack } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, Stat } from '@/components/Evidence/atoms'

import {
  DEFAULT_RULES,
  applyWhatIf,
  checkRules,
  debtChangeForDistance,
  distanceForShare,
  type Breaches,
  type Rules,
} from './marketsLogic'
import type { XrayReserve } from './xrayLogic'

// X-ray add-ons: crash history (price risk), carry at today's rates (ratio loops)
// and a what-if simulator. History and carry are measured inputs; the what-if is
// deterministic arithmetic on the position read. None of it is a forecast.

const pct = (v: number | null, dp = 1) => (v === null ? '—' : `${(v * 100).toFixed(dp)}%`)

type Replay = {
  start: string
  drop: number
  aave: { liquidated: boolean; hour: number | null }
  membrane: {
    outcome: 'survived' | 'immediate' | 'timer'
    hour: number | null
    timerStartHour: number | null
  }
}

const memLabel = (m: Replay['membrane']) =>
  m.outcome === 'survived'
    ? m.timerStartHour === null
      ? 'not reached'
      : `timer h${m.timerStartHour}, survived`
    : m.outcome === 'immediate'
      ? `immediate h${m.hour}${m.timerStartHour !== null ? ` (timer h${m.timerStartHour})` : ''}`
      : `timer h${m.timerStartHour} → h${m.hour}`

export const CrashHistory: React.FC<{
  history: (Breaches & { source: string; replays?: Replay[] }) | null
  distance: number | null
}> = ({ history, distance }) => {
  if (!history || distance === null) return null
  const w = ['1d', '7d', '30d'].filter((k) => history[k])
  const replays = history.replays ?? []
  return (
    <VStack align="stretch" spacing={SPACING.sm}>
      <Eyebrow>Past moves that would have crossed {pct(distance)}</Eyebrow>
      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.base}>
        {w.map((k) => (
          <Stat
            key={k}
            label={`Within ${k.replace('d', ' day')}${k === '1d' ? '' : 's'}`}
            value={`${history[k].breaches.toLocaleString('en-US')} of ${history[k].windows.toLocaleString('en-US')}`}
            sub={`worst: ${history[k].worst.map((x) => `${pct(x.drop, 0)} (${x.start})`).join(', ')}`}
            tone="muted"
          />
        ))}
      </SimpleGrid>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        Every day starts one window, so windows overlap. A count of history, not a probability ·{' '}
        {history.source}
      </Text>
      {replays.length ? (
        <Box pt={SPACING.sm}>
          <Eyebrow>Replay: this position in past crashes, Aave vs Membrane rules</Eyebrow>
          <Box
            as="table"
            w="100%"
            mt={SPACING.xs}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
          >
            <Box as="thead">
              <Box as="tr" color={SEMANTIC_COLORS.textTertiary}>
                <Box as="th" textAlign="left" fontWeight="normal" py={SPACING.xs}>
                  CRASH
                </Box>
                <Box as="th" textAlign="right" fontWeight="normal">
                  7D DROP
                </Box>
                <Box as="th" textAlign="right" fontWeight="normal">
                  AAVE
                </Box>
                <Box as="th" textAlign="right" fontWeight="normal">
                  MEMBRANE
                </Box>
                <Box as="th" textAlign="right" fontWeight="normal">
                  EXTRA TIME
                </Box>
              </Box>
            </Box>
            <Box as="tbody">
              {replays.map((r) => {
                const memHour = r.membrane.outcome === 'survived' ? null : r.membrane.hour
                const extra =
                  r.aave.hour === null
                    ? '—'
                    : memHour === null
                      ? 'not liquidated'
                      : `${memHour - r.aave.hour >= 0 ? '+' : ''}${memHour - r.aave.hour} h`
                return (
                  <Box
                    as="tr"
                    key={r.start}
                    borderTop="1px solid"
                    borderColor={SEMANTIC_COLORS.hairline}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    <Box as="td" py={SPACING.xs}>
                      {r.start}
                    </Box>
                    <Box as="td" textAlign="right">
                      {pct(r.drop, 0)}
                    </Box>
                    <Box as="td" textAlign="right">
                      {r.aave.liquidated ? `liquidated h${r.aave.hour}` : 'not reached'}
                    </Box>
                    <Box as="td" textAlign="right">
                      {memLabel(r.membrane)}
                    </Box>
                    <Box
                      as="td"
                      textAlign="right"
                      color={
                        extra.startsWith('-') ? SEMANTIC_COLORS.dangerText : SEMANTIC_COLORS.success
                      }
                    >
                      {extra}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Box>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            mt={SPACING.xs}
          >
            Same distance, opened at the close before each crash, no action taken. Aave: first
            hourly low at the line (near-spot oracle). Membrane (LiquidationEngine rules): 1-hour
            average price (proxy: hourly OHLC mean; within 4 h of a 1-minute geometric average on
            five BTC crashes); below line/1.04 immediate; at the line an 8 h timer, liquidated on a
            re-dip in hours 8–16; no keeper clearing assumed. Extra time = hours Membrane gives
            before liquidation. Binance 1 h bars; history, not a forecast.
          </Text>
        </Box>
      ) : null}
    </VStack>
  )
}

export const CarryAtRates: React.FC<{
  carry: { carryGapPerYear: number | null; daysToHf1: number | null } | null
}> = ({ carry }) => {
  if (!carry || carry.carryGapPerYear === null) return null
  const rising = carry.carryGapPerYear <= 0
  return (
    <VStack align="stretch" spacing={SPACING.xs}>
      <Eyebrow>Carry at today&apos;s rates</Eyebrow>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={rising ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}
      >
        {rising
          ? `Health rises ${pct(-carry.carryGapPerYear, 2)} a year: the yield beats the borrow rate.`
          : `Health falls ${pct(carry.carryGapPerYear, 2)} a year${
              carry.daysToHf1 !== null
                ? `: liquidation in about ${Math.round(carry.daysToHf1)} days if rates held`
                : ''
            }.`}
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        Yield = 30-day growth of the collateral&apos;s oracle ratio to WETH. Rates held constant:
        arithmetic, not a forecast.
      </Text>
    </VStack>
  )
}

const Field: React.FC<{
  label: string
  value: string
  onChange: (v: string) => void
  suffix: string
}> = ({ label, value, onChange, suffix }) => (
  <VStack align="stretch" spacing={SPACING.xs}>
    <Text
      as="label"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.label}
      textTransform="uppercase"
      letterSpacing="0.28em"
      color={SEMANTIC_COLORS.textSecondary}
    >
      {label}
      <HStack spacing={SPACING.xs} mt={SPACING.xs}>
        <Input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          borderRadius={0}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.hairline}
          transition={TRANSITIONS.colorAndBorder}
          _focus={FOCUS_STYLES.ring}
          minH="44px"
        />
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {suffix}
        </Text>
      </HStack>
    </Text>
  </VStack>
)

export const WhatIfSimulator: React.FC<{
  reserves: (XrayReserve & { stable: boolean })[]
  main: string
  ratioOnly?: boolean
}> = ({ reserves, main, ratioOnly = false }) => {
  const [move, setMove] = useState('-10')
  const [repay, setRepay] = useState('0')
  const [add, setAdd] = useState('0')
  const num = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0)
  const out = useMemo(
    () =>
      applyWhatIf(
        reserves,
        { priceMovePct: num(move), repayUsd: num(repay), addCollateralUsd: num(add), ratioOnly },
        main,
      ),
    [reserves, move, repay, add, main, ratioOnly],
  )
  const liquidated = out.healthFactor !== null && out.healthFactor < 1
  return (
    <VStack align="stretch" spacing={SPACING.sm}>
      <Eyebrow>What if</Eyebrow>
      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.base}>
        <Field
          label={ratioOnly ? `${main} vs debt asset` : 'Non-stable prices'}
          value={move}
          onChange={setMove}
          suffix="%"
        />
        <Field label="Repay debt" value={repay} onChange={setRepay} suffix="USD" />
        <Field label={`Add ${main}`} value={add} onChange={setAdd} suffix="USD" />
      </SimpleGrid>
      <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.hairline} pt={SPACING.sm}>
        <SimpleGrid columns={{ base: 2, md: 3 }} spacing={SPACING.base}>
          <Stat
            label="Health factor"
            value={out.healthFactor === null ? 'no debt' : out.healthFactor.toFixed(3)}
            tone={liquidated ? 'bad' : 'default'}
            sub={liquidated ? 'liquidatable' : undefined}
          />
          <Stat
            label="Distance"
            value={liquidated ? 'past the line' : pct(out.distance)}
            sub={liquidated ? undefined : (out.band ?? undefined)}
          />
          <Stat
            label="Liquidation price"
            value={
              out.liquidationPrice === null
                ? '—'
                : `$${Number(out.liquidationPrice.toPrecision(5)).toLocaleString('en-US')}`
            }
          />
        </SimpleGrid>
      </Box>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        {ratioOnly
          ? 'Collateral moves against the debt asset (the ratio); repayment is spread over the debt pro rata.'
          : 'Every non-stable price moves together, stables fixed; repayment is spread over the debt pro rata.'}
      </Text>
    </VStack>
  )
}

const RULES_KEY = 'membrane.xrayRules'

function loadRules(): Rules {
  try {
    const raw = window.localStorage.getItem(RULES_KEY)
    return raw ? { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<Rules>) } : DEFAULT_RULES
  } catch {
    return DEFAULT_RULES
  }
}

/** Your own rules, checked against this read. Stored only in this browser; nothing is enforced or sent. */
export const RulesCheck: React.FC<{
  healthFactor: number | null
  distance: number | null
  past7d: { windows: number; breaches: number } | null
  curve?: { d: number; share: number }[] | null
  reserves?: (XrayReserve & { stable: boolean })[]
}> = ({ healthFactor, distance, past7d, curve = null, reserves = [] }) => {
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES)
  useEffect(() => setRules(loadRules()), [])
  const update = (k: keyof Rules, v: string) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return
    const next = { ...rules, [k]: n }
    setRules(next)
    try {
      window.localStorage.setItem(RULES_KEY, JSON.stringify(next))
    } catch {
      /* private mode: rules last for this visit only */
    }
  }
  const results = checkRules(rules, { healthFactor, distance, past7d })
  return (
    <VStack align="stretch" spacing={SPACING.sm}>
      <Eyebrow>Your rules</Eyebrow>
      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.base}>
        <Field
          label="Min health factor"
          value={String(rules.minHealthFactor)}
          onChange={(v) => update('minHealthFactor', v)}
          suffix=""
        />
        <Field
          label="Min distance"
          value={String(rules.minDistancePct)}
          onChange={(v) => update('minDistancePct', v)}
          suffix="%"
        />
        <Field
          label="Max past crossings"
          value={String(rules.maxPast7dCrossPct)}
          onChange={(v) => update('maxPast7dCrossPct', v)}
          suffix="%"
        />
      </SimpleGrid>
      {results.map((r) => (
        <HStack
          key={r.rule}
          justify="space-between"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
        >
          <Text color={SEMANTIC_COLORS.textSecondary}>{r.rule}</Text>
          <Text
            color={
              r.pass === null
                ? SEMANTIC_COLORS.textTertiary
                : r.pass
                  ? SEMANTIC_COLORS.success
                  : SEMANTIC_COLORS.dangerText
            }
          >
            {r.pass === null ? 'n/a' : r.pass ? 'pass' : 'fail'} · {r.detail}
          </Text>
        </HStack>
      ))}
      {curve && reserves.length ? (
        <SafeSize rules={rules} curve={curve} reserves={reserves} />
      ) : null}
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        Saved in this browser only. A check, not an automation: nothing is enforced or sent.
      </Text>
    </VStack>
  )
}

/** Your rules as a size: repay or room to borrow to meet the stricter of min distance and max crossings. */
const SafeSize: React.FC<{
  rules: Rules
  curve: { d: number; share: number }[]
  reserves: (XrayReserve & { stable: boolean })[]
}> = ({ rules, curve, reserves }) => {
  const dCross = distanceForShare(curve, rules.maxPast7dCrossPct / 100)
  const target = Math.max(rules.minDistancePct / 100, dCross ?? 0)
  const change = dCross === null ? null : debtChangeForDistance(reserves, target)
  return (
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.small}
      color={SEMANTIC_COLORS.textPrimary}
    >
      {dCross === null
        ? `No distance up to 60% keeps past crossings at ${rules.maxPast7dCrossPct}% or less.`
        : change === null
          ? '—'
          : `To meet both: distance ${(target * 100).toFixed(0)}% → ${
              change < 0
                ? `repay about $${Math.round(-change).toLocaleString('en-US')}`
                : `room to borrow about $${Math.round(change).toLocaleString('en-US')} more`
            } (debt scaled pro rata).`}
    </Text>
  )
}
