/**
 * Chainlink mainnet USD feed proxies. CLIENT-SAFE: constants only, no RPC, no `fs`.
 * historyScan.ts (server-only) re-exports these; a component (ethUsdSpot.ts, through the
 * Risk Frontier view model) imports them from here, never from historyScan.ts, whose
 * imports pull rpcRing.ts and `fs` into the client bundle.
 */

import type { Address } from 'viem'

/** Chainlink mainnet USD feed PROXIES, 8 decimals. The proxy is the stable address; the
 *  AnswerUpdated logs live on its phase aggregators, resolved at run time in historyScan.ts.
 *
 *  NOT FOUND IN THIS REPO: the Oct 10 dataset was built from Chainlink logs
 *  (public/data/oct10-2025/manifest.json) but scripts/build-oct10-dataset.ts consumes a
 *  CSV produced outside the repo, so no feed address is committed anywhere. These are
 *  the canonical mainnet proxies and each one's `description()` is checkable on chain. */
export const FEEDS = {
  ETH_USD: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as Address,
  BTC_USD: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' as Address,
  STETH_USD: '0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8' as Address,
  LINK_USD: '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c' as Address,
  AAVE_USD: '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9' as Address,
  UNI_USD: '0x553303d460EE0afB37EdFf9bE42922D8FF63220e' as Address,
  CRV_USD: '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f' as Address,
  ENS_USD: '0x5C00128d4d1c2F4f652C267d7bcdD7aC99C16E16' as Address,
  SNX_USD: '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699' as Address,
  ONEINCH_USD: '0xc929ad75B72593967DE83E7F7Cda0493458261D9' as Address,
  BAL_USD: '0xdF2917806E30300537aEB49A7663062F4d1F2b5F' as Address,
  FXS_USD: '0x6Ebc52C8C1089be9eB3945C4350B68B8E4C2233f' as Address,
}
