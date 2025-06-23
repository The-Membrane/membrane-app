import React from 'react';
import { Card, VStack, HStack, Text, Input, Button, Image } from '@chakra-ui/react';
import useLendState from './hooks/useLendState';
import ConfirmModal from '../ConfirmModal';
import useLend from './hooks/useLend';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { Formatter } from '@/helpers/formatter';
import { denoms } from '@/config/defaults';
import { Asset } from '@/helpers/chain';

const CDT_ASSET = { base: denoms.CDT[0] as string, symbol: 'CDT', logo: '/images/cdt.svg', decimal: 6 };

const LendMarketAction = ({ marketAddress }: { marketAddress: any }) => {
    const { lendState, setLendState } = useLendState();
    const { action: lend } = useLend({
        marketAddress: marketAddress,
        lendState: lendState,
        run: true,
    });
    // Get CDT balance
    const cdtBalance = useBalanceByAsset(CDT_ASSET as Asset);

    const handleSupplyAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setLendState({ supplyAmount: e.target.value });
    };

    const handleSetMax = () => {
        setLendState({ supplyAmount: cdtBalance.toString() });
    };

    return (
        <Card
            borderRadius="2xl"
            border="4px solid #232A3E"
            bg="#20232C"
            p={{ base: 4, md: 8 }}
            h="fit-content"
            maxW="600px"
            m="0 auto"
            overflowY="auto"
            display="flex"
            flexDirection="column"
            alignItems="center"
        >
            <VStack spacing={6} align="stretch" w="100%" maxW="600px" mx="auto">
                <HStack justify="space-between" align="flex-start" w="100%">
                    <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">Supply Amount</Text>
                    <VStack align="flex-end" spacing={1}>
                        <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                            <Image src={CDT_ASSET.logo} alt={CDT_ASSET.symbol} boxSize="24px" />
                            <Text color="white" fontWeight="bold">{CDT_ASSET.symbol}</Text>
                        </HStack>
                        <Text
                            color="whiteAlpha.700"
                            fontSize="sm"
                            cursor="pointer"
                            _hover={{ textDecoration: 'underline', color: 'teal.300' }}
                            onClick={handleSetMax}
                        >
                            Wallet: {Formatter.toNearestNonZero(cdtBalance)}
                        </Text>
                    </VStack>
                </HStack>
                <Input
                    variant="unstyled"
                    fontSize="3xl"
                    fontWeight="bold"
                    color="white"
                    value={lendState.supplyAmount}
                    onChange={handleSupplyAmountChange}
                    type="number"
                    min={0}
                    placeholder="0"
                    w="100%"
                    _placeholder={{ color: 'whiteAlpha.400' }}
                    paddingInlineEnd={"3"}
                />
                <ConfirmModal
                    label={"LEND"}
                    action={lend}
                    isDisabled={!lendState.supplyAmount || Number(lendState.supplyAmount) <= 0}
                >
                    <Card w="100%" bg="#181C23" borderRadius="lg" p={6} mt={0} mb={2}>
                        <Text fontWeight="semibold" mb={2}>Pending Lend:</Text>
                        <VStack align="stretch" spacing={2} fontSize="xs">
                            <HStack justify="space-between">
                                <Text color="whiteAlpha.700">Supply Amount</Text>
                                <Text color="white" fontWeight="bold">{lendState.supplyAmount} CDT</Text>
                            </HStack>
                        </VStack>
                    </Card>
                </ConfirmModal>
            </VStack>
        </Card>
    );
};

export default LendMarketAction; 