import React from 'react';
import { Box, HStack, VStack, Text, Input, Image, Select } from '@chakra-ui/react';
import { Formatter } from '@/helpers/formatter';
import { Asset } from '@/helpers/chain';

interface MyceliumAmountInputProps {
    large?: boolean;
    amount: string;
    setAmount: React.Dispatch<React.SetStateAction<string>>;
    value: string;
    logoToShow: string;
    symbol: string;
    selectedAsset?: Asset;
    setSelectedAssetBase: React.Dispatch<React.SetStateAction<string | undefined>>;
    availableAssets: Asset[];
    asset?: Asset;
    displayBalance: string;
}

const MyceliumAmountInput: React.FC<MyceliumAmountInputProps> = ({
    large,
    amount,
    setAmount,
    value,
    logoToShow,
    symbol,
    selectedAsset,
    setSelectedAssetBase,
    availableAssets,
    asset,
    displayBalance,
}) => {
    return (
        <Box w={{ base: '90vw', md: large ? '420px' : '380px' }}>
            <HStack justify="space-between" align="flex-start" w="100%">
                <VStack align="flex-start" spacing={1} flex={1}>
                    <Input
                        variant="unstyled"
                        fontSize={large ? "3xl" : "2xl"}
                        fontWeight="bold"
                        color="white"
                        value={amount}
                        onChange={e => setAmount(e.target.value)}
                        type="number"
                        min={0}
                        placeholder="0"
                        w="100%"
                        _placeholder={{ color: 'whiteAlpha.400' }}
                        paddingInlineEnd={"3"}
                    />
                    <Text color="whiteAlpha.600" fontSize="md">~ ${value}</Text>
                </VStack>
                <VStack align="flex-end" spacing={2}>
                    {/* Asset selector menu */}
                    <HStack width="125px" bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                        {logoToShow && <Image src={logoToShow} alt={symbol} boxSize="24px" loading="lazy" decoding="async" />}
                        <Select
                            value={selectedAsset?.base}
                            onChange={(e) => setSelectedAssetBase(e.target.value)}
                            variant="unstyled"
                            color="white"
                            fontWeight="bold"
                            minW="90px"
                        >
                            {(availableAssets.length ? availableAssets : (asset ? [asset] : [])).map((a: Asset) => (
                                <option key={a.base} value={a.base} style={{ color: '#000' }}>{a.symbol}</option>
                            ))}
                        </Select>
                    </HStack>
                    {/* When selected we calc a new displayBalance based on the user's wallet contents */}
                    <HStack
                        cursor="pointer"
                        onClick={() => setAmount(displayBalance.toString())}
                        sx={{
                            '&:hover > .wallet-hover-text': {
                                textDecoration: 'underline',
                                color: 'blue.300',
                            },
                        }}
                    >
                        <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                            Wallet
                        </Text>
                        <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                            {Formatter.toNearestNonZero(displayBalance)}
                        </Text>
                    </HStack>
                </VStack>
            </HStack>
        </Box>
    );
};

export default MyceliumAmountInput;
