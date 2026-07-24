import React from 'react'
import { Box, HStack, VStack, Text, Icon, Image, Collapse } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { PRIMARY_PURPLE } from './DiscoPageConstants'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageAssetMenuProps {
    assetMenuOpen: boolean
    setAssetMenuOpen: DiscoPageState['setAssetMenuOpen']
    assetList: DiscoPageState['assetList']
    firstAsset: string
    setSelectedAsset: DiscoPageState['setSelectedAsset']
    setSelectedSlot: DiscoPageState['setSelectedSlot']
}

/** Collapsible asset-selection card for the Disco page. */
export const DiscoPageAssetMenu: React.FC<DiscoPageAssetMenuProps> = ({
    assetMenuOpen,
    setAssetMenuOpen,
    assetList,
    firstAsset,
    setSelectedAsset,
    setSelectedSlot,
}) => {
    return (
        <Box
            bg="rgba(10, 10, 10, 0.8)"
            p={4}
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
        >
            {/* Header row with chevron toggle */}
            <HStack
                justify="space-between"
                cursor="pointer"
                onClick={() => setAssetMenuOpen(!assetMenuOpen)}
                mb={assetMenuOpen ? 3 : 0}
            >
                <HStack spacing={2}>
                    <Text
                        fontSize="sm"
                        fontWeight="bold"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        letterSpacing="1px"
                        textTransform="uppercase"
                    >
                        Asset
                    </Text>
                    {(() => {
                        const currentAsset = assetList.find(a => a.denom === firstAsset)
                        return (
                            <HStack spacing={2}>
                                {currentAsset?.logo && (
                                    <Image
                                        src={currentAsset.logo}
                                        alt={currentAsset.symbol || ''}
                                        boxSize="18px"
                                        borderRadius="full"
                                    />
                                )}
                                <Text
                                    fontSize="sm"
                                    fontWeight={500}
                                    color="whiteAlpha.900"
                                    fontFamily="'Neon Tubes', monospace"
                                >
                                    {currentAsset?.symbol || '—'}
                                </Text>
                            </HStack>
                        )
                    })()}
                </HStack>
                <Icon
                    as={ChevronDownIcon}
                    color={PRIMARY_PURPLE}
                    boxSize={5}
                    transition="transform 0.2s ease"
                    transform={assetMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)'}
                />
            </HStack>

            {/* Expandable asset list */}
            <Collapse in={assetMenuOpen} animateOpacity>
                <VStack spacing={1} align="stretch">
                    {assetList.length > 0 ? assetList.map((asset) => {
                        const isActive = asset.denom === firstAsset
                        return (
                            <Box
                                key={asset.denom}
                                px={3}
                                py={2}
                                borderRadius="md"
                                cursor="pointer"
                                bg={isActive ? 'rgba(155, 220, 79, 0.2)' : 'transparent'}
                                border="1px solid"
                                borderColor={isActive ? PRIMARY_PURPLE : 'transparent'}
                                _hover={{
                                    bg: 'rgba(155, 220, 79, 0.1)',
                                    borderColor: `${PRIMARY_PURPLE}60`,
                                }}
                                transition="all 0.15s ease"
                                onClick={() => {
                                    setSelectedAsset(asset.denom)
                                    setAssetMenuOpen(false)
                                    setSelectedSlot(null) // Reset slot for new asset's range
                                }}
                            >
                                <HStack spacing={2}>
                                    {asset.logo && (
                                        <Image
                                            src={asset.logo}
                                            alt={asset.symbol || ''}
                                            boxSize="20px"
                                            borderRadius="full"
                                        />
                                    )}
                                    <Text
                                        fontSize="sm"
                                        fontWeight={500}
                                        color={isActive ? PRIMARY_PURPLE : 'whiteAlpha.800'}
                                        fontFamily="'Neon Tubes', monospace"
                                    >
                                        {asset.symbol}
                                    </Text>
                                </HStack>
                            </Box>
                        )
                    }) : (
                        <Text fontSize="xs" color="whiteAlpha.400" fontFamily="mono">
                            Loading assets...
                        </Text>
                    )}
                </VStack>
            </Collapse>
        </Box>
    )
}
