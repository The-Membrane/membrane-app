import { HStack, Stack, Button, Card, Text, Modal, ModalOverlay, useDisclosure } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import { RedemptionDepositModal, RedemptionWithdrawModal } from './MintModals'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useOraclePrice } from '@/hooks/useOracle'
import { useUserPositions, useUserRemptionInfo } from '@/hooks/useCDP'
import useMintState from './hooks/useMintState'
import { shiftDigits } from '@/helpers/math'
import { useChainRoute } from '@/hooks/useChainRoute'

const RedemptionCard = () => {
    const { chainName } = useChainRoute()
    const { data: userRedemptionInfo } = useUserRemptionInfo()
    console.log("userRedemptionInfo", userRedemptionInfo)
    const userPremium = userRedemptionInfo?.premium_infos[0]?.premium ?? 0


    //////DEPOSIT STATE STUFF/////
    const { data: prices } = useOraclePrice()
    const usdcPrice = useMemo(() =>
        parseFloat(prices?.find((price) => price.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")?.price ?? "0"),
        [prices])

    const usdcAssetInfo = useAssetBySymbol('USDC', chainName)
    const usdcBalance = useBalanceByAsset(usdcAssetInfo) ?? "1"
    const usdcAsset = { ...usdcAssetInfo, balance: usdcBalance, price: usdcPrice }
    const isDepositDisabled = usdcBalance === "0"

    /////WITHDRAWL STATE STUFF///
    const { mintState } = useMintState()
    const { data: basketPositions } = useUserPositions()
    //Use the current position id or use the basket's next position ID (for new positions)
    const positionId = useMemo(() => {
        return basketPositions?.[0]?.positions?.[mintState.positionNumber - 1]?.position_id || 0
    }, [basketPositions, mintState.positionNumber])
    //Get the position we're working with
    const position = basketPositions?.[0]?.positions?.find((pos: any) => pos.position_id === positionId)
    const usdcDeposit = position?.collateral_assets.find((a: any) => a.asset.info.native_token.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")?.asset.amount ?? "0"
    // const { data: underlyingUSDC } = useDepositTokenConversionforMarsUSDC(marsUSDCDeposit) ?? "0"
    // const { data: marsUSDCyield } = useMarsUSDCSupplyAPR() ?? "0"
    const isWithdrawDisabled = usdcDeposit === "0"


    const { isOpen: isDepositOpen, onOpen: onDepositOpen, onClose: onDepositClose } = useDisclosure()
    const { isOpen: isWithdrawOpen, onOpen: onWithdrawOpen, onClose: onWithdrawClose } = useDisclosure()


    return (<>
        <Card
            minW={{ base: '100%', md: '363px' }}
            maxW={{ base: '100%', md: '500px' }}
            gap="12"
            h="max-content"
            px="2"
        >
            <Stack gap="5" padding="3%">
                <Text fontSize="18px" fontWeight={"bold"}>
                    {usdcDeposit === "0"
                        ? "Setup USDC to auto-buy & repay CDT under peg to profit from arbitrage."
                        : `${shiftDigits(usdcDeposit, -6).toFixed(2)} USDC in wait for a ${userPremium}% arbitrage opportunity.`
                    }
                </Text>
                <HStack width={"100%"} justifyContent={usdcDeposit === "0" ? "center" : "end"}>
                    <Button
                        width={usdcDeposit === "0" ? "50%" : "33%"}
                        display="flex"
                        padding="0"
                        alignSelf="center"
                        margin="0"
                        onClick={onDepositOpen}
                        isDisabled={isDepositDisabled}
                    >
                        Set
                    </Button>
                    {usdcDeposit != "0" && <Button
                        width="33%"
                        display="flex"
                        padding="0"
                        alignSelf="center"
                        margin="0"
                        onClick={onWithdrawOpen}
                        isDisabled={isWithdrawDisabled}
                    >
                        Exit
                    </Button>}
                </HStack>
            </Stack>
        </Card>


        <Modal
            isOpen={isDepositOpen}
            onClose={onDepositClose}
            isCentered
            size="xl"
            closeOnOverlayClick={true}
        >
            <ModalOverlay />
            <RedemptionDepositModal isOpen={isDepositOpen} onClose={onDepositClose} usdcAsset={usdcAsset} />


        </Modal>
        <Modal
            isOpen={isWithdrawOpen}
            onClose={onWithdrawClose}
            isCentered
            size="xl"
            closeOnOverlayClick={true}
        >
            <ModalOverlay />
            <RedemptionWithdrawModal isOpen={isWithdrawOpen} onClose={onWithdrawClose} usdcDeposit={Number(usdcDeposit)} usdcImage={usdcAsset.logo} />

        </Modal>


    </>
    )
}

export default RedemptionCard