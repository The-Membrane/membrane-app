import React from 'react';
import { Box, Text, VStack, HStack, Divider, Image, Tooltip, Flex, Stack, Button, useDisclosure, Collapse } from '@chakra-ui/react';
import { colors } from '@/config/defaults';
import { useRouter } from 'next/router';
import useWallet from '@/hooks/useWallet';
import { InfoOutlineIcon } from '@chakra-ui/icons';
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceDot } from 'recharts';

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
    currentRatio?: number; // 0-1, e.g. 0.5 for 50%
}

interface ManagedMarketInfoProps {
    tab: 'collateral' | 'debt';
    tvl?: string | number;
    suppliedDebt?: string | number;
    maxMultiplier?: string | number;
    price?: string | number;
    availableLiquidity?: string | number;
    borrowCost?: string | number;
    totalDebt?: string | number;
    borrowAPY?: string | number;
    maxCollateralLiquidatibility?: string | number;
    oracles?: Oracle[];
    marketAddress?: string;
    interestRateModelProps?: InterestRateModelProps;
    owner?: string;
}

const calculateRateAtRatio = (ratio: number, base: number, max: number, kink: number | null, multiplier: number): number => {
    let rate;
    if (kink === null) {
        return base;
    }
    if (ratio <= kink) {
        rate = kink === 0 ? 0 : base * (ratio / kink);
    } else {
        rate = base + (max - base) * ((ratio - kink) / (1 - kink)) * multiplier;
    }

    if (rate > max) {
        rate = max;
    }
    
    return isNaN(rate) ? 0 : rate;
};

export const calculateCurrentInterestRate = ({
    baseRate,
    rateMax,
    kinkMultiplier,
    kinkPoint,
    currentRatio,
}: InterestRateModelProps): number => {
    const base = typeof baseRate === 'string' ? parseFloat(baseRate) : baseRate ?? 0;
    const max = typeof rateMax === 'string' ? parseFloat(rateMax) : rateMax ?? 0;
    const parsedKink = parseFloat(kinkPoint as string);
    const kink = isNaN(parsedKink) ? null : parsedKink;
    const parsedMultiplier = parseFloat(kinkMultiplier as string);
    const multiplier = isNaN(parsedMultiplier) ? 1 : parsedMultiplier;
    const current = currentRatio ?? 0;

    return calculateRateAtRatio(current, base, max, kink, multiplier);
};

const getInterestRateModelPoints = (props: InterestRateModelProps) => {
    const base = typeof props.baseRate === 'string' ? parseFloat(props.baseRate) : props.baseRate ?? 0;
    const max = typeof props.rateMax === 'string' ? parseFloat(props.rateMax) : props.rateMax ?? 0;
    const parsedKink = parseFloat(props.kinkPoint as string);
    const hasKink = !isNaN(parsedKink);
    const kink = hasKink ? parsedKink : null;
    const parsedMultiplier = parseFloat(props.kinkMultiplier as string);
    const multiplier = isNaN(parsedMultiplier) ? 1 : parsedMultiplier;

    const points = Array.from({ length: 51 }, (_, i) => {
        const ratio = i / 50;
        const rate = calculateRateAtRatio(ratio, base, max, kink, multiplier);
        return { ratio, rate };
    });

    return { points, max, hasKink };
}

