import React, { memo, useMemo } from 'react'
import { Box, Button, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { MockStamp } from '@/components/demo'

import {
  healthBarModel,
  inAppNotice,
  type Alert,
  type BarMarker,
  type BarState,
  type HealthBarModel,
  type LiquidationTimer,
  type PositionSnapshot,
} from '@/lib/positionAlerts'
import { fmtHf, fmtPct, fmtPrice } from '@/lib/positionAlerts/format'

/** Theme-aware tint of a semantic token; pure CSS, so it renders the same on the server. */
const tint = (token: string, pct: number) => `color-mix(in srgb, ${token} ${pct}%, transparent)`

const STATE_COLOR: Record<BarState, string> = {
  clear: SEMANTIC_COLORS.success,
  watch: SEMANTIC_COLORS.warning,
  warn: SEMANTIC_COLORS.warning,
  critical: SEMANTIC_COLORS.danger,
  'at-risk': SEMANTIC_COLORS.danger,
  'act-now': SEMANTIC_COLORS.danger,
  'no-debt': SEMANTIC_COLORS.textSecondary,
  loop: SEMANTIC_COLORS.textSecondary,
}

const STATE_LABEL: Record<BarState, string> = {
  clear: 'Clear',
  watch: 'Watch',
  warn: 'Warn',
  critical: 'Critical',
  'at-risk': 'At risk',
  'act-now': 'Act now',
  'no-debt': 'No debt',
  loop: 'Stable/PT loop',
}

/** Zone fill inside each line: the closer to the line, the stronger the tint. */
const MARKER_TINT: Record<BarMarker['id'], { color: string; pct: number }> = {
  'act-now': { color: SEMANTIC_COLORS.danger, pct: 45 },
  'at-risk': { color: SEMANTIC_COLORS.danger, pct: 28 },
  critical: { color: SEMANTIC_COLORS.danger, pct: 14 },
  warn: { color: SEMANTIC_COLORS.warning, pct: 16 },
  watch: { color: SEMANTIC_COLORS.warning, pct: 7 },
}

const MARKER_LINE: Record<BarMarker['id'], string> = {
  'act-now': SEMANTIC_COLORS.danger,
  'at-risk': SEMANTIC_COLORS.danger,
  critical: SEMANTIC_COLORS.danger,
  warn: SEMANTIC_COLORS.warning,
  watch: SEMANTIC_COLORS.warning,
}

const Label: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    letterSpacing="0.28em"
    textTransform="uppercase"
    color={color ?? SEMANTIC_COLORS.textSecondary}
  >
    {children}
  </Text>
)

export interface HealthBarProps {
  snapshot: PositionSnapshot
  /** The borrower's latest in-app alert (atRisk.ts evaluateBorrower inApp), if any. */
  alert?: Alert | null
  /** Provenance stamp, e.g. 'mock' on demo fixtures or 'Oracle.getPrice · fetched 14:32'. */
  stamp?: string
  /**
   * A started Membrane liquidation timer (LiquidationTimerStarted). Hook only: nothing reads
   * the chain for it yet. When set, the bar shows the act-now state with start, expiry and
   * the immediate-liquidation price.
   */
  timer?: LiquidationTimer | null
  /** Membrane immediate-liquidation window from chain state (stub; launch default if absent). */
  liquidationWindow?: number | null
}

/**
 * Always-visible position health bar. One row of geometry on a distance-to-liquidation
 * axis (oracle price against the liquidation price): the act-now zone through the line,
 * the R27 3% at-risk line, the health-factor ladder lines (1.05 / 1.15 / 1.30) converted to
 * distance, and the position itself. Mono numbers only; no probability is shown. The full
 * text equivalent (healthBarModel().summary) is the bar's aria-label.
 */
