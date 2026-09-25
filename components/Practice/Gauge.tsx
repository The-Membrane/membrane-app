import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { fmtPct, type Scenario } from '@/lib/practice/engine'

/**
 * One horizontal LTV scale: borrow line, line, break line (line × (1 + band)) and
 * the current LTV. The band between line and break line is shaded.
 */
export const Gauge: React.FC<{ sc: Scenario; ltv: number }> = ({ sc, ltv }) => {
  const lo = Math.min(sc.openLtv, sc.cap) - 0.03
  const hi = sc.breakLine + 0.04
  const x = (v: number) => `${Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100}%`
  const over = ltv > sc.breakLine ? SEMANTIC_COLORS.danger : ltv > sc.line ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success

  const Mark: React.FC<{ v: number; label: string; color: string }> = ({ v, label, color }) => (
    <Box position="absolute" left={x(v)} top={0} bottom={0} borderLeft="1px solid" borderColor={color}>
      <Text
        position="absolute"
        top="-18px"
        left="-1px"
        transform="translateX(-50%)"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        color={color}
        whiteSpace="nowrap"
      >
        {label} {fmtPct(v)}
      </Text>
    </Box>
  )

  return (
    <Box
      position="relative"
      h="28px"
      mt="24px"
      mb="22px"
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      role="img"
      aria-label={`LTV ${fmtPct(ltv)}; borrow line ${fmtPct(sc.cap)}, line ${fmtPct(sc.line)}, break ${fmtPct(sc.breakLine)}`}
    >
      <Box
        position="absolute"
        left={x(sc.line)}
        w={`calc(${x(sc.breakLine)} - ${x(sc.line)})`}
        top={0}
        bottom={0}
        bg={SEMANTIC_COLORS.warning}
        opacity={0.12}
      />
      <Box position="absolute" left={x(sc.breakLine)} right={0} top={0} bottom={0} bg={SEMANTIC_COLORS.danger} opacity={0.1} />
      <Mark v={sc.cap} label="borrow" color={SEMANTIC_COLORS.textTertiary} />
      <Mark v={sc.line} label="line" color={SEMANTIC_COLORS.warning} />
      <Mark v={sc.breakLine} label="break" color={SEMANTIC_COLORS.danger} />
      <Box position="absolute" left={x(ltv)} top="-4px" bottom="-4px" w="2px" ml="-1px" bg={over}>
        <Text
          position="absolute"
          bottom="-18px"
          left="1px"
          transform="translateX(-50%)"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={over}
          whiteSpace="nowrap"
        >
          {Number.isFinite(ltv) ? fmtPct(ltv, 2) : '∞'}
        </Text>
      </Box>
    </Box>
  )
}
