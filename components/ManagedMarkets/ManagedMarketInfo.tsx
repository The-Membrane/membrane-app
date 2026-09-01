import React from 'react';
import { Box, Text, VStack, HStack, Divider, Image, Tooltip, Flex, Stack, Button, useDisclosure, Collapse } from '@chakra-ui/react';
import { colors } from '@/config/defaults';
import { useRouter } from 'next/router';
import useWallet from '@/hooks/useWallet';
import { InfoOutlineIcon } from '@chakra-ui/icons';
import { lazyChart } from '@/components/ui/lazyChart';
import { calculateCurrentInterestRate, getInterestRateModelPoints } from './interestRateModel';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

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

export interface InterestRateModelProps {
    baseRate: number | string;
    rateMax: number | string;
    kinkMultiplier?: number | string;
    kinkPoint?: number | string;
    currentRatio?: number; // 0-1, e.g. 0.5 for 50%
    showTitle?: boolean;
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

const InterestRateChart = lazyChart<{
    points: { ratio: number; rate: number }[];
    hasKink: boolean;
    max: number;
    currentRatio?: number;
    currentRate: number;
}>(({ LineChart, Line, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer, ReferenceDot }) =>
    function InterestRateChart({ points, hasKink, max, currentRatio, currentRate }) {
        return (
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
        );
    }, 120);

// Placeholder for Interest Rate Model chart/component
export const InterestRateModel: React.FC<InterestRateModelProps> = (props) => {
    const { baseRate, rateMax, kinkMultiplier, kinkPoint, currentRatio } = props;
    const { points, max, hasKink } = getInterestRateModelPoints(props);
    const currentRate = calculateCurrentInterestRate(props);
    const { isOpen, onToggle } = useDisclosure();

    return (
        <Box bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} p={4} mt={2}>
            {props.showTitle && (
                <VStack mb={2} spacing={1} align="stretch">
                    <HStack spacing={1} align="center">
                        <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">Interest Rate Model</Text>
                        <Tooltip label="Shows the interest rate curve and parameters for borrowing.">
                            <span><InfoOutlineIcon color={SEMANTIC_COLORS.textSecondary} boxSize={4} /></span>
                        </Tooltip>
                    </HStack>
                    <Button size="xs" variant="ghost" onClick={onToggle} alignSelf="flex-start" w="30%">
                        {isOpen ? 'Hide Params' : 'See Params'}
                    </Button>
                </VStack>
            )}
            <Collapse in={isOpen} animateOpacity>
                <VStack align="start" spacing={1} py={2}>
                    <Text color={SEMANTIC_COLORS.textSecondary}>Base Rate: <b>{baseRate !== undefined ? `${(Number(baseRate) * 100).toFixed(2)}%` : '—'}</b></Text>
                    {hasKink && (
                        <>
                            <Text color={SEMANTIC_COLORS.textSecondary}>Max Rate: <b>{rateMax !== undefined ? `${(Number(rateMax) * 100).toFixed(2)}%` : '—'}</b></Text>
                            <Text color={SEMANTIC_COLORS.textSecondary}>Kink Multiplier: <b>{kinkMultiplier ?? "—"}</b></Text>
                            <Text color={SEMANTIC_COLORS.textSecondary}>Kink Point: <b>{kinkPoint ?? "—"}</b></Text>
                        </>
                    )}
                </VStack>
            </Collapse>
            <Box mt={3} h="120px" bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} display="flex" alignItems="center" justifyContent="center">
                <InterestRateChart points={points} hasKink={hasKink} max={max} currentRatio={currentRatio} currentRate={currentRate} />
            </Box>
        </Box>
    );
};

