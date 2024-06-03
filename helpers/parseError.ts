import { stake } from "@/services/staking"

export const parseError = (error: Error) => {
  const customErrors = [
    { regex: /insufficient funds/i, message: 'Insufficient funds' },
    { regex: /overflow: cannot sub with/i, message: 'Insufficient funds' },
    { regex: /max spread assertion/i, message: 'Try increasing slippage' },
    { regex: /request rejected/i, message: 'User denied' },
    { regex: /ran out of ticks for pool/i, message: 'Low liquidity, try lower amount' },
    { regex: /no liquidity in pool/i, message: 'No liquidity available' },
    { regex: /token amount calculated/i, message: 'Try increasing slippage' },
    { regex: /Must stake at least 1 MBRN/i, message: "You aren't claiming enough to stake, must be more than 1 MBRN" },
    { regex: /is below minimum/i, message: 'Minimum 100 CDT to mint' },
    { regex: /invalid coin/i, message: 'Invalid coins provided' },
    { regex: /tx already exists in cache/i, message: 'Transaction already exists in cache' },
    { regex: /Makes position insolvent/i, message: 'Amount exceeds the maximum LTV' },
    { regex: /You don't have any voting power!/i, message: "You don't have any voting power!" },
    { regex: /Bid amount too small, minimum is 5000000/i, message: 'Minimum bid amount is 5 CDT' },
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

  const errorMessage = error?.message || ''

  const matchedError = customErrors.find(({ regex }) => regex.test(errorMessage))
  if (!matchedError) console.log(errorMessage)
  
  return matchedError ? matchedError.message : errorMessage//'Something went wrong, please try again'
}