export const HealthBar: React.FC<HealthBarProps> = memo(
  ({ snapshot, alert, stamp, timer, liquidationWindow }) => {
    const model = useMemo(
      () =>
        healthBarModel(snapshot, undefined, {
          liquidationTimer: timer ?? null,
          liquidationWindow: liquidationWindow ?? null,
        }),
      [snapshot, timer, liquidationWindow],
    )
    const notice = useMemo(() => inAppNotice(model, alert), [model, alert])
    const color = STATE_COLOR[model.state]

    return (
      <Card id="healthbar" p={{ base: SPACING.base, md: SPACING.lg }} mb={SPACING.base}>
        {/* Header: eyebrow, provenance, state */}
        <HStack justify="space-between" align="baseline" flexWrap="wrap" spacing={SPACING.sm}>
          <HStack spacing={SPACING.sm} align="baseline">
            <Label>Position health</Label>
            {stamp && <MockStamp label={stamp} />}
          </HStack>
          <Box
            px={SPACING.sm}
            py={SPACING.xs}
            border="1px solid"
            borderColor={color}
            borderRadius={0}
          >
            <Label color={color}>{STATE_LABEL[model.state]}</Label>
          </Box>
        </HStack>

        <Headline model={model} color={color} />

        {notice && (
          <Box
            role={notice.step === 'act-now' ? 'alert' : 'status'}
            mt={SPACING.md}
            p={SPACING.md}
            borderLeft="2px solid"
            borderColor={SEMANTIC_COLORS.danger}
            bg={tint(SEMANTIC_COLORS.danger, 8)}
            borderRadius={0}
          >
            <HStack spacing={SPACING.sm} align="baseline" flexWrap="wrap">
              <Label color={SEMANTIC_COLORS.danger}>{notice.tag}</Label>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
              >
                {notice.title}
              </Text>
            </HStack>
            <Text
              mt={SPACING.xs}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {notice.detail}
            </Text>
            {notice.subtext && (
              <Text
                mt={SPACING.xs}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                data-testid="at-risk-subtext"
              >
                {notice.subtext}
              </Text>
            )}
            {notice.action && (
              // Post-recovery stub: placeholder for clearRecoveredTimer. Disabled until the
              // owner decides; no transaction is wired.
              <HStack mt={SPACING.sm} spacing={SPACING.sm} flexWrap="wrap">
                <Button
                  size="sm"
                  variant="outline"
                  borderRadius={0}
                  fontFamily={TYPOGRAPHY.fontMono}
                  isDisabled
                  aria-disabled
                  data-action={notice.action.id}
                  _focus={FOCUS_STYLES.ring}
                >
                  {notice.action.label}
                </Button>
                {/* The detail line can already carry the note; do not show or announce it twice. */}
                {!notice.detail.includes(notice.action.note) && (
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    {notice.action.note}
                  </Text>
                )}
              </HStack>
            )}
          </Box>
        )}

        {model.state !== 'no-debt' && model.state !== 'loop' && <Bar model={model} color={color} />}
      </Card>
    )
  },
)
HealthBar.displayName = 'HealthBar'

const Headline: React.FC<{ model: HealthBarModel; color: string }> = ({ model, color }) => {
  if (model.state === 'no-debt' || model.state === 'loop' || model.distance === null)
    return (
      <Text
        mt={SPACING.sm}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
      >
        {model.summary}
      </Text>
    )
  return (
    <HStack mt={SPACING.sm} spacing={SPACING.base} align="baseline" flexWrap="wrap" aria-hidden>
      <HStack spacing={SPACING.sm} align="baseline">
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.h2}
          lineHeight="1.05"
          color={color}
        >
          {fmtPct(model.distance)}
        </Text>
        <Label>to liquidation</Label>
      </HStack>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
      >
        {model.symbol} oracle{' '}
        <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
          {model.oraclePriceUsd !== null ? fmtPrice(model.oraclePriceUsd) : 'n/a'}
        </Box>
        {' → line '}
        <Box as="span" color={SEMANTIC_COLORS.danger}>
          {model.liquidationPriceUsd !== null ? fmtPrice(model.liquidationPriceUsd) : 'none'}
        </Box>
        {model.spotPriceUsd !== null && model.spotPriceUsd !== model.oraclePriceUsd && (
          <> · spot {fmtPrice(model.spotPriceUsd)}</>
        )}
        {' · HF '}
        <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
          {fmtHf(model.healthFactor)}
        </Box>
        {model.movingSymbols.length > 1 && <> · same fall in {model.movingSymbols.join(', ')}</>}
      </Text>
    </HStack>
  )
}

