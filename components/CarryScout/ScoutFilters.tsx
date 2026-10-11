import React from 'react'
import { Box, HStack, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { sizeLabel } from '@/lib/carryScan/format'
import { SIZE_KEYS, sizeUsdOf, type SizeKey } from '@/lib/carryScan/types'

export type ScoutTab = 'ranked' | 'lp' | 'no-benchmark' | 'unverified' | 'dropped'

export const TAB_LABEL: Record<ScoutTab, string> = {
  ranked: 'Ranked',
  lp: 'Stable LPs',
  'no-benchmark': 'No same-stable borrow market',
  unverified: 'Unverified',
  dropped: 'Dropped',
}

const Pill: React.FC<{
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}> = ({ active, onClick, children, title }) => (
  <Box
    as="button"
    type="button"
    onClick={onClick}
    aria-pressed={active}
    title={title}
    px={SPACING.sm}
    py="3px"
    border="1px solid"
    borderRadius={0}
    borderColor={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
    color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.1em"
    textTransform="uppercase"
    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
  >
    {children}
  </Box>
)

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.2em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
  >
    {children}
  </Text>
)

export interface ShareText {
  protocol: string
  curator: string
}

export interface ScoutFiltersProps {
  tab: ScoutTab
  onTab: (t: ScoutTab) => void
  counts: Record<ScoutTab, number>
  sizeKey: SizeKey
  onSize: (k: SizeKey) => void
  stable: string
  onStable: (s: string) => void
  stables: string[]
  share: ShareText
  onShare: (s: ShareText) => void
  shareError: string | null
}

export const ScoutFilters: React.FC<ScoutFiltersProps> = ({
  tab,
  onTab,
  counts,
  sizeKey,
  onSize,
  stable,
  onStable,
  stables,
  share,
  onShare,
  shareError,
}) => (
  <Box display="flex" flexDirection="column" gap={SPACING.sm} mt={SPACING.base}>
    <HStack spacing={SPACING.xs} flexWrap="wrap" rowGap={SPACING.xs}>
      {(Object.keys(TAB_LABEL) as ScoutTab[]).map((t) => (
        <Pill key={t} active={tab === t} onClick={() => onTab(t)}>
          {TAB_LABEL[t]} · {counts[t]}
        </Pill>
      ))}
    </HStack>
    <HStack spacing={SPACING.md} flexWrap="wrap" rowGap={SPACING.xs} align="center">
      <HStack spacing={SPACING.xs}>
        <Label>Size</Label>
        {SIZE_KEYS.map((k) => (
          <Pill key={k} active={sizeKey === k} onClick={() => onSize(k)}>
            {sizeLabel(sizeUsdOf(k))}
          </Pill>
        ))}
      </HStack>
      <HStack spacing={SPACING.xs} flexWrap="wrap">
        <Label>Stable</Label>
        {['All', ...stables].map((s) => (
          <Pill key={s} active={stable === s} onClick={() => onStable(s)}>
            {s}
          </Pill>
        ))}
      </HStack>
    </HStack>
    <HStack spacing={SPACING.sm} flexWrap="wrap" rowGap={SPACING.xs} align="center">
      <Label>What-if shares of realized gain</Label>
      {(
        [
          ['protocol', 'protocol %'],
          ['curator', 'curator %'],
        ] as const
      ).map(([k, ph]) => (
        <Input
          key={k}
          aria-label={`${k} share in percent`}
          value={share[k]}
          onChange={(e) => onShare({ ...share, [k]: e.target.value })}
          placeholder={ph}
          inputMode="decimal"
          w="96px"
          h="26px"
          px={SPACING.xs}
          borderRadius={0}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        />
      ))}
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        color={shareError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textTertiary}
      >
        {shareError ?? 'blank = curator-set (Membrane carry shows as a ceiling)'}
      </Text>
    </HStack>
  </Box>
)

export default ScoutFilters
