// The pieces "Set alert" (AlertMeAt.tsx) and "Edit" on the alerts page
// (ManageAlerts.tsx) share, so the two forms look and validate alike.
//
// ACTION HIERARCHY (owner, 2026-10-16): each block has ONE filled action (PRIMARY —
// "Set alert", "Save"): an ink fill, full width on phones. Everything else is a
// hairline SECONDARY or a QUIET text button. Calm ink only: no green (money only),
// red + ✖ only for an error. Every target is at least 44px.

import React, { useId, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DIRECTIONS, type Direction, type Metric } from '@/lib/userAlerts/metrics'

import { MORE_WAYS, RSS_NOTE, type FieldError } from './alertMeAtLogic'

export const LABEL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: SEMANTIC_COLORS.textSecondary,
} as const

export const NOTE = { fontFamily: TYPOGRAPHY.fontMono, fontSize: TYPOGRAPHY.label, color: SEMANTIC_COLORS.textSecondary } as const

export const FIELD = {
  h: '44px',
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.small,
  color: SEMANTIC_COLORS.textPrimary,
  bg: SEMANTIC_COLORS.bgSecondary,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderMedium,
  borderRadius: 0,
  px: SPACING.md,
  _focus: FOCUS_STYLES.ring,
  _focusVisible: FOCUS_STYLES.ring,
  _invalid: { borderColor: SEMANTIC_COLORS.danger },
  spellCheck: false,
  autoComplete: 'off',
} as const

/** A wrapping 44px target (labels wrap instead of overflowing a 390px card). */
const TARGET = { h: 'auto', minH: '44px', maxW: '100%', whiteSpace: 'normal', flexShrink: 0 } as const

/** The block's ONE filled action. The fill holds on hover (the theme's solid hover would empty it). */
const INK_FILL = { bg: SEMANTIC_COLORS.textPrimary, color: SEMANTIC_COLORS.bgPrimary, borderColor: SEMANTIC_COLORS.textPrimary } as const
export const PRIMARY = {
  ...TARGET,
  variant: 'solid',
  w: { base: '100%', md: 'auto' },
  px: SPACING.lg,
  ...INK_FILL,
  _hover: { ...INK_FILL, _disabled: INK_FILL },
  _active: { ...INK_FILL, ...ACTIVE_EFFECTS.dim },
  _focusVisible: FOCUS_STYLES.ring,
} as const

/** A hairline action, full width on phones ("Your alerts page", "Get it in Telegram"). */
export const SECONDARY = { ...TARGET, variant: 'outline', w: { base: '100%', md: 'auto' }, px: SPACING.base } as const

/**
 * A quiet text action ("Set another", "Stop this alert", "More ways to get alerts"):
 * underlined dim ink, no box, aligned with the text above it. Hover brightens the ink
 * only (a ghost's hover hairline would draw a box around bare text).
 */
export const QUIET = {
  ...TARGET,
  variant: 'ghost',
  w: 'auto',
  minW: '44px',
  px: 0,
  borderColor: 'transparent',
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
  _hover: { borderColor: 'transparent', color: SEMANTIC_COLORS.textPrimary },
} as const

/** Copy to the clipboard; `copied` flips true for a moment. A blocked clipboard leaves the link on screen. */
export const useCopy = (): [boolean, (text: string) => Promise<void>] => {
  const [copied, setCopied] = useState(false)
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the link stays on screen */
    }
  }
  return [copied, copy]
}

/**
 * THE SECOND LAYER: RSS, folded behind "More ways to get alerts". The first layer is
 * only "set an alert → where you'll get it"; a feed reader is for the people who
 * already use one.
 */
