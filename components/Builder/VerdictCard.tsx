// Verdict card: run post-mortem + ledger + execution rail (take the board live, save
// result card). Proto: #verdict markup (:568-579) + runVerdict (:2062).

import React from 'react'
import Link from 'next/link'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { VerdictView } from './hooks/useBuilderEngine'
import { tabular } from './styles'

const xbtn = {
  display: 'inline-block',
  bg: 'transparent',
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  color: SEMANTIC_COLORS.textPrimary,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9.5px',
  letterSpacing: '0.14em',
  textTransform: 'uppercase' as const,
  px: SPACING.md,
  py: '6px',
  cursor: 'pointer',
  textDecoration: 'none',
  borderRadius: 0,
  transition: TRANSITIONS.colors,
  _hover: { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success },
  _focusVisible: FOCUS_STYLES.ring,
}

export interface VerdictCardProps {
  verdict: VerdictView
  mintHref: string
  positionHref: string
  onSaveCard: () => void
}

export const VerdictCard: React.FC<VerdictCardProps> = ({ verdict: v, mintHref, positionHref, onSaveCard }) => {
  if (!v.visible) return null
  const borderColor = v.cls === 'pass' ? SEMANTIC_COLORS.success : v.cls === 'fail' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.borderStrong
  const tagColor = v.cls === 'pass' ? SEMANTIC_COLORS.success : v.cls === 'fail' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textSecondary
  const ledgerColor = (cls: string) =>
    cls === 'pos' ? SEMANTIC_COLORS.success : cls === 'neg' ? SEMANTIC_COLORS.danger : cls === 'warn' ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary
  return (
    <Box mt={SPACING.base} border="1px solid" borderColor={borderColor} bg={SEMANTIC_COLORS.bgSecondary} p={SPACING.base} display="grid" gap={SPACING.sm}>
      <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.md} flexWrap="wrap">
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="clamp(18px, 2.8vw, 25px)" color={SEMANTIC_COLORS.textPrimary}>
          {v.title}
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.2em" textTransform="uppercase" border="1px solid" borderColor={tagColor} color={tagColor} px={SPACING.sm} py="4px">
          {v.tag}
        </Text>
      </Box>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12.5px" color={SEMANTIC_COLORS.textSecondary} maxW="84ch" lineHeight={1.7}>
        {v.why}
      </Text>
      {v.ledger.length > 0 && (
        <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          {v.ledger.map((r) => (
            <Box key={r.k} bg={SEMANTIC_COLORS.bgSecondary} px={SPACING.md} py={SPACING.sm} display="grid" gap="3px">
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
                {r.k}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="16px" {...tabular} color={ledgerColor(r.cls)}>
                {r.v}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
                {r.n}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box display="flex" gap={SPACING.sm} flexWrap="wrap" mt={SPACING.md}>
        <Box as={Link} href={mintHref} {...xbtn} bg={SEMANTIC_COLORS.success} borderColor={SEMANTIC_COLORS.success} color={SEMANTIC_COLORS.bgPrimary} _hover={{ opacity: 0.9 }}>
          Take this board live → Borrow
        </Box>
        <Box as={Link} href={positionHref} {...xbtn}>
          Check your real board → Position
        </Box>
        <Box as="button" type="button" onClick={onSaveCard} {...xbtn}>
          Save result card
        </Box>
      </Box>
    </Box>
  )
}

export default VerdictCard
