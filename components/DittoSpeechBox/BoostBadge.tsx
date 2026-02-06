import React from 'react'
import { Box, Text, HStack, Icon } from '@chakra-ui/react'
import { ChevronDown } from 'lucide-react'
import { useBoostBreakdown } from '@/components/Manic/hooks/useBoostBreakdown'
import { num } from '@/helpers/num'
import { useDittoSpeechBox } from './hooks/useDittoSpeechBox'

export const BoostBadge: React.FC = () => {
    const { data: breakdown } = useBoostBreakdown()
    const { openSection } = useDittoSpeechBox()

    const boostPercent = breakdown 
        ? num(breakdown.totalBoost).times(100).toFixed(2)
        : '0.00'

    const handleClick = () => {
        openSection('boost')
    }

    return (
        <Box
            cursor="pointer"
            px={2}
            py={1}
            border="1px solid"
            borderColor="purple.400"
            borderRadius="md"
            bg="gray.800"
            onClick={handleClick}
            _hover={{
                borderColor: 'purple.300',
                boxShadow: '0 0 10px rgba(166, 146, 255, 0.2)',
            }}
            transition="all 0.2s"
        >
            <HStack spacing={1}>
                <Text
                    fontSize="xs"
                    fontWeight="bold"
                    bgGradient="linear(to-r, purple.400, cyan.400)"
                    bgClip="text"
                    fontFamily="mono"
                >
                    {boostPercent}%
                </Text>
                <Text fontSize="xs" color="gray.400" fontFamily="mono" textTransform="uppercase">
                    BOOST
                </Text>
                <Icon as={ChevronDown} w={3} h={3} color="gray.400" />
            </HStack>
        </Box>
    )
}

