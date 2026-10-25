// Small pieces shared by the curator feed page (CuratorFeed.tsx), its §07 oracle-gap
// section (OracleGapSection.tsx) and the compact card.

import React, { useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

export const Mono: React.FC<{
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

export const Chip: React.FC<{
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
}> = ({ active, onClick, children }) => (
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
    _focusVisible={FOCUS_STYLES.ring}
  >
    {children}
  </Box>
)

/** Caps label: mono 11px, the one caps tracking (DESIGN_RULES §1). */
export const LABEL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '11px',
  lineHeight: '16px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
}

/** Stale or unmeasured inputs: hatched, never coloured (DESIGN_RULES §4). */
export const HATCH = `repeating-linear-gradient(135deg, ${SEMANTIC_COLORS.borderMedium} 0 1px, transparent 1px 6px)`

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const body = await r.json()
  if (!r.ok) throw new Error(body?.error ?? `${url} ${r.status}`)
  return body as T
}

/**
 * A native <details> fold: "▸ label", 44px on phones. The body mounts only while open,
 * so a closed fold costs nothing (a grid of 300 cards each carries one).
 */
export const Fold: React.FC<{
  summary: React.ReactNode
  children: React.ReactNode
  mt?: number
}> = ({ summary, children, mt }) => {
  const [open, setOpen] = useState(false)
  return (
    <Box
      as="details"
      mt={mt}
      onToggle={(e: React.SyntheticEvent<HTMLElement>) =>
        setOpen((e.currentTarget as HTMLDetailsElement).open)
      }
    >
      <Box
        as="summary"
        display="flex"
        alignItems="center"
        minH={{ base: '44px', md: '28px' }}
        cursor="pointer"
        listStyleType="none"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textSecondary}
        _hover={{ color: SEMANTIC_COLORS.textPrimary }}
        _focusVisible={FOCUS_STYLES.ring}
        sx={{ '&::-webkit-details-marker': { display: 'none' } }}
      >
        <Box as="span" aria-hidden="true" mr="0.5em">
          {open ? '▾' : '▸'}
        </Box>
        {summary}
      </Box>
      {open && children}
    </Box>
  )
}
