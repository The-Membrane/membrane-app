import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

/** Format seconds remaining as "Xd Xh Xm" */
const formatCountdown = (seconds: number) => {
    if (seconds <= 0) return 'Ready'
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (days > 0) return `${days}d ${hours}h ${minutes}m`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
}

type DiscoDepositsUnstakeStatusProps = Pick<DiscoDepositsData, 'currentDeposit'>

export const DiscoDepositsUnstakeStatus: React.FC<DiscoDepositsUnstakeStatusProps> = ({ currentDeposit }) => {
    return (
        <Box
            bg="rgba(251, 191, 36, 0.1)"
            border="1px solid"
            borderColor="yellow.500"
            borderRadius="md"
            p={3}
        >
            <Text fontSize="xs" color="yellow.400" fontFamily="mono" fontWeight="bold" mb={1}>
                Unstake Pending
            </Text>
            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                {currentDeposit.canCompleteUnstake
                    ? 'Ready to complete!'
                    : `Cooldown: ${formatCountdown(currentDeposit.unstakeSecondsRemaining)}`}
            </Text>
        </Box>
    )
}
