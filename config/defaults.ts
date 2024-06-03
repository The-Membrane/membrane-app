import { swapRoutes } from '@/services/osmosis'
import { GeneratedType, Registry } from '@cosmjs/proto-signing'
import { AminoTypes } from '@cosmjs/stargate'
import {
  cosmosAminoConverters,
  cosmosProtoRegistry,
  cosmwasmAminoConverters,
  cosmwasmProtoRegistry,
  ibcAminoConverters,
  ibcProtoRegistry,
  osmosisAminoConverters,
  osmosisProtoRegistry,
} from 'osmojs'

const protoRegistry: ReadonlyArray<[string, GeneratedType]> = [
  ...cosmosProtoRegistry,
  ...cosmwasmProtoRegistry,
  ...ibcProtoRegistry,
  ...osmosisProtoRegistry,
]

const aminoConverters = {
  ...cosmosAminoConverters,
  ...cosmwasmAminoConverters,
  ...ibcAminoConverters,
  ...osmosisAminoConverters,
}

export const registry = new Registry(protoRegistry)
export const aminoTypes = new AminoTypes(aminoConverters)

export const stargazeRPCUrl = 'https://rpc.cosmos.directory/stargaze'
export const rpcUrl = 'https://rpc.osmosis.zone/'

export const delayTime = 1200; // State update Delay time in millisecond
export const loopMax = 5;

////Specifics for Osmosis services//////
export const SWAP_SLIPPAGE = 0.5; //0.5% slippage

/// Mainnet addrs
export const mainnetAddrs = {
  launch: "osmo1g6hgj3eu9ju4vuaprjxdzj97ecnuczytve3junulgnwlamnndl5q6k73w6",

  discount_vault: "osmo1v8wckds5lvsdd0xrragvleu8srxprjpwdl7mga5uygnwmz5e7qzsl5zexw",
  governance: "osmo1wk0zlag50ufu5wrsfyelrylykfe3cw68fgv9s8xqj20qznhfm44qgdnq86", //old gov: osmo19h8huy2hz4q7detxzv2r2erlsvlq8hzlsquu6n5x83775va4qgkskf20kq //new gov: osmo1wk0zlag50ufu5wrsfyelrylykfe3cw68fgv9s8xqj20qznhfm44qgdnq86
  liq_queue: "osmo1ycmtfa7h0efexjxuaw7yh3h3qayy5lspt9q4n4e3stn06cdcgm8s50zmjl",
  liquidity_check: "osmo1xxx0yuqhmwekt44q00jrf3rwvfa70rpeu622q0x56yaf423vq93q3qpzux",
  mbrn_auction: "osmo1qwdlg9le9kdrvgyp35jxz53m8zhdssyvxvyevmdxcn852h6dq9gqknf2aa",
  oracle: "osmo16sgcpe0hcs42qk5vumk06jzmstkpka9gjda9tfdelwn65ksu3l7s7d4ggs", //old oracle: osmo160t4k7x8axfd335s0rj5jdffzag684tjrzchlwmqk23xte32alvq6nfz6k //new oracle: osmo16sgcpe0hcs42qk5vumk06jzmstkpka9gjda9tfdelwn65ksu3l7s7d4ggs
  osmosis_proxy: "osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd",
  positions: "osmo1gy5gpqqlth0jpm9ydxlmff6g5mpnfvrfxd3mfc8dhyt03waumtzqt8exxr",
  stability_pool: "osmo1326cxlzftxklgf92vdep2nvmqffrme0knh8dvugcn9w308ya9wpqv03vk8",
  staking: "osmo1fty83rfxqs86jm5fmlql5e340e8pe0v9j8ez0lcc6zwt2amegwvsfp3gxj",
  system_discounts: "osmo1p0hvtat69dash8f0w340n2kjdkdfq0ggyp77mr426wpnfwp3tjyqq6a8vr",
  vesting: "osmo1flwr85scpcsdqa8uyh0acgxeqlg2ln8tlklzwzdn4u68n3p5wegsgspjf6"
};

export const denoms = {
  MBRN: ["factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/umbrn", 6],
  CDT: ["factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt", 6],
  OSMO: ["uosmo", 6],
  //mainnet atom ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2
  ATOM: ["ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", 6],
  //mainnet axlUSDC ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858
  "USDC.axl": ["ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858", 6],
  //mainnet "gamm/pool/1"
  atomosmo_pool: ["gamm/pool/1", 18],
  //mainnet "gamm/pool/678"
  osmousdc_pool: ["gamm/pool/678", 18],
  //Noble USDC
  USDC: ["ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4", 6],
  //Stride Atom
  stATOM: ["ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901", 6],
  //Stride Osmo
  stOSMO: ["ibc/D176154B0C63D1F9C6DCFB4F70349EBF2E2B5A87A05902F57A6AE92B863E9AEC", 6],
  //TIA
  TIA: ["ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877", 6],
  //USDT
  USDT: ["ibc/4ABBEF4C8926DDDB320AE5188CFD63267ABBCEFC0583E4AE05D6E5AA2401DDAB", 6],
  //WBTC.axl
  WBTCaxl: ["ibc/D1542AA8762DB13087D8364F3EA6509FD6F009A34F00426AF9E4F9FA85CBBF1F", 8],
};

//all CDT pairs
export const cdtRoutes = {
  "OSMO": [
    {
      poolId: BigInt(1226),
      tokenOutDenom: denoms.CDT[0],
    },
  ],
  "ATOM": [
    {
      poolId: BigInt(1),
      tokenOutDenom: denoms.OSMO[0],
    },
  ],
  "USDC": [
    {
      poolId: BigInt(1268),
      tokenOutDenom: denoms.CDT[0],
    },
  ],
  "USDT": [
    {
      poolId: BigInt(1220),
      tokenOutDenom: denoms.USDC[0],
    }
  ],
  "TIA": [
    {
      poolId: BigInt(1247),
      tokenOutDenom: denoms.USDC[0],
    }
  ],
  "stTIA": [
    {
      poolId: BigInt(1428),
      tokenOutDenom: denoms.TIA[0],
    }
  ],
  "milkTIA": [
    {
      poolId: BigInt(1475),
      tokenOutDenom: denoms.TIA[0],
    }
  ],
  "stATOM": [
    {
      poolId: BigInt(1283), //1136
      tokenOutDenom: denoms.ATOM[0],
    }
  ],
  "stOSMO": [
    {
      poolId: BigInt(833),
      tokenOutDenom: denoms.OSMO[0],
    }
  ],
  "USDC.axl": [
    {//This is the transmuter pool
      poolId: BigInt(1212), //1223
      tokenOutDenom: denoms.USDC[0],
    }
  ],
  "WBTC.axl": [
    {
      poolId: BigInt(712), 
      tokenOutDenom: denoms.OSMO[0],
    }
  ],
  "ETH": [ //This is ETH.axl that Osmosis is using as canonical denom rn
    {
      poolId: BigInt(704),
      tokenOutDenom: denoms.OSMO[0],
    }
  ],
  "WBTC": [
    {
      poolId: BigInt(1422), 
      tokenOutDenom: denoms.WBTCaxl[0],
    }
  ],
  "MBRN": [
    {
      poolId: BigInt(1225),
      tokenOutDenom: denoms.OSMO[0],
    }
  ],
  "CDT": [],
} as swapRoutes;
