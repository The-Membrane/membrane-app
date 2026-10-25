// THE ONE DISCLOSURE PER SURFACE (copy-budget skill, rule 3). Closed by default; the
// surface must read correctly with it closed. Native <details>, so it works without JS
// and its content stays in the server HTML.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { CAPS } from './styles'

export const Details: React.FC<{ label?: string; testId?: string; children: React.ReactNode }> = ({
  label = 'Details',
  testId,
  children,
}) => (
  <Box
    as="details"
    data-testid={testId}
    sx={{
      '& > summary': {
        cursor: 'pointer',
        listStyle: 'none',
        fontFamily: TYPOGRAPHY.fontMono,
        fontSize: TYPOGRAPHY.label,
        letterSpacing: CAPS,
        textTransform: 'uppercase',
        color: SEMANTIC_COLORS.textSecondary,
        textDecoration: 'underline',
        minHeight: '44px',
        display: 'inline-flex',
        alignItems: 'center',
      },
      '& > summary::-webkit-details-marker': { display: 'none' },
      '& > summary:focus-visible': { outline: `1px solid ${SEMANTIC_COLORS.success}`, outlineOffset: '2px' },
    }}
  >
    <summary>{label}</summary>
    <Box display="grid" gap={SPACING.xs} pt={SPACING.xs}>
      {children}
    </Box>
  </Box>
)

/** A line inside Details. */
export const DetailLine: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" lineHeight={1.6} color={SEMANTIC_COLORS.textSecondary}>
    {children}
  </Text>
)

export default Details
