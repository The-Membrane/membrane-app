import React from 'react'
import { Box, Text, HStack, Icon } from '@chakra-ui/react'
import { ChevronDown } from 'lucide-react'
import { useBoostBreakdown } from '@/components/Manic/hooks/useBoostBreakdown'
import { num } from '@/helpers/num'
import { useDittoSpeechBox } from './hooks/useDittoSpeechBox'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

export const BoostBadge: React.FC = () => {
    const { data: breakdown } = useBoostBreakdown()
    const { openSection } = useDittoSpeechBox()

    const boostPercent = breakdown 
        ? num(breakdown.totalBoost).times(100).toFixed(2)
        : '0.00'

    const handleClick = () => {
        openSection('boost')
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleClick()
        }
    }

    return (
        <Box
            cursor="pointer"
            role="button"
            tabIndex={0}
            aria-label="Open boost breakdown"
            px={SPACING.sm}
            py={SPACING.xs}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.primary}
            borderRadius={0}
            bg={SEMANTIC_COLORS.bgSecondary}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            _hover={{
                borderColor: SEMANTIC_COLORS.primary,
            }}
            _focus={FOCUS_STYLES.ring}
            transition={TRANSITIONS.colors}
        >
            <HStack spacing={SPACING.xs}>
                <Text
                    fontSize="xs"
                    fontWeight="bold"
                    bgGradient="linear(to-r, primary.400, secondary.400)"
                    bgClip="text"
                    fontFamily={TYPOGRAPHY.fontMono}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {boostPercent}%
                </Text>
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono} textTransform="uppercase">
                    BOOST
                </Text>
                <Icon as={ChevronDown} w={3} h={3} color={SEMANTIC_COLORS.textSecondary} />
            </HStack>
        </Box>
    )
}

