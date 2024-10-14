import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { num } from "@/helpers/num"
import { useEstimatedAnnualInterest } from "../Earn/hooks/useEarnQueries"
import { useMemo } from "react"
import { Text } from '@chakra-ui/react'
import useBidState from "../Bid/hooks/useBidState"


function estimatedAPRLabel(){
  const { data: revenue } = useEstimatedAnnualInterest(false)
  const { data: assetPool } = useStabilityAssetPool()
  const { bidState } = useBidState()
  const stabilityPoolAPR = useMemo(() => {
    if (revenue && assetPool) {

        return num(revenue.totalExpectedRevenue).dividedBy(assetPool.credit_asset.amount).multipliedBy(100).toFixed(1) + "%"
    } else console.log("none of one", revenue, assetPool)
  }, [revenue, assetPool])



  return (
    <Text>{bidState.cdpExpectedAnnualRevenue ? stabilityPoolAPR : "loading..."}</Text>
  )
}

export default estimatedAPRLabel
