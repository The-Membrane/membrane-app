import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { Stamp } from '@/components/Simulator/Stamp'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { provenanceLabel, type Figure } from '@/lib/curators/curatorLogic'

/** Mono uppercase eyebrow, 0.24em (Radar/Living Typeface). */
export const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    as="span"
    display="block"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.24em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
  >
    {children}
  </Text>
)

/** A chain figure. An empty (zero) figure prints its words in the tertiary tone. */
export const FigureText: React.FC<{ figure: Figure; size?: string }> = ({ figure, size = '13px' }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={size}
    color={figure.empty ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary}
    wordBreak="break-word"
  >
    {figure.text}
  </Text>
)

export const Fact: React.FC<{ label: string; figure: Figure }> = ({ label, figure }) => (
  <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
    <Eyebrow>{label}</Eyebrow>
    <Box mt="4px">
      <FigureText figure={figure} size="15px" />
    </Box>
  </Box>
)

/** "local chain · CuratorRegistry 0x…· block N", on the app's provenance chip. */
export const RegistryStamp: React.FC<{ chainId: number; registry: string; block: bigint; at: number }> = ({
  chainId,
  registry,
  block,
  at,
}) => (
  <Stamp
    provenance={{
      kind: 'onchain',
      label: provenanceLabel(chainId, registry, block),
      at,
      detail: `CuratorRegistry ${registry} · chainId ${chainId}`,
    }}
  />
)

export const StatusLine: React.FC<{ children: React.ReactNode; tone?: 'muted' | 'danger' }> = ({
  children,
  tone = 'muted',
}) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="12px"
    color={tone === 'danger' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textSecondary}
    mt={SPACING.lg}
  >
    {children}
  </Text>
)
