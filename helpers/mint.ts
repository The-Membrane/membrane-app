import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { num } from './num'
import { Summary } from '@/components/Mint/hooks/useMintState'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'
import contracts from '@/config/contracts.json'
import { Asset, BasketPositionsResponse } from '@/contracts/codegen/positions/Positions.types'
import { Coin, coin } from '@cosmjs/stargate'
import { shiftDigits } from './math'
import { getAssetBySymbol } from './chain'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { PointsMsgComposer } from '@/contracts/codegen/points/Points.message-composer'

// const getDeposited = (deposited = 0, newDeposit: string) => {
//   const diff = num(newDeposit).minus(deposited).dp(6).toNumber()
//   return diff !== 0 ? diff : 0
// }

// const calculateNewDeposit = (sliderValue: number, combinUsdValue: number, price: number) => {
//   return num(sliderValue).times(combinUsdValue).dividedBy(100).dividedBy(price).toFixed(6)
// }

export const getSummary = (assets: AssetWithBalance[]) => {
  const summary = assets
    .filter((asset) => num(asset.amount).dp(5).abs().isGreaterThan(0))
    .sort((a) => (num(a.amount).isNegative() ? 1 : -1))

  const totalUsdValue = summary?.reduce((acc, asset) => {
    return acc + num(asset.amountValue).toNumber()
  }, 0)

  return { summary, totalUsdValue }
}

export const calcuateMintAndRepay = (
  sliderValue: number,
  originalLTV: number,
  originalTVL: number,
  borrowLTV: number,
  tvl: number,
  debtAmount: number,
) => {
  const originalLtvAmount = num(originalLTV).times(originalTVL).dividedBy(100).dp(2).toNumber()
  const maxLtvAmount = num(borrowLTV).times(tvl).dividedBy(100).dp(2).toNumber()
  const newLtvAmount = num(sliderValue).times(maxLtvAmount).dividedBy(100).dp(2).toNumber()
  const diff = num(originalLtvAmount).minus(newLtvAmount).abs().dp(2).toNumber()
  let repay = num(newLtvAmount).isLessThan(originalLtvAmount) ? diff : 0
  let mint = num(originalLtvAmount).isLessThan(newLtvAmount) ? diff : 0
  let overdraft = false

  if (maxLtvAmount < debtAmount) {
    repay = num(debtAmount).minus(maxLtvAmount).dp(2).toNumber()
    mint = 0
  } else {
    mint = 0
    repay = 0
  }

  // if maxLtvAmount is less than debtAmount, then set overdraft to true
  if (num(maxLtvAmount).isLessThan(debtAmount)) overdraft = true

  return {
    mint,
    repay,
    overdraft,
  }
}

export const setInitialMintState = ({
  combinBalance,
  ltv,
  borrowLTV,
  setMintState,
}: {
  combinBalance: any
  ltv: any
  borrowLTV: any
  setMintState: any
}) => {
  // const assets = combinBalance
  //   ?.filter((balance) => num(balance.combinUsdValue || 0).isGreaterThan(0))
  //   .map((balance) => {
  //     const sliderValue = num(balance.deposited)
  //       .dividedBy(balance.combinBalance)
  //       .times(100)
  //       .toNumber()
  //     const amount = num(sliderValue)
  //       .times(balance.combinUsdValue)
  //       .dividedBy(100)
  //       .dividedBy(balance.price)
  //       .toFixed(sliderValue === 0 ? 2 : 6)
  //     const amountValue = num(amount).times(balance.price).toNumber()

  //     return {
  //       ...balance,
  //       amount,
  //       amountValue,
  //       sliderValue,
  //     }
  //   })

  const assetsWithValuesGreaterThanZero = combinBalance
    ?.filter((asset) => {
      return num(asset.combinUsdValue || 0).isGreaterThan(1)
    })
    .map((asset) => ({
      ...asset,
      sliderValue: asset.depositUsdValue || 0,
      amount: 0,
      amountValue: 0,
    }))

  const ltvSlider = num(ltv).times(100).dividedBy(borrowLTV).toNumber()

  setMintState({
    assets: assetsWithValuesGreaterThanZero,
    ltvSlider,
    mint: 0,
    repay: 0,
    summary: [],
    totalUsdValue: 0,
    overdraft: false,
    newDebtAmount: 0,
  })
}

type GetDepostAndWithdrawMsgs = {
  summary?: Summary[]
  address: string
  basketPositions: BasketPositionsResponse[] | undefined
  positionId: string
  hasPosition?: boolean
}

