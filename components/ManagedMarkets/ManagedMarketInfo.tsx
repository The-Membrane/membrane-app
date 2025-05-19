import React from 'react';
import { Box, Text, VStack, HStack, Divider, Image, Tooltip, Flex } from '@chakra-ui/react';

// Types for props
interface Oracle {
    name: string;
    logo: string;
    address?: string;
    methodology?: string;
    checks?: string;
    dashboardUrl?: string;
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
    address?: string;
    interestRateModelProps?: InterestRateModelProps;
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
                        <Image src={oracle.logo} alt={oracle.name} boxSize="32px" borderRadius="full" bg="#232A3E" />
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

const InfoRow = ({ label, value }: { label: string; value?: string | number }) => (
    <HStack justify="space-between" w="100%">
        <Text color="whiteAlpha.700">{label}</Text>
        <Text color="white" fontWeight="bold">{value ?? '—'}</Text>
    </HStack>
);

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
    address,
    interestRateModelProps,
}) => {
    return (
        <VStack align="stretch" spacing={6} w="100%" maxW="420px" minW="320px">
            {/* Top line */}
            <Box bg="#181C23" borderRadius="lg" p={5}>
                <HStack justify="space-between" w="100%">
                    <InfoRow label="TVL" value={tvl} />
                    <Divider orientation="vertical" h="32px" borderColor="#232A3E" />
                    <InfoRow label="Supplied Debt" value={suppliedDebt} />
                    <Divider orientation="vertical" h="32px" borderColor="#232A3E" />
                    <InfoRow label="Max Multiplier" value={maxMultiplier} />
                </HStack>
            </Box>

            {/* Tab content */}
            <Box bg="#181C23" borderRadius="lg" p={5}>
                <VStack align="stretch" spacing={4}>
                    <InfoRow label="Price" value={price} />
                    {tab === 'collateral' ? (
                        <>
                            <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Statistics</Text>
                            <InfoRow label="Total Supply" value={totalSupply} />
                            <InfoRow label="Borrow Cost" value={borrowCost} />
                        </>
                    ) : (
                        <>
                            <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Statistics</Text>
                            <InfoRow label="Total Debt" value={totalDebt} />
                            <InfoRow label="Borrow APY" value={borrowAPY} />
                            <InfoRow label="Max Collateral Liquidatibility" value={maxCollateralLiquidatibility} />
                            {interestRateModelProps && <InterestRateModel {...interestRateModelProps} />}
                        </>
                    )}
                    <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Oracles</Text>
                    <OracleRow oracles={oracles} />
                    <Text color="whiteAlpha.800" fontWeight="bold" mt={2}>Market Address</Text>
                    <Text color="white" fontWeight="bold">{address ?? '—'}</Text>
                </VStack>
            </Box>
        </VStack>
    );
};

export default ManagedMarketInfo; 