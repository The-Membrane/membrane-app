import { Card, Text, Stack, HStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, List, ListItem } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useEffect, useMemo, useState } from "react"
import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { isGreaterThanZero, num } from "@/helpers/num"
import { useUSDCVaultTokenUnderlying, useEstimatedAnnualInterest, useVaultInfo, useEarnUSDCEstimatedAPR, useEarnUSDCRealizedAPR } from "../Earn/hooks/useEarnQueries"
import useBidState from "../Bid/hooks/useBidState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import ActModal from "../Earn/ActModal"
import { SliderWithState } from "../Mint/SliderWithState"
import { shiftDigits } from "@/helpers/math"
import useAutoSP from "./hooks/useAutoSP"
import { useBasket } from "@/hooks/useCDP"
import Divider from "../Divider"
import React from "react"
import ConfirmModal from "../ConfirmModal"
import { QASummary } from "./QASummary"
import { GrPowerReset } from "react-icons/gr"

const CDTSwapSliderCard = () => {
    const cdtAsset = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdtAsset)??"1"

    return (
        <Card width={"100%"} borderColor={""} borderWidth={3} padding={4}>
          <HStack gap={"42%"}>
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}  width="35%"> Available CDT Balance: {num(cdtBalance).toFixed(1)}</Text>
            <Button width="20%">Swap for CDT</Button>
           </HStack> 
        </Card>
    )
}

export default CDTSwapSliderCard