// Oracle row with arrows
export const OracleRow: React.FC<{ oracles?: Oracle[] }> = ({ oracles }) => (
    <HStack spacing={2} mt={2} mb={2}>
        {(oracles && oracles.length > 0) ? (
            oracles.map((oracle, idx) => (
                <React.Fragment key={oracle.name + idx}>
                    <Tooltip label={oracle.name}>
                        {oracle.poolId ? (
                            <a href={`https://app.osmosis.zone/pool/${oracle.poolId}`} target="_blank" rel="noopener noreferrer">
                                <Image src={oracle.logo} alt={oracle.name} boxSize="32px" borderRadius="full" bg={SEMANTIC_COLORS.bgTertiary} />
                            </a>
                        ) : (
                            <Image src={oracle.logo} alt={oracle.name} boxSize="32px" borderRadius="full" bg={SEMANTIC_COLORS.bgTertiary} />
                        )}
                    </Tooltip>
                    {idx < oracles.length - 1 && (
                        <Text color={SEMANTIC_COLORS.textSecondary} fontWeight="bold" fontSize="xl">→</Text>
                    )}
                </React.Fragment>
            ))
        ) : (
            <Text color={SEMANTIC_COLORS.textTertiary}>—</Text>
        )}
    </HStack>
);
const InfoRow = ({ label, value, horizontal }: { label: string; value?: string | number, horizontal: boolean }) => (
    <Stack justify="space-between" w="100%" direction={horizontal ? "row" : "column"}>
        <Text color={SEMANTIC_COLORS.textSecondary}>{label}</Text>
        <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{value ?? '—'}</Text>
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
            <Box bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} p={5} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                <HStack justify="space-between" w="100%">
                    <InfoRow label="TVL" value={`$${tvl}`} horizontal={false} />
                    <Divider orientation="vertical" h="32px" borderColor={SEMANTIC_COLORS.borderSubtle} />
                    <InfoRow label="Supplied Debt" value={`${suppliedDebt} CDT`} horizontal={false} />
                    <Divider orientation="vertical" h="32px" borderColor={SEMANTIC_COLORS.borderSubtle} />
                    <InfoRow label="Max Multiplier" value={maxMultiplier} horizontal={false} />
                </HStack>
            </Box>

            {/* Tab content */}
            <Box bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} p={5} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                <VStack align="stretch" spacing={4}>
                    <InfoRow label="Price" value={price} horizontal={true} />
                    {tab === 'collateral' ? (
                        <>
                            <HStack mt={2} spacing={1} align="center">
                                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">Statistics</Text>
                                <Tooltip label="Key metrics for the collateral market."><span><InfoOutlineIcon color={SEMANTIC_COLORS.textSecondary} boxSize={4} /></span></Tooltip>
                            </HStack>
                            <InfoRow label="Available Liquidity" value={availableLiquidity + " CDT"} horizontal={true} />
                            <InfoRow label="Borrow Cost" value={borrowCost} horizontal={true} />
                        </>
                    ) : (
                        <>
                            <HStack mt={2} spacing={1} align="center">
                                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">Statistics</Text>
                                <Tooltip label="Key metrics for the debt market."><span><InfoOutlineIcon color={SEMANTIC_COLORS.textSecondary} boxSize={4} /></span></Tooltip>
                            </HStack>
                            <InfoRow label="Total Debt" value={totalDebt} horizontal={true} />
                            <InfoRow label="Borrow APY" value={borrowAPY} horizontal={true} />
                            <InfoRow label="Max Collateral Liquidatibility" value={maxCollateralLiquidatibility} horizontal={true} />
                        </>
                    )}
                    {interestRateModelProps && <InterestRateModel {...interestRateModelProps} />}
                    <HStack mt={2} spacing={1} align="center">
                        <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">Oracle</Text>
                        <Tooltip label="Osmosis LP pools used as TWAP price feeds & liquidation routing."><span><InfoOutlineIcon color={SEMANTIC_COLORS.textSecondary} boxSize={4} /></span></Tooltip>
                    </HStack>
                    <OracleRow oracles={oracles} />
                    <HStack mt={2} spacing={1} align="center">
                        <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">Market Address</Text>
                        <Tooltip label="Isolated smart contract address for this market."><span><InfoOutlineIcon color={SEMANTIC_COLORS.textSecondary} boxSize={4} /></span></Tooltip>
                    </HStack>
                    {marketAddress ? (
                        <a
                            href={`https://celatone.osmosis.zone/osmosis-1/contracts/${marketAddress}/overview`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'inherit', textDecoration: 'underline' }}
                        >
                            <Text as="span" color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{truncateAddress(marketAddress)}</Text>
                        </a>
                    ) : (
                        <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{truncateAddress(marketAddress)}</Text>
                    )}
                    <HStack mt={2} spacing={1} align="center">
                        <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">Managed by</Text>
                        <Tooltip label="Address of the manager of this market. Able to make changes to the market parameters."><span><InfoOutlineIcon color={SEMANTIC_COLORS.textSecondary} boxSize={4} /></span></Tooltip>
                    </HStack>
                    {owner ? (
                        <a
                            href={`https://celatone.osmosis.zone/osmosis-1/contracts/${owner}/overview`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'inherit', textDecoration: 'underline' }}
                        >
                            <Text as="span" color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{truncateAddress(owner)}</Text>
                        </a>
                    ) : (
                        <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{truncateAddress(owner)}</Text>
                    )}
                </VStack>
            </Box>
        </VStack>
    );
};

export default ManagedMarketInfo; 