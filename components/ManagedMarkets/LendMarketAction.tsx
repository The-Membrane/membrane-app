import React from 'react';
import { Card, VStack, HStack, Text, Input, Button, Image, Tabs, TabList, TabPanels, Tab, TabPanel, Radio, RadioGroup, Tooltip, Icon } from '@chakra-ui/react';
import { InfoIcon } from '@chakra-ui/icons';
import useLendState from './hooks/useLendState';
import ConfirmModal from '../ConfirmModal';
import useLend from './hooks/useLend';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { Formatter } from '@/helpers/formatter';
import { Asset } from '@/helpers/chain';
import { CDT_ASSET } from '@/config/defaults';
import { useManagedConfig, useMarketCollateralDenoms, useMarketCollateralCost, useTotalBorrowed, useManagedMarketUnderlyingCDT } from '@/hooks/useManaged';
import { getAssetByDenom } from '@/helpers/chain';
import { shiftDigits } from '@/helpers/math';
import { num } from '@/helpers/num';
import BigNumber from 'bignumber.js';
import type { ManagedConfig } from '@/components/ManagedMarkets/hooks/useManagerState';

// Helper to get BigNumber safely
const bn = (v: any) => num(v || 0);

// Calculate Core and Growth APRs based on interest rate & debt distribution
const computeTrancheAPRs = (
    interestRate: string | null | undefined, // decimal fraction string (e.g., "0.08")
    totalBorrowed: string | null | undefined, // Uint128 string
    config: ManagedConfig | undefined | null,
) => {
    if (!interestRate || !totalBorrowed || !config) return { core: null, growth: null };

    const seniorTokens = bn(config.total_debt_tokens);
    const juniorTokens = bn(config.junior_debt_info?.total_debt || 0);
    const totalTokens = seniorTokens.plus(juniorTokens);
    if (totalTokens.isZero()) return { core: null, growth: null };

    // Expected annual yield per vault token (fraction)
    const expectedYield = bn(interestRate).multipliedBy(bn(totalBorrowed).dividedBy(totalTokens));

    const seniorTarget = bn(config.senior_debt_fixed_yield_target || 0); // fraction

    let coreAPR: BigNumber; // fraction
    let growthAPR: BigNumber;

    if (expectedYield.isGreaterThan(seniorTarget) && seniorTokens.isGreaterThan(0)) {
        // Core capped at senior target
        coreAPR = seniorTarget;

        // Allocate remaining interest to growth tranche
        const totalInterest = expectedYield.multipliedBy(totalTokens); // interest amount
        const allocatedCoreInterest = seniorTarget.multipliedBy(seniorTokens);
        const remainingInterest = totalInterest.minus(allocatedCoreInterest);

        if (juniorTokens.isZero()) {
            growthAPR = bn(0);
        } else {
            growthAPR = remainingInterest.dividedBy(juniorTokens);
        }
    } else {
        // Below target: split 80/20 based on token proportions
        const totalInterest = expectedYield.multipliedBy(totalTokens); // total interest amount
        
        if (seniorTokens.isGreaterThan(0)) {
            // Allocate 80% of total interest to core tranche
            const coreInterest = totalInterest.multipliedBy(0.8);
            coreAPR = coreInterest.dividedBy(seniorTokens);
        } else {
            coreAPR = bn(0);
        }
        
        if (juniorTokens.isGreaterThan(0)) {
            // Allocate 20% of total interest to growth tranche
            const growthInterest = totalInterest.multipliedBy(0.2);
            growthAPR = growthInterest.dividedBy(juniorTokens);
        } else {
            growthAPR = bn(0);
        }
    }

    // convert to percent strings with 1 decimal
    const result = {
        core: coreAPR.multipliedBy(100).dp(1).toFixed(1),
        growth: growthAPR.multipliedBy(100).dp(1).toFixed(1),
    };

    // If junior tokens is 0, show growth APR as range from 0% to 2% scenario
    if (juniorTokens.isZero() && seniorTokens.isGreaterThan(0)) {
        const juniorAt2Percent = seniorTokens.multipliedBy(0.02);
        const totalAt2Percent = seniorTokens.plus(juniorAt2Percent);
        
        // Calculate growth APR for 2% scenario
        let growthAPR2Percent: BigNumber;
        
        if (expectedYield.isGreaterThan(seniorTarget) && seniorTokens.isGreaterThan(0)) {
            const totalInterest = expectedYield.multipliedBy(totalAt2Percent);
            const allocatedCoreInterest = seniorTarget.multipliedBy(seniorTokens);
            const remainingInterest = totalInterest.minus(allocatedCoreInterest);
            growthAPR2Percent = remainingInterest.dividedBy(juniorAt2Percent);
        } else {
            const totalInterest = expectedYield.multipliedBy(totalAt2Percent);
            const growthInterest = totalInterest.multipliedBy(0.2);
            growthAPR2Percent = growthInterest.dividedBy(juniorAt2Percent);
        }
        
        result.growth = `up to ${growthAPR2Percent.multipliedBy(100).dp(1).toFixed(1)}`;
    }

    // Log what APR would be if junior tranche was 2% or 5% of senior tranche
    if (seniorTokens.isGreaterThan(0)) {
        const juniorAt2Percent = seniorTokens.multipliedBy(0.02);
        const juniorAt5Percent = seniorTokens.multipliedBy(0.05);
        const totalAt2Percent = seniorTokens.plus(juniorAt2Percent);
        const totalAt5Percent = seniorTokens.plus(juniorAt5Percent);

        // Calculate APRs for 2% scenario
        let coreAPR2Percent: BigNumber;
        let growthAPR2Percent: BigNumber;
        
        if (expectedYield.isGreaterThan(seniorTarget) && seniorTokens.isGreaterThan(0)) {
            coreAPR2Percent = seniorTarget;
            const totalInterest = expectedYield.multipliedBy(totalAt2Percent);
            const allocatedCoreInterest = seniorTarget.multipliedBy(seniorTokens);
            const remainingInterest = totalInterest.minus(allocatedCoreInterest);
            growthAPR2Percent = juniorAt2Percent.isZero() ? bn(0) : remainingInterest.dividedBy(juniorAt2Percent);
        } else {
            const totalInterest = expectedYield.multipliedBy(totalAt2Percent);
            const coreInterest = totalInterest.multipliedBy(0.8);
            const growthInterest = totalInterest.multipliedBy(0.2);
            coreAPR2Percent = coreInterest.dividedBy(seniorTokens);
            growthAPR2Percent = growthInterest.dividedBy(juniorAt2Percent);
        }

        // Calculate APRs for 5% scenario
        let coreAPR5Percent: BigNumber;
        let growthAPR5Percent: BigNumber;
        
        if (expectedYield.isGreaterThan(seniorTarget) && seniorTokens.isGreaterThan(0)) {
            coreAPR5Percent = seniorTarget;
            const totalInterest = expectedYield.multipliedBy(totalAt5Percent);
            const allocatedCoreInterest = seniorTarget.multipliedBy(seniorTokens);
            const remainingInterest = totalInterest.minus(allocatedCoreInterest);
            growthAPR5Percent = juniorAt5Percent.isZero() ? bn(0) : remainingInterest.dividedBy(juniorAt5Percent);
        } else {
            const totalInterest = expectedYield.multipliedBy(totalAt5Percent);
            const coreInterest = totalInterest.multipliedBy(0.8);
            const growthInterest = totalInterest.multipliedBy(0.2);
            coreAPR5Percent = coreInterest.dividedBy(seniorTokens);
            growthAPR5Percent = growthInterest.dividedBy(juniorAt5Percent);
        }

        console.log(`APR Simulation - Current: Core ${result.core}% Growth ${result.growth}% (Junior/Senior: ${juniorTokens.dividedBy(seniorTokens).multipliedBy(100).dp(2).toString()}%) | 2% scenario: Core ${coreAPR2Percent.multipliedBy(100).dp(1).toFixed(1)}% Growth ${growthAPR2Percent.multipliedBy(100).dp(1).toFixed(1)}% | 5% scenario: Core ${coreAPR5Percent.multipliedBy(100).dp(1).toFixed(1)}% Growth ${growthAPR5Percent.multipliedBy(100).dp(1).toFixed(1)}%`);
    }

    return result;
};