const Bar: React.FC<{ model: HealthBarModel; color: string }> = ({ model, color }) => {
  const { min, max } = model.axis
  const pos = (d: number) => `${((Math.min(max, Math.max(min, d)) - min) / (max - min)) * 100}%`
  const here = model.distance ?? max
  const herePct = ((Math.min(max, Math.max(min, here)) - min) / (max - min)) * 100

  // Zones: [min, 0] is the act-now zone; (marker i, marker i+1] takes marker i+1's tint.
  const zones: { from: number; to: number; tint: string }[] = []
  model.markers.forEach((m, i) => {
    const t = MARKER_TINT[m.id]
    if (i === 0) zones.push({ from: min, to: m.distance, tint: tint(t.color, t.pct) })
    else
      zones.push({
        from: model.markers[i - 1].distance,
        to: m.distance,
        tint: tint(t.color, t.pct),
      })
  })

  return (
    <Box mt={SPACING.base}>
      {/* Position label row */}
      <Box position="relative" h="16px" aria-hidden>
        <Text
          position="absolute"
          left={herePct > 80 ? undefined : `${herePct}%`}
          right={herePct > 80 ? 0 : undefined}
          transform={herePct > 80 ? undefined : 'translateX(-50%)'}
          whiteSpace="nowrap"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {model.offScale ? `you ${fmtPct(here)} →` : `you ${fmtPct(here)}`}
        </Text>
      </Box>

      {/* The bar */}
      <Box
        role="img"
        aria-label={model.summary}
        position="relative"
        h="18px"
        bg={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        borderRadius={0}
      >
        {/* Distance already covered: from the line to the position, tinted by state */}
        <Box
          position="absolute"
          top={0}
          bottom={0}
          left={pos(0)}
          w={`calc(${herePct}% - ${pos(0)})`}
          bg={tint(color, 10)}
        />
        {zones.map((z) => (
          <Box
            key={`${z.from}-${z.to}`}
            position="absolute"
            top={0}
            bottom={0}
            left={pos(z.from)}
            w={`calc(${pos(z.to)} - ${pos(z.from)})`}
            bg={z.tint}
          />
        ))}
        {model.markers.map((m) => (
          <Box
            key={m.id}
            position="absolute"
            top="-4px"
            bottom="-4px"
            left={pos(m.distance)}
            w="1px"
            bg={MARKER_LINE[m.id]}
          />
        ))}
        {/* The position */}
        <Box
          position="absolute"
          top="-7px"
          bottom="-7px"
          left={`calc(${herePct}% - 1px)`}
          w="2px"
          bg={SEMANTIC_COLORS.textPrimary}
        />
      </Box>

      {/* Scale */}
      <Box position="relative" h="16px" mt={SPACING.xs} aria-hidden>
        <Text
          position="absolute"
          left={0}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.danger}
        >
          through
        </Text>
        <Text
          position="absolute"
          left={pos(0)}
          transform="translateX(-50%)"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textSecondary}
          display={{ base: 'none', sm: 'block' }}
        >
          0%
        </Text>
        <Text
          position="absolute"
          right={0}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textSecondary}
        >
          {fmtPct(max, 0)}
          {model.offScale ? '+' : ''} from line
        </Text>
      </Box>

      {/* Legend: every line with its distance (and health factor for the ladder) */}
      <Box
        as="ul"
        listStyleType="none"
        mt={SPACING.sm}
        display="flex"
        flexWrap="wrap"
        columnGap={SPACING.base}
        rowGap={SPACING.xs}
        aria-hidden
      >
        {model.markers.map((m) => (
          <HStack as="li" key={m.id} spacing={SPACING.xs} align="center">
            <Box
              w="8px"
              h="8px"
              bg={tint(MARKER_TINT[m.id].color, Math.max(40, MARKER_TINT[m.id].pct * 2))}
              border="1px solid"
              borderColor={MARKER_LINE[m.id]}
            />
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textSecondary}
              whiteSpace="nowrap"
            >
              <Box as="span" textTransform="uppercase" letterSpacing="0.16em">
                {m.label}
              </Box>{' '}
              <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
                {m.id === 'act-now' ? 'spot ≤ line' : fmtPct(m.distance)}
              </Box>
              {m.hf !== null && <> · HF {m.hf.toFixed(2)}</>}
            </Text>
          </HStack>
        ))}
      </Box>
    </Box>
  )
}

export default HealthBar
