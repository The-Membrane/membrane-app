import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { num } from "@/helpers/num"
import { useEstimatedAnnualInterest } from "../Earn/hooks/useEarnQueries"
import { useMemo } from "react"
import { Text } from '@chakra-ui/react'
import useBidState from "../Bid/hooks/useBidState"


function estimatedAPRLabel(){
  const { setBidState } = useBidState()
  const { data: revenue } = useEstimatedAnnualInterest(false)
  console.log("revenue", revenue)
  const { data: assetPool } = useStabilityAssetPool()
  const stabilityPoolAPR = useMemo(() => {
    if (revenue && assetPool) {
        console.log("returning", num(revenue.totalExpectedRevenue).dividedBy(assetPool.credit_asset.amount).toFixed(1), revenue.totalExpectedRevenue, assetPool.credit_asset.amount, assetPool)
        setBidState({cdpExpectedAnnualRevenue: revenue.totalExpectedRevenue})

        return num(revenue.totalExpectedRevenue).dividedBy(assetPool.credit_asset.amount).toFixed(1)
    } else console.log("none of one", revenue, assetPool)
  }, [revenue, assetPool])


  return (
    <Text>{stabilityPoolAPR}%</Text>
  )
}

export default estimatedAPRLabel
