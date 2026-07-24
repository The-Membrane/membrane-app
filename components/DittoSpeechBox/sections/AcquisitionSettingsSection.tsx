import React from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    Button,
    Divider,
} from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useDittoConfirmation } from '../hooks/useDittoConfirmation'
import { useAcquisitionSettingsIntents } from './AcquisitionSettings.hooks'
import { AcquisitionSettingsIntentCard } from './AcquisitionSettingsIntentCard'

export const AcquisitionSettingsSection: React.FC<SectionComponentProps> = ({ onBack }) => {
    const { openConfirmation } = useDittoConfirmation()
    const {
        discoAssets,
        userIntents,
        claimsReady,
        claimableAmount,
        intents,
        totalRatio,
        enabledIntentsCount,
        isValid,
        updateHook,
        updateIntent,
        toggleIntent,
        normalizeRatios,
    } = useAcquisitionSettingsIntents()

    const handleUpdate = () => {
        if (!isValid || !updateHook.action?.simulate?.data) return

        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)

        openConfirmation(
            updateHook.action,
            <VStack spacing={2} align="stretch" p={2}>
                <Text fontSize="sm" color="#ece6d880">
                    Claiming {claimableAmount.toFixed(2)} MBRN and updating ongoing intents
                </Text>
                <Divider />
                {enabledIntents.map((intent) => (
                    <Box key={intent.type}>
                        <Text fontSize="xs" color="#ece6d880">
                            {intent.type === 'stake' && 'Stake'}
                            {intent.type === 'deposit' && 'Deposit to Disco'}
                            {intent.type === 'send' && 'Send to Address'}
                            : {intent.ratio.toFixed(1)}%
                        </Text>
                    </Box>
                ))}
                <Text fontSize="xs" color="primary.400" mt={2}>
                    These intents will be saved for future claims
                </Text>
            </VStack>,
            { label: 'Claim & Update', actionType: 'withdraw' }
        )
    }

    return (
        <VStack spacing={4} align="stretch" w="100%">
            <Text fontSize="sm" fontWeight="bold" color="primary.400">
                Ongoing Lockdrop Claim Intents
            </Text>

            {/* Info message if claims not ready */}
            {(!claimsReady || claimableAmount <= 0) && (
                <Box p={4} bg="gray.800" borderRadius="md" border="1px solid" borderColor="gray.700">
                    <Text fontSize="xs" color="#ece6d880" textAlign="center" mb={2}>
                        {claimableAmount <= 0
                            ? 'No claims available. Intents can only be updated when claiming.'
                            : 'Claims will be available after withdrawal period ends. Intents can only be updated when claiming.'}
                    </Text>
                    {userIntents?.intents && userIntents.intents.length > 0 && (
                        <Text fontSize="xs" color="primary.400" textAlign="center" mt={2}>
                            Current ongoing intents will be used for your next claim.
                        </Text>
                    )}
                </Box>
            )}

            {/* Info message if no intents configured */}
            {(!userIntents?.intents || userIntents.intents.length === 0) && (
                <Box p={4} bg="gray.800" borderRadius="md" border="1px solid" borderColor="gray.700">
                    <Text fontSize="xs" color="#ece6d880" textAlign="center">
                        No ongoing intents configured. Configure intents below and they will be saved when you claim.
                    </Text>
                </Box>
            )}

            {/* Always show intent configuration form */}
            <VStack spacing={3} align="stretch">
                {/* Intent Configuration */}
                {intents.map((intent, index) => (
                    <AcquisitionSettingsIntentCard
                        key={intent.type}
                        intent={intent}
                        index={index}
                        discoAssets={discoAssets}
                        updateIntent={updateIntent}
                        toggleIntent={toggleIntent}
                    />
                ))}

                {/* Ratio Summary */}
                {enabledIntentsCount > 0 && (
                    <Box p={2} bg={totalRatio >= 99 && totalRatio <= 101 ? 'green.900' : 'red.900'} borderRadius="md" border="1px solid" borderColor={totalRatio >= 99 && totalRatio <= 101 ? 'green.500' : 'red.500'}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#ece6d880">
                                Total Ratio
                            </Text>
                            <Text fontSize="xs" color={totalRatio >= 99 && totalRatio <= 101 ? 'green.400' : 'red.400'} fontWeight="bold">
                                {totalRatio.toFixed(2)}%
                            </Text>
                        </HStack>
                        {totalRatio !== 100 && enabledIntentsCount > 0 && (
                            <Button size="xs" mt={2} onClick={normalizeRatios} colorScheme="primary">
                                Normalize to 100%
                            </Button>
                        )}
                    </Box>
                )}

                {/* Update Button - disabled if claims not ready */}
                <Button
                    onClick={handleUpdate}
                    isDisabled={!isValid || !updateHook.action?.simulate?.data || !claimsReady || claimableAmount <= 0}
                    isLoading={updateHook.action?.tx?.isPending}
                    colorScheme="primary"
                    size="md"
                >
                    {!claimsReady || claimableAmount <= 0
                        ? 'Update Intents (Requires Available Claims)'
                        : intents.filter(i => i.enabled && i.ratio > 0).length === 0
                            ? 'Clear Ongoing Intents'
                            : `Claim ${claimableAmount.toFixed(2)} MBRN & Update Intents`}
                </Button>
            </VStack>
        </VStack>
    )
}
