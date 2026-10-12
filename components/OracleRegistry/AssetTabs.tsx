import React, { useEffect, useRef } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { configTabLabel, configTabMarks, smallText, type TabEntry } from './configViewModel'
import { colourToken, summaryCalmInkAt, tabLabel, tabMarks } from './viewModel'

// Asset picker: a roving-tabindex tablist (arrows / Home / End), horizontally scrollable on
// phones. Each tab carries its status marks — ▼n / ▲n outlier counts, ● when calm, × when
// the asset has no consensus — then its config marks: ■n open red flags, ◐n pending changes.
// Config-only subjects (no oracle in the catalog, e.g. rsETH) get a tab of their own.
// (review/S5, 2026-10-12: a calm tab drew a green ● from a 6-day-old read.) DESIGN_RULES §2 "One
// state owns the screen", §4 "Hatch it, never colour it green": the ● is green only while the
// index's freshWindow says that asset's median is current at `now` (summaryCalmInkAt), else ink.

export const AssetTabs: React.FC<{
  assets: TabEntry[]
  selected: string
  onSelect: (slug: string) => void
  panelId: string
  /** Page clock (unix s; the server's at first render, the reader's after mount). */
  now?: number | null
}> = ({ assets, selected, onSelect, panelId, now = null }) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const scroller = useRef<HTMLDivElement | null>(null)

  // On a phone the strip scrolls sideways: keep the selected tab inside it (also on first
  // paint, when ?asset= deep-links to a tab past the fold). Moves only the strip's own
  // scrollLeft, never the page, and jumps rather than animates. Re-fits when the strip is
  // resized, which includes the moment it first gets a layout (it can mount hidden).
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const fit = () => {
      const tab = refs.current[assets.findIndex((a) => a.slug === selected)]
      if (!tab || !box.clientWidth) return
      const left = tab.offsetLeft // the strip is position: relative, so this is strip-relative
      const right = left + tab.offsetWidth
      if (left < box.scrollLeft) box.scrollLeft = left
      else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [assets, selected])

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const last = assets.length - 1
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % assets.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + assets.length) % assets.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next == null) return
    e.preventDefault()
    refs.current[next]?.focus()
    onSelect(assets[next].slug)
  }

  return (
    <Box ref={scroller} overflowX="auto" pb="2px" position="relative">
      <HStack
        role="tablist"
        aria-label="Asset"
        spacing={0}
        borderBottom="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        w="max-content"
        minW="100%"
      >
        {assets.map((a, i) => {
          const active = a.slug === selected
          const calmInk = a.oracle ? summaryCalmInkAt(a.oracle, now) : true
          const label = [
            a.oracle ? tabLabel(a.oracle) : `${a.symbol} (config only)`,
            configTabLabel(a.config, now),
          ]
            .filter(Boolean)
            .join('; ')
          return (
            <Box
              as="button"
              type="button"
              key={a.slug}
              ref={(el: HTMLButtonElement | null) => {
                refs.current[i] = el
              }}
              role="tab"
              id={`oracle-tab-${a.slug}`}
              aria-selected={active}
              aria-label={label}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(a.slug)}
              onKeyDown={(e: React.KeyboardEvent) => onKeyDown(e, i)}
              px={SPACING.md}
              py={SPACING.sm}
              mb="-1px"
              borderBottom="2px solid"
              // (review/S5, 2026-10-12: the selected tab's underline was --m-primary, the same
              // green as --m-success, under a "stale" headline) — selection is ink. DESIGN_RULES §2:
              // "Green means money or profit only." "Labels are muted ink and are never coloured."
              borderColor={active ? SEMANTIC_COLORS.textPrimary : 'transparent'}
              bg="transparent"
              whiteSpace="nowrap"
              transition={TRANSITIONS.colors}
              _hover={{ color: SEMANTIC_COLORS.textPrimary }}
              _focusVisible={FOCUS_STYLES.ring}
              color={active ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
            >
              <HStack spacing="6px" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs}>
                <Text as="span">
                  {a.symbol.startsWith('PT-') ? a.symbol.replace(/-\d.*$/, '') : a.symbol}
                </Text>
                {a.oracle?.kind === 'reference' && (
                  <Text as="span" fontSize="9px" color={SEMANTIC_COLORS.textSecondary}>
                    ref
                  </Text>
                )}
                {!a.oracle && (
                  <Text as="span" fontSize="9px" color={SEMANTIC_COLORS.textSecondary}>
                    config
                  </Text>
                )}
                {(a.oracle ? tabMarks(a.oracle) : []).map((m) => (
                  <Text
                    as="span"
                    key={m.colour}
                    color={colourToken(m.colour, calmInk)}
                    fontSize="10px"
                  >
                    {m.glyph}
                    {m.count != null ? m.count : ''}
                  </Text>
                ))}
                {configTabMarks(a.config, now).map((m) => (
                  <Text as="span" key={m.label} color={smallText(m.token)} fontSize="10px">
                    {m.glyph}
                    {m.count}
                  </Text>
                ))}
              </HStack>
            </Box>
          )
        })}
      </HStack>
    </Box>
  )
}

export default AssetTabs
