import React from 'react';
import { Box, Text, VStack, HStack, Divider, Image, Tooltip, Flex, Stack, Button } from '@chakra-ui/react';
import { colors } from '@/config/defaults';
import { useRouter } from 'next/router';
import useWallet from '@/hooks/useWallet';

// Types for props
interface Oracle {
    name: string;
    logo: string;
    address?: string;
    methodology?: string;
    checks?: string;
    dashboardUrl?: string;
    poolId?: string | number;
}

interface InterestRateModelProps {
    baseRate: number | string;
    rateMax: number | string;
    kinkMultiplier?: number | string;
    kinkPoint?: number | string;
}

interface ManagedMarketInfoProps {
    tab: 'collateral' | 'debt';
    tvl?: string | number;
    suppliedDebt?: string | number;
    maxMultiplier?: string | number;
    price?: string | number;
    totalSupply?: string | number;
    borrowCost?: string | number;
    totalDebt?: string | number;
    borrowAPY?: string | number;
    maxCollateralLiquidatibility?: string | number;
    oracles?: Oracle[];
    marketAddress?: string;
    interestRateModelProps?: InterestRateModelProps;
    owner?: string;
}

// Placeholder for Interest Rate Model chart/component
const InterestRateModel: React.FC<InterestRateModelProps> = ({ baseRate, rateMax, kinkMultiplier, kinkPoint }) => (
    <Box bg="#181C23" borderRadius="lg" p={4} mt={2}>
        <Text color="whiteAlpha.800" fontWeight="bold" mb={2}>Interest Rate Model</Text>
        <VStack align="start" spacing={1}>
            <Text color="whiteAlpha.700">Base Rate: <b>{baseRate ?? '—'}</b></Text>
            <Text color="whiteAlpha.700">Max Rate: <b>{rateMax ?? '—'}</b></Text>
            {kinkMultiplier !== undefined && (
                <Text color="whiteAlpha.700">Kink Multiplier: <b>{kinkMultiplier}</b></Text>
            )}
            {kinkPoint !== undefined && (
                <Text color="whiteAlpha.700">Kink Point: <b>{kinkPoint}</b></Text>
            )}
        </VStack>
        {/* Chart placeholder */}
        <Box mt={3} h="80px" bg="#232A3E" borderRadius="md" display="flex" alignItems="center" justifyContent="center">
            <Text color="whiteAlpha.500">[Chart Placeholder]</Text>
        </Box>
    </Box>
);

// Oracle row with arrows
const OracleRow: React.FC<{ oracles?: Oracle[] }> = ({ oracles }) => (
    <HStack spacing={2} mt={2} mb={2}>
        {(oracles && oracles.length > 0) ? (
            oracles.map((oracle, idx) => (
                <React.Fragment key={oracle.name + idx}>
                    <Tooltip label={oracle.name}>
                        {oracle.poolId ? (
                            <a href={`https://app.osmosis.zone/pool/${oracle.poolId}`} target="_blank" rel="noopener noreferrer">
                                <Image src={oracle.logo} alt={oracle.name} boxSize="32px" borderRadius="full" bg="#232A3E" />
                            </a>
                        ) : (
                            <Image src={oracle.logo} alt={oracle.name} boxSize="32px" borderRadius="full" bg="#232A3E" />
                        )}
                    </Tooltip>
                    {idx < oracles.length - 1 && (
                        <Text color="whiteAlpha.600" fontWeight="bold" fontSize="xl">→</Text>
                    )}
                </React.Fragment>
            ))
        ) : (
            <Text color="whiteAlpha.500">—</Text>
        )}
    </HStack>
);
const InfoRow = ({ label, value, horizontal }: { label: string; value?: string | number, horizontal: boolean }) => (
    <Stack justify="space-between" w="100%" direction={horizontal ? "row" : "column"}>
        <Text color="whiteAlpha.700">{label}</Text>
        <Text color="white" fontWeight="bold">{value ?? '—'}</Text>
    </Stack>
);

// Helper to truncate addresses
const truncateAddress = (address?: string) => {
    if (!address) return '—';
    return address.length > 10 ? `${address.slice(0, 5)}...${address.slice(-5)}` : address;
};

const ManagedMarketInfo: React.FC<ManagedMarketInfoProps> = ({
    tab,
    tvl,
    suppliedDebt,
    maxMultiplier,
    price,
    totalSupply,
    borrowCost,
    totalDebt,
    borrowAPY,
    maxCollateralLiquidatibility,
    oracles,
    marketAddress,
    owner,
    interestRateModelProps,
}) => {
    console.log("market address", marketAddress);
    return (
        <VStack align="stretch" spacing={6} w="100%" maxW="420px" minW="320px">
            {/* Top line */}
            <Box bg="#181C23" borderRadius="lg" p={5} border="5px solid" borderColor="gray.800">
                <HStack justify="space-between" w="100%">
                    <InfoRow label="TVL" value={`$${tvl}`} horizontal={false} />
                    <Divider orientation="vertical" h="32px" borderColor="#232A3E" />
                    <InfoRow label="Supplied Debt" value={`${suppliedDebt} CDT`} horizontal={false} />
                    <Divider orientation="vertical" h="32px" borderColor="#232A3E" />
                    <InfoRow label="Max Multiplier" value={maxMultiplier} horizontal={false} />
                </HStack>
            </Box>

            {/* Tab content */}
            <Box bg="#181C23" borderRadius="lg" p={5} border="5px solid" borderColor="gray.800">
                <VStack align="stretch" spacing={4}>
                    <InfoRow label="Price" value={price} horizontal={true} />
                    {tab === 'collateral' ? (
                        <>
                            <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Statistics</Text>
                            <InfoRow label="Total Supply" value={totalSupply} horizontal={true} />
                            <InfoRow label="Borrow Cost" value={borrowCost} horizontal={true} />
                        </>
                    ) : (
                        <>
                            <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Statistics</Text>
                            <InfoRow label="Total Debt" value={totalDebt} horizontal={true} />
                            <InfoRow label="Borrow APY" value={borrowAPY} horizontal={true} />
                            <InfoRow label="Max Collateral Liquidatibility" value={maxCollateralLiquidatibility} horizontal={true} />
                            {interestRateModelProps && <InterestRateModel {...interestRateModelProps} />}
                        </>
                    )}
                    <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Oracle</Text>
                    <OracleRow oracles={oracles} />
                    <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Market Address</Text>
                    <Text color="white" fontWeight="bold">{truncateAddress(marketAddress)}</Text>
                    <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Managed by</Text>
                    <Text color="white" fontWeight="bold">{truncateAddress(owner)}</Text>
                </VStack>
            </Box>
        </VStack>
    );
};

export default ManagedMarketInfo; 