// Placeholder for Interest Rate Model chart/component
const InterestRateModel: React.FC<InterestRateModelProps> = (props) => {
    const { baseRate, rateMax, kinkMultiplier, kinkPoint, currentRatio } = props;
    const { points, max, hasKink } = getInterestRateModelPoints(props);
    const currentRate = calculateCurrentInterestRate(props);
    const { isOpen, onToggle } = useDisclosure();

    return (
        <Box bg="#181C23" borderRadius="lg" p={4} mt={2}>
            <VStack mb={2} spacing={1} align="stretch">
                <HStack spacing={1} align="center">
                    <Text color="whiteAlpha.800" fontWeight="bold">Interest Rate Model</Text>
                    <Tooltip label="Shows the interest rate curve and parameters for borrowing.">
                        <span><InfoOutlineIcon color="whiteAlpha.600" boxSize={4} /></span>
                    </Tooltip>
                </HStack>
                <Button size="xs" variant="ghost" onClick={onToggle} alignSelf="flex-start" w="30%">
                    {isOpen ? 'Hide Params' : 'See Params'}
                </Button>
            </VStack>
            <Collapse in={isOpen} animateOpacity>
                <VStack align="start" spacing={1} py={2}>
                    <Text color="whiteAlpha.700">Base Rate: <b>{baseRate !== undefined ? `${(Number(baseRate) * 100).toFixed(2)}%` : '—'}</b></Text>
                    {hasKink && (
                        <>
                            <Text color="whiteAlpha.700">Max Rate: <b>{rateMax !== undefined ? `${(Number(rateMax) * 100).toFixed(2)}%` : '—'}</b></Text>
                            <Text color="whiteAlpha.700">Kink Multiplier: <b>{kinkMultiplier ?? "—"}</b></Text>
                            <Text color="whiteAlpha.700">Kink Point: <b>{kinkPoint ?? "—"}</b></Text>
                        </>
                    )}
                </VStack>
            </Collapse>
            <Box mt={3} h="120px" bg="#232A3E" borderRadius="md" display="flex" alignItems="center" justifyContent="center">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={points} margin={{ left: 10, right: 10, top: 10, bottom: 10 }}>
                        <XAxis dataKey="ratio" type="number" domain={[0, 1]} tickFormatter={v => `${Math.round(v * 100)}%`} stroke="#888" fontSize={12} />
                        <YAxis dataKey="rate" type="number" domain={[0, hasKink ? max : 'auto']} tickFormatter={v => `${(v * 100).toFixed(0)}%`} stroke="#888" fontSize={12} />
                        <RechartsTooltip
                            formatter={(v, n) => n === 'Rate' ? `${(Number(v) * 100).toFixed(2)}%` : `${Math.round(Number(v) * 100)}%`}
                            labelFormatter={v => `Utilization: ${Math.round(Number(v) * 100)}%`}
                            labelStyle={{ color: '#000000' }}
                            itemStyle={{ color: '#000000' }}
                        />
                        <Line name="Rate" type="monotone" dataKey="rate" stroke="#00A3F9" strokeWidth={2} dot={false} />
                        <ReferenceDot x={currentRatio} y={currentRate} r={6} fill="#e9f339" stroke="#C445F0" strokeWidth={2} />
                    </LineChart>
                </ResponsiveContainer>
            </Box>
        </Box>
    );
};

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
    availableLiquidity,
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
                            <HStack mt={2} spacing={1} align="center">
                                <Text color="whiteAlpha.800" fontWeight="bold">Statistics</Text>
                                <Tooltip label="Key metrics for the collateral market."><span><InfoOutlineIcon color="whiteAlpha.600" boxSize={4} /></span></Tooltip>
                            </HStack>
                            <InfoRow label="Available Liquidity" value={availableLiquidity + " CDT"} horizontal={true} />
                            <InfoRow label="Borrow Cost" value={borrowCost} horizontal={true} />
                        </>
                    ) : (
                        <>
                            <HStack mt={2} spacing={1} align="center">
                                <Text color="whiteAlpha.800" fontWeight="bold">Statistics</Text>
                                <Tooltip label="Key metrics for the debt market."><span><InfoOutlineIcon color="whiteAlpha.600" boxSize={4} /></span></Tooltip>
                            </HStack>
                            <InfoRow label="Total Debt" value={totalDebt} horizontal={true} />
                            <InfoRow label="Borrow APY" value={borrowAPY} horizontal={true} />
                            <InfoRow label="Max Collateral Liquidatibility" value={maxCollateralLiquidatibility} horizontal={true} />
                        </>
                    )}
                    {interestRateModelProps && <InterestRateModel {...interestRateModelProps} />}
                    <HStack mt={2} spacing={1} align="center">
                        <Text color="whiteAlpha.800" fontWeight="bold">Oracle</Text>
                        <Tooltip label="Osmosis LP pools used as price feeds & liquidation routing."><span><InfoOutlineIcon color="whiteAlpha.600" boxSize={4} /></span></Tooltip>
                    </HStack>
                    <OracleRow oracles={oracles} />
                    <HStack mt={2} spacing={1} align="center">
                        <Text color="whiteAlpha.800" fontWeight="bold">Market Address</Text>
                        <Tooltip label="Isolated smart contract address for this market."><span><InfoOutlineIcon color="whiteAlpha.600" boxSize={4} /></span></Tooltip>
                    </HStack>
                    {marketAddress ? (
                        <a
                            href={`https://celatone.osmosis.zone/osmosis-1/contracts/${marketAddress}/overview`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'inherit', textDecoration: 'underline' }}
                        >
                            <Text as="span" color="white" fontWeight="bold">{truncateAddress(marketAddress)}</Text>
                        </a>
                    ) : (
                        <Text color="white" fontWeight="bold">{truncateAddress(marketAddress)}</Text>
                    )}
                    <HStack mt={2} spacing={1} align="center">
                        <Text color="whiteAlpha.800" fontWeight="bold">Managed by</Text>
                        <Tooltip label="Address of the manager of this market. Able to make changes to the market parameters."><span><InfoOutlineIcon color="whiteAlpha.600" boxSize={4} /></span></Tooltip>
                    </HStack>
                    {owner ? (
                        <a
                            href={`https://celatone.osmosis.zone/osmosis-1/contracts/${owner}/overview`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'inherit', textDecoration: 'underline' }}
                        >
                            <Text as="span" color="white" fontWeight="bold">{truncateAddress(owner)}</Text>
                        </a>
                    ) : (
                        <Text color="white" fontWeight="bold">{truncateAddress(owner)}</Text>
                    )}
                </VStack>
            </Box>
        </VStack>
    );
};

export default ManagedMarketInfo; 