const getAsset = (asset: any): Asset => {
  return {
    amount: shiftDigits(Math.abs(asset.amount), asset.decimal).dp(0).toNumber().toString(),
    info: {
      native_token: {
        denom: asset.base,
      },
    },
  }
}

export const getDepostAndWithdrawMsgs = ({
  summary,
  address,
  basketPositions,
  positionId,
  hasPosition = true,
}: GetDepostAndWithdrawMsgs) => {
  const messageComposer = new PositionsMsgComposer(address, contracts.cdp)

  const deposit: Summary[] = []
  const withdraw: Summary[] = []
  const msgs = []

  summary?.forEach((asset) => {
    if (num(asset.amount).isGreaterThan(0)) {
      deposit.push(asset)
    } else {
      if (asset.sliderValue == 0 && basketPositions) {
        //Find asset in basketPositions
        const position = basketPositions[0].positions.find((p: any) => p.position_id === positionId)
        console.log("pID", position, asset.base, position?.collateral_assets)
        const assetFound = position?.collateral_assets.find((a: any) => a.base === asset.base)
        console.log("pID", assetFound)
        console.log("pID", assetFound?.asset.amount)


        const amount = basketPositions[0].positions.find((p: any) => p.position_id === positionId)?.collateral_assets.find((a: any) => a.base === asset.base)?.asset.amount
        console.log("full withdrawal amount", amount)
        if (amount) asset.amount = amount
      }
      withdraw.push(asset)
    }
  })
  // user_coins.sort((a, b) => a.denom < b.denom ? -1 : 1,);

  const depositFunds = deposit
    .sort((a, b) => (a.base < b.base ? -1 : 1))
    .map((asset) => {
      const amount = shiftDigits(asset.amount, asset.decimal).dp(0).toNumber().toString()
      console.log("amount", amount)
      return {
        denom: asset.base,
        amount: amount,
      }
    })


  if (depositFunds.length > 0) {
    if (hasPosition) {
      const depositMsg = messageComposer.deposit({ positionId, positionOwner: address }, depositFunds)
      msgs.push(depositMsg)
    } else {
      //Don't use positionID, deposit into new position
      const depositMsg = messageComposer.deposit({ positionOwner: address }, depositFunds)
      msgs.push(depositMsg)
    }
  }

  if (withdraw.length > 0) {
    const withdrawMsg = messageComposer.withdraw({
      positionId,
      assets: withdraw?.map((asset) => getAsset(asset)),
    })
    msgs.push(withdrawMsg)
  }

  return msgs
}

type GetMintAndRepayMsgs = {
  mintAmount?: string | number
  repayAmount?: string | number
  address: string
  positionId: string
}
export const getMintAndRepayMsgs = ({
  address,
  positionId,
  mintAmount = '0',
  repayAmount = '0',
}: GetMintAndRepayMsgs) => {
  const messageComposer = new PositionsMsgComposer(address, contracts.cdp)
  const msgs = []

  if (num(mintAmount).isGreaterThan(0)) {
    //Add Mint msg  
    const mintMsg = messageComposer.increaseDebt({
      positionId,
      amount: shiftDigits(mintAmount, 6).dp(0).toString(),
    })
    msgs.push(mintMsg)
  }

  if (num(repayAmount).isGreaterThan(0)) {
    //Add points check/allocate before and after
    const pointsMessageComposer = new PointsMsgComposer(address, contracts.points)
    msgs.push(pointsMessageComposer.checkClaims({
      cdpRepayment: {
        position_id: positionId,
        position_owner: address
      },
      spClaims: false,
      lqClaims: false,
    }))

    const cdt = getAssetBySymbol('CDT')
    const microAmount = shiftDigits(repayAmount, 6).dp(0).toString()
    const funds = [coin(microAmount, cdt?.base!)]
    const repayMsg = messageComposer.repay({ positionId, sendExcessTo: address }, funds)
    //Push repay msg
    msgs.push(repayMsg)
    //Add points allocation after msgs    
    msgs.push(pointsMessageComposer.givePoints({
      cdpRepayment: true,
      spClaims: false,
      lqClaims: false,
    }))
  }

  return msgs
}

type GetLiqMsgs = {
  address: string
  liq_info: any[]
}
export const getLiquidationMsgs = ({
  address,
  liq_info
}: GetLiqMsgs) => {
  const messageComposer = new PointsMsgComposer(address, contracts.points)
  const msgs = [] as MsgExecuteContractEncodeObject[]

  liq_info.map((liq) => {
    const liqMsg = messageComposer.liquidate({
      positionId: liq.id,
      positionOwner: liq.address
    })
    msgs.push(liqMsg)
  })

  return msgs
}

