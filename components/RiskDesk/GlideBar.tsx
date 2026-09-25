import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { fmtWadPct, type GlideProjection } from '@/lib/riskDesk/riskLogic'

// A 0 → cap scale. Solid segment = the in-flight move (window start value →
// window end value); the bright tick = the enforced value now; the dashed
// tick = the target. Scale is the listing cap, so the right edge is the cap.

const pos = (v: bigint, cap: bigint) => (cap === 0n ? 0 : Math.min(100, Number((v * 10_000n) / cap) / 100))

export const GlideBar: React.FC<{ cap: bigint; applied: bigint; target: bigint; p: GlideProjection }> = ({ cap, applied, target, p }) => {
  const a = pos(applied, cap)
  const e = pos(p.end, cap)
  const n = pos(p.now, cap)
  const t = pos(target, cap)
  const lo = Math.min(a, e)
  const hi = Math.max(a, e)
  const moveColor = p.direction === 'down' ? SEMANTIC_COLORS.danger : p.direction === 'up' ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary
  return (
    <Box mt={SPACING.md}>
      <Box position="relative" h="18px" borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderMedium} aria-label="LTV glide bar">
        <Box position="absolute" left={`${lo}%`} width={`${Math.max(hi - lo, 0.4)}%`} bottom="0" h="6px" bg={moveColor} opacity={0.55} />
        <Box position="absolute" left={`${t}%`} bottom="0" h="18px" borderLeft="1px dashed" borderColor={SEMANTIC_COLORS.warning} title={`target ${fmtWadPct(target)}`} />
        <Box position="absolute" left={`calc(${n}% - 1px)`} bottom="0" h="18px" w="2px" bg={SEMANTIC_COLORS.textPrimary} title={`now ${fmtWadPct(p.now)}`} />
        <Box position="absolute" right="0" bottom="0" h="18px" borderRight="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} title="listing cap" />
      </Box>
      <HStack justify="space-between" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} mt={1}>
        <Text>0%</Text>
        <Text>
          now {fmtWadPct(p.now)} · window end {fmtWadPct(p.end)} · target <Text as="span" color={SEMANTIC_COLORS.warning}>{fmtWadPct(target)}</Text>
        </Text>
        <Text>cap {fmtWadPct(cap)}</Text>
      </HStack>
    </Box>
  )
}
