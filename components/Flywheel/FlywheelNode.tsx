import { Box, Text, VStack, useColorModeValue } from '@chakra-ui/react'
import React, { useState } from 'react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'

interface FlywheelNodeProps {
    type: 'disco' | 'transmuter' | 'manic'
    metric: string
    label: string
    metricLabel?: string // Optional label to append to metric (e.g., "Insurance", "TVL")
    onClick?: () => void
}

export const FlywheelNode = React.memo(({ type, metric, label, metricLabel, onClick }: FlywheelNodeProps) => {
    const [isHovered, setIsHovered] = useState(false)
    const router = useRouter()
    const { chainName } = useChainRoute()

    const handleClick = () => {
        if (onClick) {
            onClick()
        } else {
            // Routes with chain parameter
            const routes: Record<string, string> = {
                disco: `/${chainName}/disco`,
                transmuter: `/${chainName}/transmuter`,
                manic: `/${chainName}/manic`
            }
            router.push(routes[type] || '/')
        }
    }

    // Disco ball icon/visual for disco node
    const renderIcon = () => {
        if (type === 'disco') {
            return (
                <Box
                    fontSize="3xl"
                    mb={2}
                    transform={isHovered ? 'rotate(15deg) scale(1.1)' : 'rotate(0deg) scale(1)'}
                    transition="transform 0.3s ease"
                >
                    ✨
                </Box>
            )
        }
        return null
    }

    const borderColor = useColorModeValue('whiteAlpha.300', 'whiteAlpha.300')
    const hoverBorderColor = useColorModeValue('whiteAlpha.500', 'whiteAlpha.500')
    const bgColor = useColorModeValue('whiteAlpha.50', 'whiteAlpha.50')

    return (
        <Box
            as="button"
            onClick={handleClick}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            w={{ base: '120px', md: '150px' }}
            h={{ base: '120px', md: '150px' }}
            borderRadius="50%"
            border="2px solid"
            borderColor={isHovered ? hoverBorderColor : borderColor}
            bg={bgColor}
            display="flex"
            alignItems="center"
            justifyContent="center"
            cursor="pointer"
            transform={isHovered ? 'scale(1.15)' : 'scale(1)'}
            transition="all 0.3s ease"
            _hover={{
                boxShadow: '0 0 20px rgba(255, 255, 255, 0.2)',
            }}
            position="relative"
        >
            <VStack spacing={1}>
                {renderIcon()}
                <Text
                    fontSize={{ base: 'xs', md: 'sm' }}
                    fontWeight="600"
                    textTransform="uppercase"
                    letterSpacing="0.5px"
                >
                    {label}
                </Text>
                <Text
                    fontSize={{ base: 'lg', md: 'xl' }}
                    fontWeight="700"
                    color="white"
                >
                    {metric === "0" ? "Loading..." : `${formatMetric(metric)}${metricLabel ? ` ${metricLabel}` : ''}`}
                </Text>
            </VStack>
        </Box>
    )
})

FlywheelNode.displayName = 'FlywheelNode'

// Helper function to format large numbers
const formatMetric = (value: string): string => {
    const num = parseFloat(value)
    if (isNaN(num)) return "0"

    if (num >= 1e9) {
        return `${(num / 1e9).toFixed(2)}B`
    } else if (num >= 1e6) {
        return `${(num / 1e6).toFixed(2)}M`
    } else if (num >= 1e3) {
        return `${(num / 1e3).toFixed(2)}K`
    }

    return num.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