export const RssDisclosure: React.FC<{ url: string }> = ({ url }) => {
  const [open, setOpen] = useState(false)
  const [copied, copy] = useCopy()
  const uid = useId()
  return (
    <Box mt={SPACING.sm}>
      <Button {...QUIET} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${uid}-rss`}>
        <Text as="span" aria-hidden mr={SPACING.xs}>
          {open ? '▾' : '▸'}
        </Text>
        {MORE_WAYS}
      </Button>
      {open && (
        <Box id={`${uid}-rss`} mt={SPACING.xs}>
          <Text {...LABEL}>rss feed</Text>
          <Text
            as="a"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            display="block"
            {...NOTE}
            color={SEMANTIC_COLORS.textPrimary}
            textDecoration="underline"
            wordBreak="break-all"
            mt={SPACING.xs}
            _focus={FOCUS_STYLES.ring}
          >
            {url}
          </Text>
          <Text {...NOTE} mt={SPACING.xs}>
            {RSS_NOTE}
          </Text>
          <Button {...SECONDARY} mt={SPACING.sm} onClick={() => void copy(url)}>
            {copied ? 'Copied' : 'Copy RSS link'}
          </Button>
        </Box>
      )}
    </Box>
  )
}

export const ErrorLine: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => (
  <Text id={id} {...NOTE} color={SEMANTIC_COLORS.danger} role="alert" mt={SPACING.xs}>
    ✖ {children}
  </Text>
)

/** A two-or-more-way segmented choice (direction; or which number on the venue page). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  text = (v) => v,
}: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  text?: (v: T) => string
}) {
  return (
    <Flex role="group" aria-label={label} flexShrink={0}>
      {options.map((o, i) => {
        const on = value === o
        return (
          <Button
            key={o}
            {...TARGET}
            variant="ghost"
            w="auto"
            px={SPACING.md}
            onClick={() => onChange(o)}
            aria-pressed={on}
            color={on ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textTertiary}
            borderColor={on ? SEMANTIC_COLORS.borderStrong : SEMANTIC_COLORS.borderSubtle}
            bg={on ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
            ml={i > 0 ? '-1px' : 0}
          >
            {text(o)}
          </Button>
        )
      })}
    </Flex>
  )
}

export const DirectionToggle: React.FC<{ value: Direction; onChange: (d: Direction) => void }> = ({ value, onChange }) => (
  <Segmented label="Direction" options={DIRECTIONS} value={value} onChange={onChange} />
)

/** The number input with its unit; mono, tabular, right-aligned. */
export const ThresholdField: React.FC<{
  id: string
  metric: Metric
  label: string
  value: string
  onChange: (v: string) => void
  error: FieldError | null
}> = ({ id, metric, label, value, onChange, error }) => (
  <Flex flex="1 1 140px" minW={0} align="center" gap={SPACING.xs}>
    {metric === 'price' && (
      <Text {...NOTE} aria-hidden>
        $
      </Text>
    )}
    <Input
      id={id}
      {...FIELD}
      textAlign="right"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={metric === 'price' ? 'price' : '%'}
      aria-label={`${label} alert number`}
      isInvalid={!!error}
      aria-invalid={!!error}
      aria-describedby={error ? `${id}-e` : undefined}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    />
    {metric !== 'price' && (
      <Text {...NOTE} aria-hidden>
        %
      </Text>
    )}
  </Flex>
)

/** Direction + number on one line (wraps below ~320px), then its error. */
export const LineControls: React.FC<{
  id: string
  metric: Metric
  label: string
  direction: Direction
  onDirection: (d: Direction) => void
  value: string
  onValue: (v: string) => void
  error: FieldError | null
}> = ({ id, metric, label, direction, onDirection, value, onValue, error }) => (
  <>
    <Flex gap={SPACING.sm} flexWrap="wrap" align="stretch">
      <DirectionToggle value={direction} onChange={onDirection} />
      <ThresholdField id={id} metric={metric} label={label} value={value} onChange={onValue} error={error} />
    </Flex>
    {error && <ErrorLine id={`${id}-e`}>{error.message}</ErrorLine>}
  </>
)
