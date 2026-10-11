// The venue-APY cell's sources popover (owner ruling 1, 2026-10-11: "Vaults should average the
// APYs with hoverable data to show data sources").
//
// It opens on hover, on keyboard focus AND on tap: the trigger is a real <button>, so a tap
// (and Enter/Space) is a click, which pins the panel open; a second click, Escape, a tap or
// click outside, or focus leaving the cell closes it. A hover-only title would leave touch
// readers with nothing. The panel is always in the markup and `hidden` while closed, so a
// server render carries every source.
//
// HOVER is a mouse or pen pointer only (pointer events, never mouseenter): iOS Safari withholds
// the click from a tap whose emulated mouseover changed the page, so a touch "hover" made the
// first tap open, the second pin and only the third close.
//
// STACKING: the wrapper carries data-apy-open while open. A greyed (filtered) row or card is a
// stacking context, so it rises on :has([data-apy-open="true"]) (RAISE_WHEN_OPEN), or the next
// greyed row paints over this panel whatever its z-index.
//
// PLACEMENT: the panel is kept inside the LAYOUT viewport (documentElement.clientWidth). An
// open panel that overflows widens the page on a phone, and window.innerWidth then reads the
// widened page (536px on a 375px screen), so it cannot be the measure.
//
// MARKUP: the wrapper is a <div> (never put it inside a <p>), and the trigger's children must
// be phrasing content (spans): a block inside a <button> or a <p> breaks hydration.

import React, { useEffect, useId, useReducer, useRef, useState } from 'react'
import { Box, Link, Text } from '@chakra-ui/react'

import { ClassTag } from '@/components/NetApy/BreakdownRows'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { pct, sizeLabel } from '@/lib/carryScan/format'
import type { ApySource, Valued, VenueApy } from '@/lib/carryScan/types'
import type { LabelClass } from '@/lib/netApy/types'

// ------------------------------------------------------------------ open state

export interface PopoverState {
  hover: boolean
  focus: boolean
  pinned: boolean
}
export type PopoverEvent = 'enter' | 'leave' | 'focus' | 'blur' | 'click' | 'escape' | 'outside'
export const CLOSED: PopoverState = { hover: false, focus: false, pinned: false }
export const isOpen = (s: PopoverState): boolean => s.hover || s.focus || s.pinned

/**
 * Pure, so the tap/hover/focus behaviour is unit-tested without a DOM.
 * A touch tap arrives as enter (emulated mouse) + focus (most browsers) + click: open and
 * pinned. The next tap is a click on a pinned panel: closed, whatever hover/focus say.
 */
/** A pointer enter/leave as a popover event: a touch pointer is never a hover. */
export function hoverEventFor(
  pointerType: string | undefined,
  e: 'enter' | 'leave',
): PopoverEvent | null {
  return pointerType === 'touch' ? null : e
}

/** The sx rule a filtered row or card needs, so its open panel paints above its siblings. */
export const RAISE_WHEN_OPEN = {
  position: 'relative',
  '&:has([data-apy-open="true"])': { zIndex: 1500 },
} as const

// ------------------------------------------------------------------ placement

const GUTTER = 16

/** The layout viewport's width: what the panel must stay inside, whatever overflows the page. */
export function layoutViewportWidth(env: {
  documentElement: { clientWidth: number } | null
  innerWidth: number
  visualViewport?: { width: number } | null
}): number {
  const cw = env.documentElement?.clientWidth ?? 0
  if (cw > 0) return cw
  const vv = env.visualViewport?.width ?? 0
  return vv > 0 ? vv : env.innerWidth
}

/** How far to move the panel so it sits inside [gutter, width − gutter]; the left edge wins. */
export function panelShiftX(
  rect: { left: number; right: number },
  viewportWidth: number,
  gutter: number = GUTTER,
): number {
  const right = viewportWidth - gutter
  if (rect.right > right) return Math.max(gutter - rect.left, right - rect.right)
  if (rect.left < gutter) return gutter - rect.left
  return 0
}

