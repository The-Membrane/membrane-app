import React from 'react'
import {
    ModalHeader,
    HStack,
    Text,
    Button,
    Image,
    Menu,
    MenuButton,
    MenuItem,
    MenuList,
} from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { DebtAsset, DebtAssetSymbol } from './RepayModalConstants'

interface RepayModalHeaderProps {
    selectedAsset: DebtAsset
    selectedSymbol: DebtAssetSymbol
    debtAssets: DebtAsset[]
    onSelectSymbol: (symbol: DebtAssetSymbol) => void
}

export const RepayModalHeader: React.FC<RepayModalHeaderProps> = ({
    selectedAsset,
    selectedSymbol,
    debtAssets,
    onSelectSymbol,
}) => {
    return (
        <ModalHeader>
            <HStack spacing={3}>
                <Text color="white" fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.bold}>
                    Repay
                </Text>
                <Menu placement="bottom-start">
                    <MenuButton
                        as={Button}
                        variant="ghost"
                        rightIcon={<ChevronDownIcon />}
                        px={2}
                        h="40px"
                        w="fit-content"
                        _hover={{ bg: 'whiteAlpha.100' }}
                    >
                        <HStack spacing={2}>
                            <Image src={selectedAsset.logo} alt={selectedAsset.symbol} w="24px" h="24px" borderRadius="full" />
                            <Text color="white" fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.bold}>
                                {selectedAsset.symbol}
                            </Text>
                        </HStack>
                    </MenuButton>
                    <MenuList
                        bg="rgba(10, 10, 10, 0.95)"
                        borderColor="whiteAlpha.200"
                        minW="auto"
                        w="fit-content"
                        py={1}
                    >
                        {/* js-combine-iterations FP: debtAssets is DEBT_ASSETS, a hardcoded
                            2-item list (RepayModalConstants.ts) — the extra pass is negligible. */}
                        {debtAssets.filter((asset) => asset.symbol !== selectedSymbol).map((asset) => (
                            <MenuItem
                                key={asset.symbol}
                                bg="transparent"
                                _hover={{ bg: 'whiteAlpha.100' }}
                                onClick={() => onSelectSymbol(asset.symbol)}
                            >
                                <HStack spacing={2}>
                                    <Image src={asset.logo} alt={asset.symbol} w="20px" h="20px" borderRadius="full" />
                                    <Text color="white" fontSize="sm" fontWeight="medium">
                                        {asset.symbol}
                                    </Text>
                                </HStack>
                            </MenuItem>
                        ))}
                    </MenuList>
                </Menu>
            </HStack>
        </ModalHeader>
    )
}
