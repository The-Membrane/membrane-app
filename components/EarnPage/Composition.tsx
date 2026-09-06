import React from 'react'
import { Box, Flex, HStack, Text, Wrap } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { MockStamp } from '@/components/demo'

import { CompositionGroup, PoolAsset } from './types'
import { COMPOSITION_STAMP, POOL_COMPOSITION } from './fixtures'

/** Group → semantic token, ported from the proto's GRP map (script :241). */
const GROUP_COLOR: Record<CompositionGroup, string> = {
  'yield-$': SEMANTIC_COLORS.textPrimary,
  BTC: SEMANTIC_COLORS.warning,
  ref: SEMANTIC_COLORS.info,
}

/** Successive assets in the same group step down in opacity so repeats stay legible (script :251,255). */
const swatchOpacity = (index: number): number => 1 - index * 0.16

export interface CompositionProps {
  assets?: PoolAsset[]
}

/** Sect 01 "What is backing you" — the pool composition bar (proto :191-197, 244-257). */
export const Composition: React.FC<CompositionProps> = ({ assets = POOL_COMPOSITION }) => {
  return (
    <Card variant="default">
      <Flex h="26px" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} overflow="hidden">
        {assets.map((asset, i) => (
          <Box
            key={asset.sym}
            title={`${asset.sym} ${asset.share}%`}
            h="100%"
            w={`${asset.share}%`}
            bg={GROUP_COLOR[asset.grp]}
            opacity={swatchOpacity(i)}
          />
        ))}
      </Flex>

      <Wrap spacing={SPACING.base} mt={SPACING.md}>
        {assets.map((asset, i) => (
          <HStack key={asset.sym} spacing={SPACING.sm}>
            <Box w="9px" h="9px" bg={GROUP_COLOR[asset.grp]} opacity={swatchOpacity(i)} />
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
              {asset.sym}{' '}
              <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                {asset.share}%
              </Text>
            </Text>
          </HStack>
        ))}
      </Wrap>

      <HStack spacing={SPACING.sm} mt={SPACING.md} align="baseline">
        <MockStamp label="measured" />
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.03em">
          {COMPOSITION_STAMP}
        </Text>
      </HStack>
    </Card>
  )
}

export default Composition
