import React, { useRef } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { ConfigTabSummary } from '@/lib/oracleRegistry/config/apiTypes'

import { configTabLabel, configTabMarks, smallText, type ConfigView } from './configViewModel'

// Oracles | Trust config — the per-asset sub-tablist (same roving-tabindex pattern as the
// asset tabs). A config-only asset (no catalogued oracle) shows the Oracles tab disabled.

export const VIEW_PANEL_ID = 'oracle-view-panel'

export const ViewSwitch: React.FC<{
  view: ConfigView
  onSelect: (v: ConfigView) => void
  oraclesAvailable: boolean
  config: ConfigTabSummary | null
  /** Client clock (unix s; null during SSR): marks stale config output. */
  now?: number | null
}> = ({ view, onSelect, oraclesAvailable, config, now = null }) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const tabs: { key: ConfigView; label: string; disabled: boolean }[] = [
    { key: 'oracles', label: 'Oracles', disabled: !oraclesAvailable },
    { key: 'config', label: 'Trust config', disabled: !config },
  ]
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    // Two tabs: either arrow moves to the other one; Home / End go to the first / last.
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - i
    if (next === i || tabs[next].disabled) return
    refs.current[next]?.focus()
    onSelect(tabs[next].key)
  }
  return (
    <HStack role="tablist" aria-label="View" spacing={SPACING.xs} mt={SPACING.base}>
      {tabs.map((t, i) => {
        const active = view === t.key
        const marks = t.key === 'config' ? configTabMarks(config, now) : []
        return (
          <Box
            as="button"
            type="button"
            key={t.key}
            ref={(el: HTMLButtonElement | null) => {
              refs.current[i] = el
            }}
            role="tab"
            id={`oracle-view-${t.key}`}
            aria-selected={active}
            aria-controls={VIEW_PANEL_ID}
            aria-disabled={t.disabled || undefined}
            aria-label={
              t.key === 'config' && config ? `${t.label}: ${configTabLabel(config, now)}` : t.label
            }
            title={
              t.disabled
                ? t.key === 'oracles'
                  ? 'Not in the oracle catalog'
                  : 'No config card for this asset yet'
                : undefined
            }
            tabIndex={active ? 0 : -1}
            onClick={() => !t.disabled && onSelect(t.key)}
            onKeyDown={(e: React.KeyboardEvent) => onKeyDown(e, i)}
            px={SPACING.md}
            py="5px"
            border="1px solid"
            borderColor={active ? SEMANTIC_COLORS.borderStrong : SEMANTIC_COLORS.borderSubtle}
            bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
            color={
              t.disabled
                ? SEMANTIC_COLORS.textTertiary
                : active
                  ? SEMANTIC_COLORS.textPrimary
                  : SEMANTIC_COLORS.textSecondary
            }
            opacity={t.disabled ? 0.6 : 1}
            cursor={t.disabled ? 'not-allowed' : 'pointer'}
            transition={TRANSITIONS.colors}
            _hover={t.disabled ? undefined : { color: SEMANTIC_COLORS.textPrimary }}
            _focusVisible={FOCUS_STYLES.ring}
          >
            <HStack spacing="6px" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs}>
              <Text as="span">{t.label}</Text>
              {marks.map((m) => (
                <Text
                  as="span"
                  key={m.label}
                  color={smallText(m.token)}
                  fontSize="10px"
                  aria-hidden="true"
                >
                  {m.glyph}
                  {m.count}
                </Text>
              ))}
            </HStack>
          </Box>
        )
      })}
    </HStack>
  )
}

export default ViewSwitch
