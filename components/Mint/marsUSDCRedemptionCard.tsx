import { HStack, Stack, Button, Card } from '@chakra-ui/react'
import React, { useCallback, useMemo, useState } from 'react'
import { RedemptionDepositModal, RedemptionWithdrawModal } from './MintModals'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useOraclePrice } from '@/hooks/useOracle'
import { useUserPositions } from '@/hooks/useCDP'
import useMintState from './hooks/useMintState'

const RedemptionCard = () => {


    //////DEPOSIT STATE STUFF/////
    const { data: prices } = useOraclePrice()
    const usdcPrice = useMemo(() =>
        parseFloat(prices?.find((price) => price.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")?.price ?? "0"),
        [prices])

    const usdcAssetInfo = useAssetBySymbol('USDC')
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
    const position = basketPositions?.[0]?.positions?.find((pos) => pos.position_id === positionId)
    const marsUSDCDeposit = position?.collateral_assets.find((a: any) => a.asset.info.native_token.denom === "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized")?.asset.amount
    const isWithdrawDisabled = marsUSDCDeposit === "0"

    const [isDepositOpen, setIsDepositOpen] = useState(false)
    const toggleDepositOpen = useCallback(() => {
        setIsDepositOpen(prev => !prev)
    }, [])
    const [isWithdrawOpen, setIsWithdrawOpenOpen] = useState(false)
    const toggleWithdrawOpen = useCallback(() => {
        setIsWithdrawOpenOpen(prev => !prev)
    }, [])


    return (
        <Card minW="363px" gap="12" h="max-content" px="2">
            <Stack gap="5" padding="3%">
                <HStack width={"36%"}>
                    <Button
                        width="50%"
                        display="flex"
                        padding="0"
                        alignSelf="center"
                        margin="0"
                        onClick={() => { toggleDepositOpen() }}
                        isDisabled={isDepositDisabled}
                    >
                        Setup
                    </Button>
                    {isDepositOpen && <RedemptionDepositModal isOpen={isDepositOpen} onClose={toggleDepositOpen} usdcAsset={usdcAsset} />}


                    {isWithdrawOpen && <RedemptionWithdrawModal isOpen={isWithdrawOpen} onClose={toggleWithdrawOpen} marsUSDCDeposit={Number(marsUSDCDeposit)} />}

                    <Button
                        width="50%"
                        display="flex"
                        padding="0"
                        alignSelf="center"
                        margin="0"
                        onClick={() => { toggleWithdrawOpen() }}
                        isDisabled={isWithdrawDisabled}
                    >
                        Retreat
                    </Button>
                </HStack>
            </Stack>
        </Card>
    )
}

export default RedemptionCard