const LendMarketAction = ({ marketAddress }: { marketAddress: any }) => {
    const { lendState, setLendState } = useLendState();

    // Fetch managed config
    const { data: managedConfig } = useManagedConfig(marketAddress);

    // Get interest rate: need a collateral denom
    const { data: collateralDenoms } = useMarketCollateralDenoms(marketAddress);
    const primaryCollateral = collateralDenoms?.[0] ?? '';
    const { data: interestRate } = useMarketCollateralCost(marketAddress, primaryCollateral);

    // Total borrowed in market
    const { data: totalBorrowed } = useTotalBorrowed(marketAddress);

    // Compute APRs
    const { core: coreAPR, growth: growthAPR } = React.useMemo(
        () => computeTrancheAPRs(interestRate, totalBorrowed, managedConfig as ManagedConfig),
        [interestRate, totalBorrowed, managedConfig]
    );

    // Get CDT balance
    const cdtBalance = useBalanceByAsset(CDT_ASSET as Asset);

    const [tabIndex, setTabIndex] = React.useState(0);

    const handleSupplyAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setLendState({ supplyAmount: e.target.value });
    };

    const handleSetMax = () => {
        setLendState({ supplyAmount: cdtBalance.toString() });
    };

    const handleWithdrawAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setLendState({ withdrawAmount: e.target.value });
    };


    // Dynamic vault token denom based on tranche selection
    const vaultTokenDenom = lendState.isJunior 
        ? `factory/${marketAddress}/junior-debt-suppliers`
        : `factory/${marketAddress}/debt-suppliers`;
    
    const vaultTokenAsset = {
            base: vaultTokenDenom,
            symbol: lendState.isJunior ? 'jvCDT' : 'vCDT',
            logo: '/images/cdt.svg',
            decimal: 12,
            isLP: false,
            name: lendState.isJunior ? 'Junior Vault CDT' : 'Vault CDT',
            display: lendState.isJunior ? 'Junior Vault CDT' : 'Vault CDT',
            denom_units: [],
            coingecko_id: '',
            description: '',
        } as Asset
    const vaultTokenBalance = useBalanceByAsset(vaultTokenAsset);
    console.log("vaultTokenBalance", vaultTokenBalance)
    const { data: underlyingCDTData } = useManagedMarketUnderlyingCDT(marketAddress, shiftDigits(vaultTokenBalance, 12).toString(), lendState.isJunior);
    console.log("underlyingCDTData", underlyingCDTData)
    const withdrawMax = shiftDigits(underlyingCDTData ?? '0', -6).toString();

    const handleSetMaxWithdraw = () => {
        setLendState({ withdrawAmount: withdrawMax.toString() });
    };


    const { action: lend } = useLend({
        marketAddress: marketAddress,
        lendState: lendState,
        vaultTokenBalance: shiftDigits(vaultTokenBalance, 12).toString(),
        withdrawMax,
        run: true,
    });

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
            <Tabs index={tabIndex} onChange={setTabIndex} variant="soft-rounded" colorScheme="teal" w="100%">
                <TabList mb={4}>
                    <Tab>Lend</Tab>
                    <Tab>Withdraw</Tab>
                </TabList>
                <TabPanels>
                    <TabPanel px={0}>
                        {/* Tranche Selection for Lend */}
                        <VStack align="stretch" w="100%" mb={4} p={3} bg="#1a2330" borderRadius="lg" spacing={3}>
                            <Text color="white" fontSize="sm" fontWeight="medium" mb={2}>Yield Strategy</Text>
                            <RadioGroup value={lendState.isJunior ? "growth" : "core"} onChange={(value) => setLendState({ isJunior: value === "growth" })}>
                                <VStack align="stretch" spacing={3}>
                                    <HStack justify="space-between" align="flex-start" p={2} borderRadius="md" _hover={{ bg: "whiteAlpha.50" }}>
                                        <HStack spacing={2} flex={1}>
                                            <Radio value="core" colorScheme="teal" />
                                            <VStack align="flex-start" spacing={1} flex={1}>
                                                <HStack spacing={2}>
                                                    <HStack spacing={1} align="center">
                                                        <Text color="white" fontSize="sm" fontWeight="medium">Core</Text>
                                                        {coreAPR && <Text color="teal.200" fontSize="xs">{coreAPR}%</Text>}
                                                    </HStack>
                                                    <Tooltip 
                                                        label="Core: Stable returns with lower risk exposure. Protected from initial losses but limited upside capture."
                                                        placement="top"
                                                        hasArrow
                                                    >
                                                        <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="help" />
                                                    </Tooltip>
                                                </HStack>
                                                <Text color="whiteAlpha.600" fontSize="xs">Lower risk, stable returns</Text>
                                            </VStack>
                                        </HStack>
                                    </HStack>
                                    
                                    <HStack justify="space-between" align="flex-start" p={2} borderRadius="md" _hover={{ bg: "whiteAlpha.50" }}>
                                        <HStack spacing={2} flex={1}>
                                            <Radio value="growth" colorScheme="teal" />
                                            <VStack align="flex-start" spacing={1} flex={1}>
                                                <HStack spacing={2}>
                                                    <HStack spacing={1} align="center">
                                                        <Text color="white" fontSize="sm" fontWeight="medium">Growth</Text>
                                                        {growthAPR && <Text color="teal.200" fontSize="xs">{growthAPR}%</Text>}
                                                    </HStack>
                                                    <Tooltip 
                                                        label="Growth: Higher potential returns but increased risk exposure. First to absorb losses but first to capture upside."
                                                        placement="top"
                                                        hasArrow
                                                    >
                                                        <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="help" />
                                                    </Tooltip>
                                                </HStack>
                                                <Text color="whiteAlpha.600" fontSize="xs">Higher risk, potentially higher returns</Text>
                                            </VStack>
                                        </HStack>
                                    </HStack>
                                </VStack>
                            </RadioGroup>
                        </VStack>

                        {/* Lend Tab */}
                        <HStack justify="space-between" align="flex-start" w="100%" mb={4}>
                            <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium" alignSelf="center" >Supply Amount</Text>
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
                                    <HStack justify="space-between">
                                        <Text color="whiteAlpha.700">Tranche</Text>
                                        <Text color="white" fontWeight="bold">
                                            {lendState.isJunior ? "Growth" : "Core"}
                                        </Text>
                                    </HStack>
                                </VStack>
                            </Card>
                        </ConfirmModal>
                    </TabPanel>
                    <TabPanel px={0}>
                        {/* Tranche Selection for Withdraw */}
                        <VStack align="stretch" w="100%" mb={4} p={3} bg="#1a2330" borderRadius="lg" spacing={3}>
                            <Text color="white" fontSize="sm" fontWeight="medium" mb={2}>Withdraw From</Text>
                            <RadioGroup value={lendState.isJunior ? "growth" : "core"} onChange={(value) => setLendState({ isJunior: value === "growth" })}>
                                <VStack align="stretch" spacing={3}>
                                    <HStack justify="space-between" align="flex-start" p={2} borderRadius="md" _hover={{ bg: "whiteAlpha.50" }}>
                                        <HStack spacing={2} flex={1}>
                                            <Radio value="core" colorScheme="teal" />
                                            <VStack align="flex-start" spacing={1} flex={1}>
                                                <HStack spacing={2}>
                                                    <HStack spacing={1} align="center">
                                                        <Text color="white" fontSize="sm" fontWeight="medium">Core Balance</Text>
                                                        {coreAPR && <Text color="teal.200" fontSize="xs">{coreAPR}%</Text>}
                                                    </HStack>
                                                    <Tooltip 
                                                        label="Core Balance: Withdraw from your core position (lower risk/stable returns)"
                                                        placement="top"
                                                        hasArrow
                                                    >
                                                        <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="help" />
                                                    </Tooltip>
                                                </HStack>
                                                <Text color="whiteAlpha.600" fontSize="xs">Withdraw from core position</Text>
                                            </VStack>
                                        </HStack>
                                    </HStack>
                                    
                                    <HStack justify="space-between" align="flex-start" p={2} borderRadius="md" _hover={{ bg: "whiteAlpha.50" }}>
                                        <HStack spacing={2} flex={1}>
                                            <Radio value="growth" colorScheme="teal" />
                                            <VStack align="flex-start" spacing={1} flex={1}>
                                                <HStack spacing={2}>
                                                    <HStack spacing={1} align="center">
                                                        <Text color="white" fontSize="sm" fontWeight="medium">Growth Balance</Text>
                                                        {growthAPR && <Text color="teal.200" fontSize="xs">{growthAPR}%</Text>}
                                                    </HStack>
                                                    <Tooltip 
                                                        label="Growth Balance: Withdraw from your growth position (higher risk/reward)"
                                                        placement="top"
                                                        hasArrow
                                                    >
                                                        <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="help" />
                                                    </Tooltip>
                                                </HStack>
                                                <Text color="whiteAlpha.600" fontSize="xs">Withdraw from growth position</Text>
                                            </VStack>
                                        </HStack>
                                    </HStack>
                                </VStack>
                            </RadioGroup>
                        </VStack>

                        {/* Withdraw Tab */}
                        <HStack justify="space-between" align="flex-start" w="100%" mb={4}>
                            <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium"  alignSelf="center">Withdraw Amount</Text>
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
                                    onClick={handleSetMaxWithdraw}
                                >
                                    Max: {Formatter.toNearestNonZero(withdrawMax)}
                                </Text>
                            </VStack>
                        </HStack>

                        <Input
                            variant="unstyled"
                            fontSize="3xl"
                            fontWeight="bold"
                            color="white"
                            value={lendState.withdrawAmount}
                            onChange={handleWithdrawAmountChange}
                            type="number"
                            min={0}
                            placeholder="0"
                            w="100%"
                            _placeholder={{ color: 'whiteAlpha.400' }}
                            paddingInlineEnd={"3"}
                        />
                        <ConfirmModal
                            label={"WITHDRAW"}
                            action={lend}
                            isDisabled={!lendState.withdrawAmount || Number(lendState.withdrawAmount) <= 0}
                        >
                            <Card w="100%" bg="#181C23" borderRadius="lg" p={6} mt={0} mb={2}>
                                <Text fontWeight="semibold" mb={2}>Pending Withdraw:</Text>
                                <VStack align="stretch" spacing={2} fontSize="xs">
                                    <HStack justify="space-between">
                                        <Text color="whiteAlpha.700">Withdraw Amount</Text>
                                        <Text color="white" fontWeight="bold">{lendState.withdrawAmount} CDT</Text>
                                    </HStack>
                                    <HStack justify="space-between">
                                        <Text color="whiteAlpha.700">Tranche</Text>
                                        <Text color="white" fontWeight="bold">
                                            {lendState.isJunior ? "Growth Balance" : "Core Balance"}
                                        </Text>
                                    </HStack>
                                </VStack>
                            </Card>
                        </ConfirmModal>
                    </TabPanel>
                </TabPanels>
            </Tabs>
        </Card>
    );
};

export default LendMarketAction; 