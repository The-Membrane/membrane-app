import React, { useState } from 'react'
import { Box, Flex, HStack, Select, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { MockStamp } from '@/components/demo'

import { DEFAULT_WATERFALL_ASSET, WATERFALL_SEATS } from './fixtures'
import { withAlpha } from './utils'

interface WaterfallStage {
  key: string
  label: string
  value: string
  width: number
  bg: string
  isYou?: boolean
}

/** Sect 03 "Loss order for <asset>" — the per-collateral waterfall (proto :211-218, 262-291). */
export const LossWaterfall: React.FC = () => {
  const [asset, setAsset] = useState(DEFAULT_WATERFALL_ASSET)
  const seat = WATERFALL_SEATS[asset]

  const stages: WaterfallStage[] = [
    { key: 'disco', label: 'Disco', value: seat.discoUsd, width: seat.discoWidth, bg: withAlpha(SEMANTIC_COLORS.info, 0.18) },
    {
      key: 'junior',
      label: 'Junior',
      value: seat.juniorUsd,
      width: seat.juniorWidth,
      bg: withAlpha(SEMANTIC_COLORS.warning, 0.25),
      isYou: seat.seat === 'junior',
    },
    {
      key: 'senior',
      label: 'Senior',
      value: seat.seniorUsd,
      width: seat.seniorWidth,
      bg: withAlpha(SEMANTIC_COLORS.success, 0.15),
      isYou: seat.seat === 'senior',
    },
    {
      key: 'haircut',
      label: 'Haircut',
      value: 'never yet',
      width: 100 - seat.discoWidth - seat.juniorWidth - seat.seniorWidth,
      bg: withAlpha(SEMANTIC_COLORS.danger, 0.18),
    },
  ]

  return (
    <Card variant="default" pt={SPACING['2xl']}>
      <HStack spacing={SPACING.sm} mb={SPACING.md} wrap="wrap">
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
          Loss order for
        </Text>
        <Select
          aria-label="Choose which tranche to view"
          value={asset}
          onChange={(e) => setAsset(e.target.value)}
          w="auto"
          size="sm"
          bg={SEMANTIC_COLORS.bgTertiary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          borderRadius={0}
          color={SEMANTIC_COLORS.textPrimary}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          transition={TRANSITIONS.colors}
          _focus={FOCUS_STYLES.ring}
        >
          {Object.values(WATERFALL_SEATS).map((s) => (
            <option key={s.sym} value={s.sym} style={{ background: SEMANTIC_COLORS.bgTertiary }}>
              {s.sym} · {s.seat}
            </option>
          ))}
        </Select>
      </HStack>

      <Flex h="56px" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} overflow="visible" mt={SPACING.md}>
        {stages.map((stage, i) => (
          <Box
            key={stage.key}
            position="relative"
            display="grid"
            placeItems="center"
            w={`${stage.width}%`}
            bg={stage.bg}
            borderRight={i < stages.length - 1 ? '1px solid' : undefined}
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            {stage.isYou && (
              <Text
                position="absolute"
                top="-24px"
                left="50%"
                transform="translateX(-50%)"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="9px"
                letterSpacing="0.16em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.success}
                whiteSpace="nowrap"
                _after={{
                  content: '""',
                  position: 'absolute',
                  left: '50%',
                  top: '14px',
                  width: '1px',
                  height: '9px',
                  bg: SEMANTIC_COLORS.success,
                }}
              >
                you are here
              </Text>
            )}
            <Box textAlign="center">
              <Text
                as="span"
                display="block"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="9px"
                letterSpacing="0.16em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textPrimary}
              >
                {stage.label}
              </Text>
              <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary}>
                {stage.value}
              </Text>
            </Box>
          </Box>
        ))}
      </Flex>

      <HStack justify="space-between" mt={SPACING.sm}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
          first loss
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
          last loss
        </Text>
      </HStack>

      <HStack spacing={SPACING.sm} mt={SPACING.md} align="baseline">
        <MockStamp label="mock" />
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.03em">
          {seat.caption}
        </Text>
      </HStack>
    </Card>
  )
}

export default LossWaterfall
