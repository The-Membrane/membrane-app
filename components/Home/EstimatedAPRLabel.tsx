import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { num } from "@/helpers/num"
import { useEstimatedAnnualInterest } from "../Earn/hooks/useEarnQueries"
import { useMemo } from "react"
import { Text } from '@chakra-ui/react'


function estimatedAPRLabel(){
  const { data: revenue } = useEstimatedAnnualInterest(false)
  const { data: assetPool } = useStabilityAssetPool()
  const stabilityPoolAPR = useMemo(() => {
    if (revenue && assetPool) {
      return num(revenue.totalExpectedRevenue).dividedBy(assetPool.credit_asset.amount).toFixed(1)
    } else console.log("none of one", revenue, assetPool)
  }, [revenue, assetPool])


  return (
    <Text>{stabilityPoolAPR}%</Text>
  )
}

export default estimatedAPRLabel