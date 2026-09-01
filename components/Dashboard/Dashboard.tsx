import {
    Text, Stack, Slider, SliderFilledTrack, SliderTrack, Modal,
    ModalBody, Button,
    ModalContent,
    ModalOverlay, useDisclosure, Box, VStack
} from '@chakra-ui/react'

import React, { useMemo, useState } from "react"
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { FOCUS_STYLES } from '@/config/transitions'
import { useBasket } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { useRBLPCDTBalance } from '../../hooks/useEarnQueries'
import Divider from '../Divider'
import { Formatter } from '@/helpers/formatter'
import { TxButton } from '../TxButton'
import useBoundedManage from './hooks/useRangeBoundLPManage'
import useFulfillIntents from './hooks/useFulfillIntents'
import FulfillManagedMMButton, { CheckManagedIntents } from './FulfillManagedMMButton'
import { StatsTitle } from '../StatsTitle'
import { getAssetByDenom } from '@/helpers/chain'
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import { Price } from '@/services/oracle'
import { num } from '@/helpers/num'
import { useOraclePrice } from '@/hooks/useOracle'
import AssetPieChart from './PieChart'
import { OracleHealth } from './OracleHealth'
import useGiveRBLPPoints from './hooks/useGiveRBLPPoints'
import { SupplyCaps } from './SupplyCaps'
import { useChainRoute } from '@/hooks/useChainRoute'
import { CheckLiquidations } from '../Bid/Bid'
import useAppState from '@/persisted-state/useAppState'