export function popoverReducer(s: PopoverState, e: PopoverEvent): PopoverState {
  switch (e) {
    case 'enter':
      return { ...s, hover: true }
    case 'leave':
      return { ...s, hover: false }
    case 'focus':
      return { ...s, focus: true }
    case 'blur':
      return { ...s, focus: false, pinned: false }
    case 'click':
      return s.pinned ? CLOSED : { ...s, pinned: true }
    case 'escape':
    case 'outside':
      return CLOSED
  }
}

// ------------------------------------------------------------------ copy

const SOURCE_CLASS: Record<ApySource['source'], LabelClass> = {
  defillama: 'reported',
  'morpho-api': 'reported',
  'onchain-7d': 'measured',
  'onchain-irm': 'derived',
}

const asOfText = (ts: number | null): string =>
  ts === null
    ? 'as-of —'
    : `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const statusText = (s: ApySource, method: VenueApy['method']): string => {
  if (s.status === 'failed') return `failed${s.note ? `: ${s.note}` : ''}`
  if (s.status === 'missing') return `no figure: left out${s.note ? ` (${s.note})` : ''}`
  if (!s.averaged) return `not averaged${s.note ? `: ${s.note}` : ''}`
  const used = method === 'average' ? 'averaged' : 'used'
  return s.note ? `${used} · ${s.note}` : used
}

const averagedCounts = (va: VenueApy): { sources: number; figures: number } => {
  const used = va.sources.filter((s) => s.averaged)
  return { sources: new Set(used.map((s) => s.source)).size, figures: used.length }
}

/** The one-line summary under the trigger value, e.g. "avg of 3" (sources, not figures). */
export function methodTag(va: VenueApy): string {
  if (va.method === 'onchain-irm') return 'on-chain'
  if (va.method === 'defillama') return 'DeFiLlama'
  return `avg of ${averagedCounts(va).sources}`
}

/** The panel's count, in the cell's unit: "3 sources averaged (5 figures)". */
export function averagedSummary(va: VenueApy): string {
  const { sources: n, figures: f } = averagedCounts(va)
  return `${n} source${n === 1 ? '' : 's'} averaged (${f} figure${f === 1 ? '' : 's'})`
}

const headline = (va: VenueApy): string =>
  va.method === 'average'
    ? 'Venue APY: the average of its sources, like for like'
    : va.method === 'onchain-irm'
      ? 'Venue APY: priced on-chain (lending reserve)'
      : 'Venue APY: DeFiLlama’s figure'

// ------------------------------------------------------------------ component

export interface ApySourcesProps {
  venueApy: VenueApy
  /** The figure at the selected size (what the cell shows). */
  atSize: Valued
  sizeUsd: number
  /** The row's name, for the panel's accessible label. */
  rowLabel: string
  children: React.ReactNode
}

const Line: React.FC<{ children: React.ReactNode; color?: string; size?: string }> = ({
  children,
  color,
  size = '10px',
}) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={size}
    color={color ?? SEMANTIC_COLORS.textSecondary}
    sx={{ fontVariantNumeric: 'tabular-nums' }}
  >
    {children}
  </Text>
)

export const ApySources: React.FC<ApySourcesProps> = ({
  venueApy: va,
  atSize,
  sizeUsd,
  rowLabel,
  children,
}) => {
  const [state, dispatch] = useReducer(popoverReducer, CLOSED)
  const open = isOpen(state)
  const id = useId()
  const panelId = `apy-sources-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [shiftX, setShiftX] = useState(0)

  // Close on a tap or click outside; keep the panel inside the viewport (16px gutter).
  useEffect(() => {
    if (!open) {
      setShiftX(0)
      return
    }
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) dispatch('outside')
    }
    document.addEventListener('pointerdown', onDown)
    const p = panelRef.current?.getBoundingClientRect()
    if (p) {
      const dx = panelShiftX(
        p,
        layoutViewportWidth({
          documentElement: document.documentElement,
          innerWidth: window.innerWidth,
          visualViewport: window.visualViewport,
        }),
      )
      if (dx) setShiftX(dx)
    }
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const spreadLine = [
    va.spread.base !== null ? `base ${(va.spread.base * 100).toFixed(2)}pp` : null,
    va.spread.withRewards !== null
      ? `with rewards ${(va.spread.withRewards * 100).toFixed(2)}pp`
      : null,
  ].filter(Boolean)

  return (
    <Box
      ref={wrapRef}
      position="relative"
      display="inline-block"
      maxW="100%"
      data-apy-open={open ? 'true' : 'false'}
      onPointerEnter={(e: React.PointerEvent) => {
        const ev = hoverEventFor(e.pointerType, 'enter')
        if (ev) dispatch(ev)
      }}
      onPointerLeave={(e: React.PointerEvent) => {
        const ev = hoverEventFor(e.pointerType, 'leave')
        if (ev) dispatch(ev)
      }}
      onFocus={() => dispatch('focus')}
      onBlur={(e: React.FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dispatch('blur')
      }}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          // Focus first: moving it from a panel link to the trigger fires `focus`, which the
          // `escape` after it then overrides, so the panel does not reopen.
          triggerRef.current?.focus()
          dispatch('escape')
        }
      }}
    >
      <Box
        as="button"
        type="button"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="apy-sources-trigger"
        onClick={() => dispatch('click')}
        textAlign="left"
        cursor="pointer"
        borderBottom="1px dotted"
        borderColor={SEMANTIC_COLORS.textTertiary}
        _focusVisible={{
          outline: `1px solid ${SEMANTIC_COLORS.borderStrong}`,
          outlineOffset: '2px',
        }}
      >
        {children}
      </Box>
      <Box
        id={panelId}
        ref={panelRef}
        role="dialog"
        aria-label={`APY sources: ${rowLabel}`}
        data-testid="apy-sources"
        hidden={!open}
        position="absolute"
        top="calc(100% + 4px)"
        left={0}
        zIndex={1500}
        w="max-content"
        maxW="min(360px, calc(100vw - 32px))"
        p="8px 10px"
        bg={SEMANTIC_COLORS.bgTertiary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderMedium}
        boxShadow="0 6px 18px rgba(0,0,0,0.35)"
        // Bridges the 4px gap, so a pointer moving from the value to the panel stays "inside".
        _before={{
          content: '""',
          position: 'absolute',
          top: '-5px',
          left: 0,
          right: 0,
          height: '5px',
        }}
        style={shiftX ? { transform: `translateX(${shiftX}px)` } : undefined}
      >
        <Line color={SEMANTIC_COLORS.textPrimary} size="10.5px">
          {headline(va)}
        </Line>
        <Box as="ul" mt="4px" p={0}>
          {va.sources.map((s) => (
            <Box
              as="li"
              key={`${s.source}-${s.basis}`}
              listStyleType="none"
              py="3px"
              borderTop="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              data-averaged={s.averaged ? 'true' : 'false'}
            >
              <Line
                color={s.averaged ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
              >
                {s.label} · {s.basis} · {s.value === null ? '—' : pct(s.value)}{' '}
                <ClassTag c={SOURCE_CLASS[s.source]} />
              </Line>
              <Line color={SEMANTIC_COLORS.textTertiary} size="9.5px">
                {asOfText(s.asOf)} · {statusText(s, va.method)}
                {s.url ? (
                  <>
                    {' · '}
                    <Link href={s.url} isExternal textDecoration="underline">
                      source
                    </Link>
                  </>
                ) : null}
              </Line>
            </Box>
          ))}
        </Box>
        <Box mt="4px" pt="4px" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderMedium}>
          {va.method === 'average' ? (
            <Line>
              {averagedSummary(va)} · base {pct(va.base)} · with rewards {pct(va.withRewards)} (base
              mean + mean reward)
            </Line>
          ) : (
            <Line>
              base {pct(va.base)} · with rewards {pct(va.withRewards)}
              {va.method === 'onchain-irm' ? ' at $100K' : ''}
            </Line>
          )}
          {spreadLine.length ? (
            <Line color={SEMANTIC_COLORS.textTertiary}>
              sources spread {spreadLine.join(' · ')}
            </Line>
          ) : null}
          <Line color={SEMANTIC_COLORS.textTertiary}>
            at {sizeLabel(sizeUsd)}: {atSize.apy === null ? (atSize.note ?? '—') : pct(atSize.apy)}
            {atSize.apy !== null && atSize.note ? ` (${atSize.note})` : ''}. A missing source is
            left out, never counted as 0.
          </Line>
        </Box>
      </Box>
    </Box>
  )
}

export default ApySources
