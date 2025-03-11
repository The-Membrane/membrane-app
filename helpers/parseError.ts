import { useBasket } from "@/hooks/useCDP"
import { stake } from "@/services/staking"
import { position } from "@chakra-ui/react"
import { getAssetByDenom } from "./chain"

//Get the collateral assets from the Basket and create regex errors for them
const collateralSupplyCapErrors = () => {
  const { data: basket } = useBasket()
  const basketAssets = basket?.collateral_types

  return basketAssets?.map((asset) => {
    //@ts-ignore
    const assetDenom = asset.asset.info.native_token.denom
    const assetSymbol = getAssetByDenom(assetDenom)?.symbol
    return {
      regex: new RegExp(`Supply cap ratio for ${assetDenom}`, 'i'),
      message: `This transaction puts ${assetSymbol} over its supply cap. If withdrawing, withdraw ${assetSymbol}. If depositing with debt, withdraw ${assetSymbol} first. If depositing without debt, deposit enough of a different asset to reduce ${assetSymbol}'s cap so you can deposit it. If minting from zero debt with multiple cllateral, withdraw ${assetSymbol} first & attempt to deposit it after the mint.`,
    }
  })
}

export const parseError = (error: string) => {
  var customErrors = [
    { regex: /Unexpected token '<'/i, message: 'RPC bug, please refresh.' },
    { regex: /insufficient funds/i, message: 'Insufficient funds' },
    { regex: /overflow: cannot sub with/i, message: 'Insufficient funds' },
    { regex: /max spread assertion/i, message: 'Try increasing slippage' },
    { regex: /request rejected/i, message: 'User denied' },
    { regex: /ran out of ticks for pool/i, message: 'Low liquidity, try lower amount' },
    { regex: /no liquidity in pool/i, message: 'No liquidity available' },
    { regex: /token amount calculated/i, message: 'Try increasing slippage' },
    { regex: /Must stake at least 1 MBRN/i, message: "You aren't claiming enough to stake, must be more than 1 MBRN" },
    { regex: /is below minimum/i, message: 'Minimum 20 CDT to mint' },
    { regex: /invalid coin/i, message: 'Invalid coins provided' },
    { regex: /tx already exists in cache/i, message: 'Transaction already exists in cache' },
    { regex: /Makes position insolvent/i, message: 'Amount exceeds the maximum LTV' },
    { regex: /You don't have any voting power!/i, message: "You don't have any voting power!" },
    { regex: /Bid amount too small, minimum is 5000000/i, message: 'Minimum bid amount is 5 CDT' },
    { regex: /Deposit is too small, minimum is Uint128\(5000000\)/i, message: 'Minimum deposit amount is 6 CDT' },
    { regex: /Maximum position number/i, message: "You've reached the max position number for this wallet" },
    { regex: /big.Int: tx parse error/i, message: "Max amount per deposit for this token is 999, if this error seems wrong, just jiggle the slider." },
    { regex: /invalid Uint128/i, message: "Max amount per deposit for this token is 999, if this error seems wrong, just jiggle the slider." },
    { regex: /rate assurance failed/i, message: "Depositor safety check failed, operational error. Refresh for the Manic vault or Manage The Membrane LP." },
    { regex: / Invalid target_LTV for debt increase/i, message: "Intent failed, are you above the minimum amount?" },
    { regex: / Invalid limit, deposit length:/i, message: "Omni-Pool is empty, deposit the minimum to unblock liquidations." },
    { regex: / Position is solvent and shouldn't be liquidated/i, message: "False positive, position is solvent." },
    {
      regex: /Invalid withdrawal, can't leave less than the minimum bid/i,
      message: 'Minimum bid amount is 5 CDT',
    },
    {
      regex: /Extension context invalidated/i,
      message: 'Make sure your wallet is unlocked and refresh the page',
    },
    {
      regex: /account sequence mismatch/i,
      message: 'Account sequence mismatch, previous tx is still pending try back in some time.',
    },
    {
      regex: /Unexpected end of JSON input/i,
      message: 'Success despite error',
    },
  ]
  customErrors = customErrors.concat(collateralSupplyCapErrors() ?? [])

  const errorMessage = error || ''
  // console.log("error:", errorMessage)

  const matchedError = customErrors.find(({ regex }) => regex.test(errorMessage))
  if (!matchedError) console.log("error:", errorMessage)

  return matchedError ? matchedError.message : errorMessage//'Something went wrong, please try again'
}