const ManagementCard = React.memo(function ManagementCard({ basket }: { basket: any }) {
    const [idSkips, setSkips] = useState([] as number[])

    const { action: manage } = useBoundedManage()
    const { action: fulfill } = useFulfillIntents({ run: true, skipIDs: idSkips })
    const { action: givePoints } = useGiveRBLPPoints()

    const revenueDistributionThreshold = 50000000
    const percentToDistribution = useMemo(() => {
        if (!basket) return 0
        return num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber()

    }, [basket])
    const isGivePointsDisabled = givePoints?.simulate.isError || !givePoints?.simulate.data
    const isManageDisabled = manage?.simulate.isError || !manage?.simulate.data
    const isFulfillDisabled = useMemo(() => {
        if (fulfill?.simulate.isError) {
            //Find the position ID string in the error, it'll look like Position doesn't exist: 1
            const positionID = fulfill?.simulate.error?.message?.match(/Position doesn't exist: (\d+)/)?.[1];
            if (positionID && !idSkips.includes(Number(positionID))) {
                // idSkips.push(positionID)
                setSkips([...idSkips, Number(positionID)])
            }
        }
        return fulfill?.simulate.isError || !fulfill?.simulate.data
    }, [fulfill?.simulate.isError, fulfill?.simulate.data, fulfill?.simulate.error?.message, idSkips])
    // if (isFulfillDisabled) console.log("isFulfillDisabled", fulfill?.simulate, fulfill?.simulate.isError, !fulfill?.simulate)
    return (
        <VStack align="stretch" spacing={SPACING.lg} w="full">
            <Text
                as="h1"
                fontFamily={TYPOGRAPHY.fontDisplay}
                fontSize={TYPOGRAPHY.h1}
                fontWeight={TYPOGRAPHY.bold}
                color={SEMANTIC_COLORS.textPrimary}
            >
                Product Management
            </Text>
            <Card>
                <VStack spacing={SPACING.lg} align="stretch">
                    <TxButton
                        maxW="100%"
                        isLoading={fulfill?.simulate.isLoading || fulfill?.tx.isPending}
                        isDisabled={isFulfillDisabled}
                        onClick={() => fulfill?.tx.mutate()}
                        toggleConnectLabel={false}
                        style={{ alignSelf: "center" }}
                    >
                        Fulfill CDP Intents
                    </TxButton>

                    {/* Managed Market intents button */}
                    <CheckManagedIntents />
                    <CheckLiquidations />
                    <TxButton
                        maxW="100%"
                        isLoading={givePoints?.simulate.isLoading || givePoints?.tx.isPending}
                        isDisabled={isGivePointsDisabled}
                        onClick={() => givePoints?.tx.mutate()}
                        toggleConnectLabel={false}
                        style={{ alignSelf: "center" }}
                    >
                        Give Range Bound Points
                    </TxButton>
                    <Slider
                        defaultValue={percentToDistribution}
                        isReadOnly
                        cursor="default"
                        min={0}
                        max={1}
                        value={percentToDistribution}
                    >
                        <SliderTrack h="1.5">
                            <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
                        </SliderTrack>
                    </Slider>
                    <TxButton
                        maxW="100%"
                        isLoading={manage?.simulate.isLoading || manage?.tx.isPending}
                        isDisabled={isManageDisabled}
                        onClick={() => manage?.tx.mutate()}
                        toggleConnectLabel={false}
                        style={{ alignSelf: "center" }}
                    >
                        {isManageDisabled && percentToDistribution >= 1 ? "Next Repayment Pays to LPs" : "Manage Vault"}
                    </TxButton>
                </VStack>
            </Card>
        </VStack>
    )
})

const getProjectTVL = ({ basket, prices, chainName }: { basket?: Basket; prices?: Price[]; chainName: string }) => {
    if (!basket || !prices) return { TVL: 0, positions: [] }
    const positions = basket?.collateral_types.map((asset) => {
        //@ts-ignore
        const denom = asset.asset?.info.native_token?.denom
        const assetInfo = getAssetByDenom(denom, chainName)
        // console.log(assetInfo, denom, asset.asset)
        const amount = shiftDigits(asset.asset.amount, -(assetInfo?.decimal ?? 6)).toNumber()
        const assetPrice = prices?.find((price) => price.denom === denom)?.price || 0
        // console.log(assetInfo?.symbol, amount, assetPrice)

        const usdValue = Number(num(amount).times(assetPrice).toFixed(1))
        // console.log(assetInfo?.symbol, usdValue, amount, assetPrice)
        return { name: assetInfo?.symbol, value: usdValue, totalValue: 0 }
    })

    return {
        TVL: positions.reduce((acc, position) => {
            if (!position) return acc
            return acc + position.value
        }, 0), positions
    }
}

const Dashboard = () => {
    const { appState } = useAppState()
    const { data: basket } = useBasket(appState.rpcUrl)
    const { data: prices } = useOraclePrice()
    const { chainName } = useChainRoute()
    const assetData = useMemo(() => {
        // TODO(evm-migration): getProjectTVL is a legacy CosmWasm-shape transform; basket is
        // null-stubbed and prices is the EVM denom-price shape, so cast through.
        const { TVL, positions } = getProjectTVL({ basket, prices, chainName } as any)
        //Set TVL in each position object to the outputted TVL
        positions.forEach((position) => {
            position.totalValue = TVL
        })
        return positions

    }, [basket, prices, chainName])

    const { isOpen, onOpen, onClose } = useDisclosure()
    const [modalHasOpened, setModalHasOpened] = useState(false)

    useMemo(() => {
        if (!modalHasOpened) {
            onOpen()
            setModalHasOpened(true)
        }
    }, [modalHasOpened, onOpen])

    return (
        <Box w="full" px={{ base: 2, md: 8 }} py={{ base: 4, md: 8 }}>
            <VStack align="stretch" spacing={SPACING.xl} w="full" maxW="1200px" mx="auto">
                <StatsTitle />
                <Divider mx="0" mb="5" />
                {/* Responsive layout for charts */}
                <Stack
                    direction={{ base: "column", md: "row" }}
                    alignItems="flex-start"
                    spacing={8}
                    w="full"
                >
                    <Card w={{ base: "100%", md: "50%" }}>
                        <AssetPieChart data={assetData} />
                    </Card>
                    <Card w={{ base: "100%", md: "50%" }}>
                        <OracleHealth />
                    </Card>
                </Stack>
                <Stack
                    direction={{ base: "column", md: "row" }}
                    alignItems="flex-start"
                    spacing={8}
                    w="full"
                >
                    <Box w={{ base: "100%", md: "50%" }}>
                        <ManagementCard basket={basket} />
                    </Box>
                    <Card w={{ base: "100%", md: "50%" }}>
                        <SupplyCaps />
                    </Card>
                </Stack>
            </VStack>

            {/* Modal */}
            <Modal isOpen={isOpen} onClose={onClose} size="xl" isCentered closeOnOverlayClick={true}>
                <ModalOverlay />

                <ModalContent
                    h={"fit-content"}
                    w="fit-content"
                    bg={SEMANTIC_COLORS.bgSecondary}
                    borderRadius={0}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderMedium}
                    padding="0"
                    textAlign="center"
                >
                    <ModalBody p={SPACING.base} pb={SPACING_PATTERNS.modalPadding} position="relative" zIndex={1}>
                        <Stack h="full">
                            <Text
                                fontFamily={TYPOGRAPHY.fontDisplay}
                                fontSize={TYPOGRAPHY.h2}
                                color={SEMANTIC_COLORS.textPrimary}
                                alignSelf="center"
                                paddingTop={SPACING.base}
                            >
                                This is where the experiments are monitored, are you prepared to see behind the veil?
                            </Text>
                            <Button
                                onClick={onClose}
                                w="fit-content"
                                alignSelf="center"
                                mt={SPACING.base}
                                borderRadius={0}
                                _focus={FOCUS_STYLES.ring}
                            >
                                Peek
                            </Button>
                        </Stack>
                    </ModalBody>
                </ModalContent>
            </Modal>
        </Box>
    );

};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Dashboard;