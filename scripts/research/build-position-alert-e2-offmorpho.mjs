/**
 * build-position-alert-e2-offmorpho.mjs — the spec's E2 (Stream xUSD collapse, Nov 2–12 2025)
 * off Morpho: Euler v2, Silo v2 and Gearbox v3.1 positions against xUSD, xBTC, xETH, deUSD,
 * sdeUSD (and PT-xUSD), read from chain every 2 hours from Oct 26 to Nov 16 2025.
 *
 *   node scripts/research/build-position-alert-e2-offmorpho.mjs
 *
 * Writes position-alerts/e2-offmorpho-nov-2025.json in the private datasets repo (board rule
 * N18; $MEMBRANE_DATASETS_DIR, default ../membrane-datasets), in the shape
 * scripts/research/position-alert-pinned-replay.ts reads for E2.
 *
 * Markets: found by scanning every EVK vault's LTVList() and the Silo v2 deployments and
 * Gearbox credit managers at the Nov 1 2025 block (discovery outputs and scripts kept in the
 * datasets repo under position-alerts/e2-offmorpho-discovery/). The Morpho Blue API does not
 * serve Plasma, Avalanche or Sonic. No Stream or Elixir market exists on Morpho there by Nov 12.
 *
 * Cohort: every account with debt and Stream collateral at the Nov 2 00:00 UTC block (the same
 * rule as E3 positions_start and E4 positions_t0). Accounts come from Borrow logs (Euler), debt
 * share mints (Silo) and creditAccounts() (Gearbox) up to that block.
 *
 * Per account and sample: collateral units of each Stream asset, their value at the venue's own
 * oracle, the debt valued at the venue's oracle, and the liquidation threshold. Keyless RPCs
 * only; this script never reads .env.local.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'

import { datasetPath } from '../lib/datasetsDir.mjs'
import { LOG_SPAN, RPC, SAMPLE_CONCURRENCY } from '../lib/archiveRpc.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = datasetPath(ROOT, 'position-alerts')
// Test switches: E2OFF_ONLY=eUSDT0-7,silo-129 limits markets, E2OFF_SAMPLES caps the sample count,
// E2OFF_FILE writes elsewhere (a smoke run must not overwrite the dataset). E2OFF_CACHE names a
// scratch directory that keeps each market's cohort, so a rerun skips the slow log scans.
const FILE = process.env.E2OFF_FILE ?? 'e2-offmorpho-nov-2025.json'
const CACHE = process.env.E2OFF_CACHE ?? null
const ONLY = process.env.E2OFF_ONLY ? new Set(process.env.E2OFF_ONLY.split(',')) : null
const MAX_SAMPLES = Number(process.env.E2OFF_SAMPLES ?? Infinity)
const H = 3600
const ts = (s) => Math.floor(Date.parse(s) / 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SPEC = { fromTs: ts('2025-11-02T00:00:00Z'), toTs: ts('2025-11-12T23:59:00Z') }
const HISTORY = { fromTs: ts('2025-10-26T00:00:00Z'), toTs: ts('2025-11-16T00:00:00Z') }
const STEP_S = 2 * H
const USD = '0x0000000000000000000000000000000000000348'
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

// ------------------------------------------------------------------ chains

// Endpoints, log spans and sample concurrency per chain: scripts/lib/archiveRpc.mjs.
/** First block with timestamp >= Oct 26, Nov 2 and Nov 16 2025 00:00 UTC. */
const ANCHORS = {
  1: [23_657_911, 23_707_920, 23_808_024],
  42161: [393_411_708, 395_834_395, 400_677_953],
  43114: [70_904_347, 71_270_131, 72_027_579],
  146: [51_878_126, 53_075_396, 55_393_677],
  9745: [4_507_394, 5_112_189, 6_320_697],
}
const ANCHOR_TS = [HISTORY.fromTs, SPEC.fromTs, HISTORY.toTs]

// ------------------------------------------------------------------ markets

const STREAM_ASSETS = {
  // symbol by lower-cased token address, per chain
  1: {
    '0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94': 'xUSD',
    '0xba1edf4a4c7eb8cb0dae0594326179f9c7d909d2': 'PT-xUSD-18DEC2025',
    '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153': 'xETH',
    '0x12fd502e2052cafb41eccc5b596023d9978057d6': 'xBTC',
  },
  42161: { '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c': 'xUSD' },
  43114: {
    '0x94f9bb5c972285728dcee7eaece48bec2ff341ce': 'xUSD',
    '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c': 'xBTC',
    '0xb57b25851fe2311cc3fe511c8f10e868932e0680': 'deUSD',
    '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96': 'sdeUSD',
  },
  146: {
    '0x6202b9f02e30e5e1c62cc01e4305450e5d83b926': 'xUSD',
    '0x16af6b1315471dc306d47e9ccefed6e5996285b6': 'xETH',
    '0xb88ff15ae5f82c791e637b27337909bcf8065270': 'xBTC',
  },
  9745: {
    '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c': 'xUSD',
    '0x7884a8457f0e63e82c89a87fe48e8ba8223db069': 'sdeUSD',
    '0x4ac60586c3e245ff5593cf99241395bf42509274': 'deUSD',
  },
}

/**
 * Euler v2 borrow vaults that took Stream or Elixir collateral with a live liquidation LTV at
 * the Nov 1 block (LTVList scan). collaterals: [collateral vault, its asset, liquidation LTV].
 */
const EULER = [
  // Ethereum, TelosC
  {
    chainId: 1,
    vault: '0x01864ae3c7d5f507cc4c24ca67b4cabbdda37ecd',
    sym: 'eUSDC-64',
    loan: 'USDC',
    curator: 'TelosC',
    colls: [
      [
        '0xf1ba8c5ca5ab011d06f31e64dad313d204acb9eb',
        '0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94',
        0.95,
      ],
      [
        '0x0f080bf8ba818001ecfb2f461708d8484323d0ce',
        '0xba1edf4a4c7eb8cb0dae0594326179f9c7d909d2',
        0.94,
      ],
    ],
  },
  {
    chainId: 1,
    vault: '0x211711f277f146fc947d7053b41bb71bb5b5fc2c',
    sym: 'eWETH-33',
    loan: 'WETH',
    curator: 'TelosC',
    colls: [
      [
        '0x9b62c8d69acb1397f585ba63eee2597c5bd0f644',
        '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153',
        0.94,
      ],
    ],
  },
  {
    chainId: 1,
    vault: '0x038dd0eb275b7de3b07884f1fa106ed6423c45f2',
    sym: 'eWBTC-9',
    loan: 'WBTC',
    curator: 'TelosC',
    colls: [
      [
        '0xbbc4bc013f1c9ed674098a6d156c02c0a21a285c',
        '0x12fd502e2052cafb41eccc5b596023d9978057d6',
        0.94,
      ],
    ],
  },
  // Sonic, MEV Capital
  {
    chainId: 146,
    vault: '0x196f3c7443e940911ee2bb88e019fd71400349d9',
    sym: 'eUSDC.e-3',
    loan: 'USDC.e',
    curator: 'MEV Capital',
    colls: [
      [
        '0xdebdab749330bb976fd10dc52f9a452aaf029028',
        '0x6202b9f02e30e5e1c62cc01e4305450e5d83b926',
        0.915,
      ],
      [
        '0x2a377470dcf0e00f6ded484ddf82df65f0fb50af',
        '0xb88ff15ae5f82c791e637b27337909bcf8065270',
        0.78,
      ],
    ],
  },
  {
    chainId: 146,
    vault: '0xb38d431e932fea77d1df0ae0dfe4400c97e597b8',
    sym: 'escUSD-2',
    loan: 'scUSD',
    curator: 'MEV Capital',
    colls: [
      [
        '0xdebdab749330bb976fd10dc52f9a452aaf029028',
        '0x6202b9f02e30e5e1c62cc01e4305450e5d83b926',
        0.915,
      ],
      [
        '0x2a377470dcf0e00f6ded484ddf82df65f0fb50af',
        '0xb88ff15ae5f82c791e637b27337909bcf8065270',
        0.78,
      ],
    ],
  },
  {
    chainId: 146,
    vault: '0xa5cd24d9792f4f131f5976af935a505d19c8db2b',
    sym: 'eWETH-1',
    loan: 'WETH',
    curator: 'MEV Capital',
    colls: [
      [
        '0xb6a53021e7a40ea20df1e1991b0c89432073386e',
        '0x16af6b1315471dc306d47e9ccefed6e5996285b6',
        0.915,
      ],
    ],
  },
  {
    chainId: 146,
    vault: '0x0806af1762bdd85b167825ab1a64e31cf9497038',
    sym: 'escETH-2',
    loan: 'scETH',
    curator: 'MEV Capital',
    colls: [
      [
        '0xb6a53021e7a40ea20df1e1991b0c89432073386e',
        '0x16af6b1315471dc306d47e9ccefed6e5996285b6',
        0.915,
      ],
    ],
  },
  // Avalanche: Re7, K3 Capital, Keyring
  {
    chainId: 43114,
    vault: '0x39de0f00189306062d79edec6dca5bb6bfd108f9',
    sym: 'eUSDC-2',
    loan: 'USDC',
    curator: 'Re7',
    colls: [
      [
        '0xa45189636c04388adbb4d865100dd155e55682ec',
        '0xb57b25851fe2311cc3fe511c8f10e868932e0680',
        0.925,
      ],
      [
        '0xfecebf56f150a68ddd197c3a6101da35c46693ac',
        '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96',
        0.925,
      ],
    ],
  },
  {
    chainId: 43114,
    vault: '0x2137568666f12fc5a026f5430ae7194f1c1362ab',
    sym: 'eAUSD-2',
    loan: 'AUSD',
    curator: 'Re7',
    colls: [
      [
        '0xa45189636c04388adbb4d865100dd155e55682ec',
        '0xb57b25851fe2311cc3fe511c8f10e868932e0680',
        0.925,
      ],
      [
        '0xfecebf56f150a68ddd197c3a6101da35c46693ac',
        '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96',
        0.925,
      ],
    ],
  },
  {
    chainId: 43114,
    vault: '0xa45189636c04388adbb4d865100dd155e55682ec',
    sym: 'edeUSD-1',
    loan: 'deUSD',
    curator: 'Re7',
    colls: [
      [
        '0xfecebf56f150a68ddd197c3a6101da35c46693ac',
        '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96',
        0.925,
      ],
    ],
  },
  {
    chainId: 43114,
    vault: '0xa446938b0204aa4055cdfed68ddf0e0d1bab3e9e',
    sym: 'eUSDt-3',
    loan: 'USDt',
    curator: 'K3 Capital',
    colls: [
      [
        '0xe1e549c965a4a0514d9bf80161d32924b8694822',
        '0xb57b25851fe2311cc3fe511c8f10e868932e0680',
        0.925,
      ],
      [
        '0xb9cc370a8f19322fc4bf69da80c6c39ff8f2db90',
        '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96',
        0.875,
      ],
    ],
  },
  {
    chainId: 43114,
    vault: '0x6fc9b3a52944a577cd8971fd8fde0819001bc595',
    sym: 'eUSDC-5',
    loan: 'USDC',
    curator: 'K3 Capital',
    colls: [
      [
        '0xe1e549c965a4a0514d9bf80161d32924b8694822',
        '0xb57b25851fe2311cc3fe511c8f10e868932e0680',
        0.925,
      ],
      [
        '0xb9cc370a8f19322fc4bf69da80c6c39ff8f2db90',
        '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96',
        0.875,
      ],
    ],
  },
  {
    chainId: 43114,
    vault: '0xe1e549c965a4a0514d9bf80161d32924b8694822',
    sym: 'edeUSD-3',
    loan: 'deUSD',
    curator: 'K3 Capital',
    colls: [
      [
        '0xb9cc370a8f19322fc4bf69da80c6c39ff8f2db90',
        '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96',
        0.95,
      ],
    ],
  },
  {
    chainId: 43114,
    vault: '0x8f23da78e3f31ab5deb75dc3282198bed630ffde',
    sym: 'eUSDC-15',
    loan: 'USDC',
    curator: 'Keyring',
    colls: [
      [
        '0x6de07d6cbd0c4e8fa93da3d7bdaa1d1505651a1e',
        '0x68088c91446c7bea49ea7dbd3b96ce62b272dc96',
        0.96,
      ],
    ],
  },
  // Plasma: TelosC, Re7, Frontier Elixir
  {
    chainId: 9745,
    vault: '0x57c582346b7d49a46af3745a8278917d1c1311b8',
    sym: 'eUSDT0-7',
    loan: 'USDT0',
    curator: 'TelosC',
    colls: [
      [
        '0x138c289bb8b855cf271305c8bcf91dc31ba30194',
        '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c',
        0.95,
      ],
    ],
  },
  {
    chainId: 9745,
    vault: '0xf90cf999de728a582e154f926876b70e93a747b7',
    sym: 'emsUSD-3',
    loan: 'msUSD',
    curator: 'TelosC',
    colls: [
      [
        '0x138c289bb8b855cf271305c8bcf91dc31ba30194',
        '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c',
        0.94,
      ],
    ],
  },
  {
    chainId: 9745,
    vault: '0x27934d4879fc28a74703726edae15f757e45a48a',
    sym: 'eplUSD-2',
    loan: 'plUSD',
    curator: 'TelosC',
    colls: [
      [
        '0x138c289bb8b855cf271305c8bcf91dc31ba30194',
        '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c',
        0.94,
      ],
    ],
  },
  {
    chainId: 9745,
    vault: '0xf675fbe777e992f5d5d84adf41161dc0f20104a6',
    sym: 'eUSDT0-23',
    loan: 'USDT0',
    curator: 'Re7',
    colls: [
      [
        '0x8adb906421f65c27155f44f1829ca1e5b024c3f6',
        '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c',
        0.95,
      ],
    ],
  },
  {
    chainId: 9745,
    vault: '0x3799251bd81925cfccf2992f10af27a4e62bf3f7',
    sym: 'eUSDT0-22',
    loan: 'USDT0',
    curator: 'Frontier Elixir',
    colls: [
      [
        '0x5efb3b2899a76e013040e85438cbe308870f5f50',
        '0x7884a8457f0e63e82c89a87fe48e8ba8223db069',
        0.91,
      ],
      [
        '0xd59f6112375d60e45c2ba9dd5745870c1444362f',
        '0x4ac60586c3e245ff5593cf99241395bf42509274',
        0.91,
      ],
    ],
  },
]

/** Silo v2 markets with debt at Nov 1 (silo0 = the Stream collateral, silo1 = the borrowable). */
const SILO = [
  {
    chainId: 43114,
    id: 129,
    config: '0x6b13d486027c1b645ad663ba9f9a28744d04b8f8',
    silo0: '0xc380e5250d9718f8d9116bc9d787a0229044e2eb',
    token0: '0x94f9bb5c972285728dcee7eaece48bec2ff341ce',
    silo1: '0x672b77f0538b53dc117c9ddfeb7377a678d321a6',
    token1: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    loan: 'USDC',
    oracle0: '0xef8771ac2b3bb12fe9f1493fd7e1b2b95b964659',
    oracle1: '0xb70b6ca1654f365ef6687b82419e2322ac5a1a9f',
    lt0: 0.92,
    prot0: '0x1efeca1115ba2e0a37dad06cae569e1295e579cd',
    debt1: '0x91ed9057c9ccd12fce28022b42c37bd0ab83ae95',
    curator: 'MEV Capital',
  },
  {
    chainId: 43114,
    id: 130,
    config: '0x9a214a80971823f85cb4c7f95728215f4ce74693',
    silo0: '0x5c1bbffa5ca220b8042c12ff8e4695bcfad93278',
    token0: '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c',
    silo1: '0x7437ac81457fa98ffb2d0c8f9943ecfe4813e2f1',
    token1: '0x152b9d0fdc40c096757f570a51e494bd4b943e50',
    loan: 'BTC.b',
    oracle0: '0x7ac9186e49ba691904bb16bff542d10a646a5b41',
    oracle1: '0x3157eff831f2657a82da721e377b08d32fff02b6',
    lt0: 0.92,
    prot0: '0x9cc1437f6756fe29552fd7c3c99a7e2d87a18a06',
    debt1: '0xe20469b4ce5784bf59040024541088a8f45f5743',
    curator: 'MEV Capital',
  },
  {
    chainId: 43114,
    id: 134,
    config: '0x76a2c55b5aa5037a374d509651b51ba134a3e186',
    silo0: '0x493bbdb14d22177e5b2d5f61eb49dc50eba0300d',
    token0: '0x94f9bb5c972285728dcee7eaece48bec2ff341ce',
    silo1: '0x9c4d4800b489d217724155399cd64d07eae603f3',
    token1: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
    loan: 'AUSD',
    oracle0: '0x8604e89cc02f8c37a428e2c78218f9c95898cbfe',
    oracle1: '0xf255dc4752159267bd7763a259a3b7fc58b498dc',
    lt0: 0.92,
    prot0: '0x7509170ad6a0766df57c5b86232506f6488614d7',
    debt1: '0x56cd2f5ac441de6ef2fa5007798efa609582b64d',
    curator: 'Varlamore',
  },
  {
    chainId: 43114,
    id: 136,
    config: '0x1496796ab5a3ce7192b7cc2f852cbaf2927045ce',
    silo0: '0xfc7ed01586341bd27c636d201705995f215ebd61',
    token0: '0x94f9bb5c972285728dcee7eaece48bec2ff341ce',
    silo1: '0xe0fc62e685e2b3183b4b88b1fe674cfec55a63f7',
    token1: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
    loan: 'USDt',
    oracle0: '0x512935aaf49f89d000aab0d8102c334876942d2c',
    oracle1: '0x83338418c786cf7d43bc16ba5a32d2c20eb3659e',
    lt0: 0.92,
    prot0: '0xd9cde9d168828daed0e4275dba593b297a5461fd',
    debt1: '0x3957facf97e8a6c4ada671ce4539555daae2e88f',
    curator: 'Varlamore',
  },
  {
    chainId: 146,
    id: 112,
    config: '0x60109eab799ec246978a2ce89aa584e9190b71c8',
    silo0: '0x172a687c397e315dbe56ed78ab347d7743d0d4fa',
    token0: '0x6202b9f02e30e5e1c62cc01e4305450e5d83b926',
    silo1: '0xa1627a0e1d0ebca9326d2219b84df0c600bed4b1',
    token1: '0x29219dd400f2bf60e5a23d13be72b486d4038894',
    loan: 'USDC.e',
    oracle0: '0x7a9efa7cfe9a51922005056dc33ac1a13a16953c',
    oracle1: '0x3fdbef5621077e3ca3f49e62293d67399f25ab2b',
    lt0: 0.92,
    prot0: '0x3193cc3ca31da845be9cfc1ffee46354fc3a4193',
    debt1: '0xd45b6edb5408600e7d22d23ce7f19f0aaf5b5aa3',
    curator: 'Varlamore',
  },
  {
    chainId: 146,
    id: 118,
    config: '0x0f9341f6e8b9017bcb9c4c74187f3aa32fb1cb7d',
    silo0: '0x596aef68a03a0e35c4d8e624fbbdb0df0862f172',
    token0: '0x6202b9f02e30e5e1c62cc01e4305450e5d83b926',
    silo1: '0xb1412442aa998950f2f652667d5eba35fe66e43f',
    token1: '0xd3dce716f3ef535c5ff8d041c1a41c3bd89b97ae',
    loan: 'scUSD',
    oracle0: '0x7a9efa7cfe9a51922005056dc33ac1a13a16953c',
    oracle1: '0x0c533855533e8d50868fde5d206cbff62702b6b1',
    lt0: 0.92,
    prot0: '0x21188b2ffa432bbf0983aab6d3be044cbcd6af72',
    debt1: '0xb2997bf6eaaa30311ab375294923895cb40cdbfb',
    curator: 'Mithras',
  },
  {
    chainId: 42161,
    id: 146,
    config: '0x4ce914b0a176bb243f0fcf3799d687474d8c6d21',
    silo0: '0xf0543d476e7906374863091034fe679a7be8ee20',
    token0: '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c',
    silo1: '0xacb7432a4bb15402ce2afe0a7c9d5b738604f6f9',
    token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    loan: 'USDC',
    oracle0: '0x90c25a2a0c587e943ad758e59ba1a9b1f9c2077e',
    oracle1: '0x916718f118552bbb84ddad5bbf3aeea75e835cc5',
    lt0: 0.92,
    prot0: '0x45e51a0bc903226b15e9c22729f7db7765b62855',
    debt1: '0x021041806d8dddae93873073a7fafdf8faf02929',
    curator: 'Varlamore',
  },
  {
    chainId: 1,
    id: 155,
    config: '0xb0b37f551e18c540cf7748589d24589945fc1f61',
    silo0: '0x2e3a8f2dd842910ff8a3c65d93b129806e500417',
    token0: '0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94',
    silo1: '0x1de3ba67da79a81bc0c3922689c98550e4bd9bc2',
    token1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    loan: 'USDC',
    oracle0: '0xe38eabeab0d194057fde3de1c63661e8fab053b3',
    oracle1: '0x349f637c7f1106f3f200a8b976b4c670dfd1ba0b',
    lt0: 0.92,
    prot0: '0x8bb83c1e1c6d68dcb3ba8596fde45533efe6f31d',
    debt1: '0xe5314cc2a2fa0b1c58cb597f0b5930343f3ac768',
    curator: 'Varlamore',
  },
]

/** Gearbox v3.1 on Plasma: the only credit manager that ever added xUSD (log scan). */
const GEARBOX = [
  {
    chainId: 9745,
    cm: '0x4ba181f9e38bdf5c17777ddddddbe83b7de65f80',
    name: 'xUSD Strategy',
    loan: 'USDT0',
    lt: 0.9,
    xusd: '0x6eaf19b2fc24552925db245f9ff613157a7dbb4c',
    curator: 'Invariant Group',
  },
]

/** Market price keys (CoinGecko trades via DefiLlama). xBTC and xETH have none. */
const MARKET_KEYS = {
  xUSD: 'coingecko:staked-stream-usd',
  deUSD: 'coingecko:elixir-deusd',
  sdeUSD: 'coingecko:elixir-staked-deusd',
}

// ------------------------------------------------------------------ RPC

const ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
  'function getCurrentBlockTimestamp() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function debtOf(address) view returns (uint256)',
  'function oracle() view returns (address)',
  'function asset() view returns (address)',
  'function accountLiquidity(address account, bool liquidation) view returns (uint256 collateralValue, uint256 liabilityValue)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function convertToAssets(uint256 shares, uint8 assetType) view returns (uint256)',
  'function getQuote(uint256 inAmount, address base, address quote) view returns (uint256)',
  'function maxRepay(address borrower) view returns (uint256)',
  'function quote(uint256 baseAmount, address baseToken) view returns (uint256)',
  'function creditAccounts() view returns (address[])',
  'function creditFacade() view returns (address)',
  'function getConfig(address silo) view returns ((uint256 daoFee, uint256 deployerFee, address silo, address token, address protectedShareToken, address collateralShareToken, address debtShareToken, address solvencyOracle, address maxLtvOracle, address interestRateModel, uint256 maxLtv, uint256 lt, uint256 liquidationTargetLtv, uint256 liquidationFee, uint256 flashloanFee, address hookReceiver, bool callBeforeQuote))',
  'function calcDebtAndCollateral(address creditAccount, uint8 task) view returns ((uint256 debt, uint256 cumulativeIndexNow, uint256 cumulativeIndexLastUpdate, uint128 cumulativeQuotaInterest, uint256 accruedInterest, uint256 accruedFees, uint256 totalDebtUSD, uint256 totalValue, uint256 totalValueUSD, uint256 twvUSD, uint256 enabledTokensMask, uint256 quotedTokensMask, address[] quotedTokens, address _poolQuotaKeeper))',
])
const T_BORROW = keccak256(toHex('Borrow(address,uint256)'))
const T_LIQUIDATE = keccak256(toHex('Liquidate(address,address,address,uint256,uint256)'))
const T_TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'))
// Silo v2 liquidation hook: LiquidationCall(liquidator, silo, borrower, repay, withdraw, sToken).
const T_SILO_LIQ = keccak256(toHex('LiquidationCall(address,address,address,uint256,uint256,bool)'))
// Gearbox v3.1 credit facade: partial liquidation (credit account, token, liquidator, …) and full.
const T_GB_PARTIAL = keccak256(
  toHex('PartiallyLiquidateCreditAccount(address,address,address,uint256,uint256,uint256)'),
)
const T_GB_LIQ = keccak256(toHex('LiquidateCreditAccount(address,address,address,uint256)'))
const ZERO_TOPIC = '0x' + '0'.repeat(64)

const cursor = {}
async function rpc(chainId, method, params, tries = 10) {
  const urls = RPC[chainId]
  let last
  for (let i = 0; i < tries; i++) {
    const url = urls[((cursor[chainId] ?? 0) + i) % urls.length]
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(90_000),
      })
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200))
      return j.result
    } catch (e) {
      last = e
      if (process.env.E2OFF_DEBUG) console.error(`rpc ${chainId} ${method} try ${i}: ${e.message}`)
      cursor[chainId] = ((cursor[chainId] ?? 0) + 1) % urls.length
      await sleep(800 * (i + 1))
    }
  }
  throw new Error(`${chainId} ${method}: ${last?.message}`)
}

/** Many view calls at one block through Multicall3. Each result is { ok, value }. */
async function multicall(chainId, block, calls) {
  const out = []
  for (let i = 0; i < calls.length; i += 100) {
    const part = calls.slice(i, i + 100)
    const data = encodeFunctionData({
      abi: ABI,
      functionName: 'aggregate3',
      args: [
        part.map((c) => ({
          target: c.to,
          allowFailure: true,
          callData: encodeFunctionData({ abi: ABI, functionName: c.fn, args: c.args ?? [] }),
        })),
      ],
    })
    const raw = await rpc(chainId, 'eth_call', [{ to: MULTICALL3, data }, toHex(block)])
    const res = decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: raw })
    res.forEach((r, j) => {
      if (!r.success || r.returnData === '0x') return out.push({ ok: false, value: null })
      try {
        const v = decodeFunctionResult({
          abi: ABI,
          functionName: part[j].fn,
          args: part[j].args,
          data: r.returnData,
        })
        out.push({ ok: true, value: v })
      } catch {
        out.push({ ok: false, value: null })
      }
    })
  }
  return out
}

async function logs(chainId, address, topics, fromBlock, toBlock) {
  const found = []
  const span = LOG_SPAN[chainId]
  for (let b = fromBlock; b <= toBlock; b += span) {
    const e = Math.min(toBlock, b + span - 1)
    found.push(
      ...(await rpc(chainId, 'eth_getLogs', [
        { address, topics, fromBlock: toHex(b), toBlock: toHex(e) },
      ])),
    )
    if (chainId === 9745 || chainId === 1) await sleep(120)
  }
  return found
}

/** First block where the contract has code (binary search on eth_getCode). */
async function creationBlock(chainId, address, hi) {
  let lo = 0
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const code = await rpc(chainId, 'eth_getCode', [address, toHex(mid)])
    if (code && code !== '0x') hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Block near a timestamp: linear between the anchors (the read block's own timestamp is kept). */
function blockAt(chainId, t) {
  const a = ANCHORS[chainId]
  const k = t < ANCHOR_TS[1] ? 0 : 1
  const f = (t - ANCHOR_TS[k]) / (ANCHOR_TS[k + 1] - ANCHOR_TS[k])
  return Math.round(a[k] + f * (a[k + 1] - a[k]))
}

const addr = (topic) => '0x' + topic.slice(26).toLowerCase()
const num = (v) => Number(v)

// ------------------------------------------------------------------ prices

async function llama(key) {
  const out = []
  for (let t = HISTORY.fromTs; t < HISTORY.toTs; t += 450 * H) {
    const span = Math.min(450, Math.ceil((HISTORY.toTs - t) / H))
    const r = await fetch(`https://coins.llama.fi/chart/${key}?start=${t}&span=${span}&period=1h`)
    const j = await r.json()
    for (const p of j?.coins?.[key]?.prices ?? []) out.push([p.timestamp, p.price])
    await sleep(200)
  }
  out.sort((a, b) => a[0] - b[0])
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0])
}

async function binanceBtcHourly() {
  const out = []
  for (let t = HISTORY.fromTs; t < HISTORY.toTs; t += 1000 * H) {
    const r = await fetch(
      `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${t * 1000}&endTime=${Math.min(HISTORY.toTs, t + 1000 * H) * 1000 - 1}&limit=1000`,
    )
    for (const k of await r.json()) out.push([Math.floor(k[0] / 1000), Number(k[4])])
  }
  return out
}

function priceAt(series, t) {
  if (!series?.length || t < series[0][0]) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (series[mid][0] <= t) lo = mid
    else hi = mid - 1
  }
  return t - series[lo][0] <= 3 * H ? series[lo][1] : null
}

// ------------------------------------------------------------------ cohort

async function decimalsOf(chainId, tokens, block) {
  const r = await multicall(
    chainId,
    block,
    tokens.map((t) => ({ to: t, fn: 'decimals' })),
  )
  return Object.fromEntries(tokens.map((t, i) => [t, r[i].ok ? num(r[i].value) : 18]))
}

/** A cohort from the cache directory when present, else computed and saved there. */
async function cachedCohort(key, compute) {
  if (!CACHE) return compute()
  const file = join(CACHE, `cohort-${key}.json`)
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    const c = await compute()
    await mkdir(CACHE, { recursive: true })
    await writeFile(file, JSON.stringify(c))
    return c
  }
}

async function eulerCohort(m) {
  const start = blockAt(m.chainId, SPEC.fromTs)
  const born = await creationBlock(m.chainId, m.vault, start)
  const borrowLogs = await logs(m.chainId, m.vault, [T_BORROW], born, start)
  const accounts = [...new Set(borrowLogs.map((l) => addr(l.topics[1])))]
  const r = await multicall(
    m.chainId,
    start,
    accounts.map((a) => ({ to: m.vault, fn: 'debtOf', args: [a] })),
  )
  const withDebt = accounts.filter((_, i) => r[i].ok && r[i].value > 0n)
  // keep only accounts that hold a Stream collateral vault
  const calls = withDebt.flatMap((a) =>
    m.colls.map(([v]) => ({ to: v, fn: 'balanceOf', args: [a] })),
  )
  const b = await multicall(m.chainId, start, calls)
  const kept = withDebt.filter((_, i) =>
    m.colls.some((__, j) => b[i * m.colls.length + j].ok && b[i * m.colls.length + j].value > 0n),
  )
  return { born, borrowers: accounts.length, withDebt: withDebt.length, accounts: kept }
}

async function siloCohort(s) {
  const start = blockAt(s.chainId, SPEC.fromTs)
  const born = await creationBlock(s.chainId, s.debt1, start)
  const mints = await logs(s.chainId, s.debt1, [T_TRANSFER, ZERO_TOPIC], born, start)
  const accounts = [...new Set(mints.map((l) => addr(l.topics[2])))]
  const r = await multicall(
    s.chainId,
    start,
    accounts.map((a) => ({ to: s.silo1, fn: 'maxRepay', args: [a] })),
  )
  const withDebt = accounts.filter((_, i) => r[i].ok && r[i].value > 0n)
  return { born, borrowers: accounts.length, withDebt: withDebt.length, accounts: withDebt }
}

async function gearboxCohort(g) {
  const start = blockAt(g.chainId, SPEC.fromTs)
  const [r] = await multicall(g.chainId, start, [{ to: g.cm, fn: 'creditAccounts' }])
  return {
    borrowers: r.value?.length ?? 0,
    withDebt: r.value?.length ?? 0,
    accounts: (r.value ?? []).map((a) => a.toLowerCase()),
  }
}

// ------------------------------------------------------------------ samples

function sampleTimes() {
  const out = []
  for (let t = HISTORY.fromTs; t <= HISTORY.toTs && out.length < MAX_SAMPLES; t += STEP_S)
    out.push(t)
  return out
}
const wanted = (name) => !ONLY || ONLY.has(name)

/**
 * A market reader: up to three dependent passes of view calls at one block, then a record step.
 * Every market on a chain shares each pass's Multicall3 batch.
 */

/** Euler: debt, oracle-valued collateral and liability, per account and sample. */
function eulerReader(m, accounts, dec, oracleOf) {
  const hist = Object.fromEntries(accounts.map((a) => [a, []]))
  const per = 2 + m.colls.length
  return {
    hist,
    pass1: () => [
      ...accounts.flatMap((a) => [
        { to: m.vault, fn: 'debtOf', args: [a] },
        { to: m.vault, fn: 'accountLiquidity', args: [a, true] },
        ...m.colls.map(([v]) => ({ to: v, fn: 'balanceOf', args: [a] })),
      ]),
      // unit price of each Stream asset at the vault's oracle, for PT and mixed collateral
      ...m.colls.map(([, asset]) => ({
        to: oracleOf,
        fn: 'getQuote',
        args: [10n ** BigInt(dec[asset]), asset, USD],
      })),
    ],
    pass2: (r1) =>
      accounts.flatMap((a, i) =>
        m.colls.flatMap(([v], j) => {
          const sh = r1[i * per + 2 + j]
          const shares = sh.ok ? sh.value : 0n
          return [
            { to: v, fn: 'convertToAssets', args: [shares] },
            { to: oracleOf, fn: 'getQuote', args: [shares, v, USD] },
          ]
        }),
      ),
    pass3: () => [],
    record: (blockTs, block, r1, r2) => {
      const unitBase = accounts.length * per
      const unitUsd = m.colls.map((_, j) =>
        r1[unitBase + j].ok ? num(r1[unitBase + j].value) / 1e18 : null,
      )
      accounts.forEach((a, i) => {
        const debt = r1[i * per]
        const liq = r1[i * per + 1]
        if (!debt.ok || debt.value === 0n) return hist[a].push({ ts: blockTs, block, closed: true })
        const parts = m.colls
          .map(([, asset, lt], j) => {
            const k = (i * m.colls.length + j) * 2
            return {
              sym: STREAM_ASSETS[m.chainId][asset],
              units: r2[k].ok ? num(r2[k].value) / 10 ** dec[asset] : 0,
              oracleUsd: r2[k + 1].ok ? num(r2[k + 1].value) / 1e18 : 0,
              unitOracleUsd: unitUsd[j],
              lt,
            }
          })
          .filter((p) => p.units > 0)
        hist[a].push({
          ts: blockTs,
          block,
          parts,
          collateralValue: parts.reduce((x, p) => x + p.oracleUsd, 0),
          borrow: liq.ok ? num(liq.value[1]) / 1e18 : null,
          // Euler's own risk-adjusted collateral: includes any non-Stream collateral held
          adjustedCollateralUsd: liq.ok ? num(liq.value[0]) / 1e18 : null,
          debtUnits: num(debt.value) / 10 ** dec[m.loanToken],
        })
      })
    },
  }
}

/** Silo: debt (maxRepay), protected + collateral shares in the Stream silo, oracle quotes. */
function siloReader(s, accounts, dec, btc) {
  const hist = Object.fromEntries(accounts.map((a) => [a, []]))
  const assetsOf = (r2, i) =>
    (r2[i * 2].ok ? r2[i * 2].value : 0n) + (r2[i * 2 + 1].ok ? r2[i * 2 + 1].value : 0n)
  const debtOf = (r1, i) => (r1[i * 3].ok ? r1[i * 3].value : 0n)
  return {
    hist,
    pass1: () =>
      accounts.flatMap((a) => [
        { to: s.silo1, fn: 'maxRepay', args: [a] },
        { to: s.prot0, fn: 'balanceOf', args: [a] },
        // the collateral share token of a Silo v2 silo is the silo itself
        { to: s.silo0, fn: 'balanceOf', args: [a] },
      ]),
    pass2: (r1) =>
      accounts.flatMap((a, i) => [
        {
          to: s.silo0,
          fn: 'convertToAssets',
          args: [r1[i * 3 + 1].ok ? r1[i * 3 + 1].value : 0n, 0],
        },
        {
          to: s.silo0,
          fn: 'convertToAssets',
          args: [r1[i * 3 + 2].ok ? r1[i * 3 + 2].value : 0n, 1],
        },
      ]),
    pass3: (r1, r2) =>
      accounts.flatMap((a, i) => {
        const assets = assetsOf(r2, i)
        const debt = debtOf(r1, i)
        return [
          { to: s.oracle0, fn: 'quote', args: [assets > 0n ? assets : 1n, s.token0] },
          { to: s.oracle1, fn: 'quote', args: [debt > 0n ? debt : 1n, s.token1] },
        ]
      }),
    record: (blockTs, block, r1, r2, r3) => {
      accounts.forEach((a, i) => {
        const debt = debtOf(r1, i)
        if (debt === 0n) return hist[a].push({ ts: blockTs, block, closed: true })
        const cq = r3[i * 2].ok ? num(r3[i * 2].value) : null
        const dq = r3[i * 2 + 1].ok ? num(r3[i * 2 + 1].value) : null
        const debtUnits = num(debt) / 10 ** dec[s.token1]
        // Debt in USD: stables at $1, BTC.b at Binance BTCUSDT. Collateral at the silo's own
        // oracle ratio, so the health factor is exactly the silo's.
        const debtUsd = s.loan === 'BTC.b' ? debtUnits * (priceAt(btc, blockTs) ?? NaN) : debtUnits
        const value = cq !== null && dq ? (debtUsd * cq) / dq : null
        hist[a].push({
          ts: blockTs,
          block,
          parts: [
            {
              sym: STREAM_ASSETS[s.chainId][s.token0],
              units: num(assetsOf(r2, i)) / 10 ** dec[s.token0],
              oracleUsd: value,
              lt: s.lt0,
            },
          ],
          collateralValue: value,
          borrow: debtUsd,
          debtUnits,
        })
      })
    },
  }
}

/** Gearbox: Gearbox's own USD debt, total value and weighted value, plus the xUSD balance. */
function gearboxReader(g, accounts, dec) {
  const hist = Object.fromEntries(accounts.map((a) => [a, []]))
  return {
    hist,
    pass1: () =>
      accounts.flatMap((a) => [
        { to: g.cm, fn: 'calcDebtAndCollateral', args: [a, 3] },
        { to: g.xusd, fn: 'balanceOf', args: [a] },
      ]),
    pass2: () => [],
    pass3: () => [],
    record: (blockTs, block, r1) => {
      accounts.forEach((a, i) => {
        const cd = r1[i * 2]
        const bal = r1[i * 2 + 1]
        if (!cd.ok || cd.value.totalDebtUSD === 0n)
          return hist[a].push({ ts: blockTs, block, closed: true })
        const v = cd.value
        hist[a].push({
          ts: blockTs,
          block,
          parts: [
            {
              sym: 'xUSD',
              units: bal.ok ? num(bal.value) / 10 ** dec[g.xusd] : 0,
              oracleUsd: num(v.totalValueUSD) / 1e8,
              lt: g.lt,
            },
          ],
          collateralValue: num(v.totalValueUSD) / 1e8,
          borrow: num(v.totalDebtUSD) / 1e8,
          adjustedCollateralUsd: num(v.twvUSD) / 1e8,
        })
      })
    },
  }
}

/** Run every reader of one chain over the sample times, sharing each pass's batch. */
async function sampleChain(chainId, readers) {
  // Reads run in a pool; records are applied in time order afterwards.
  const times = sampleTimes()
  const reads = new Array(times.length)
  let next = 0
  const worker = async () => {
    while (next < times.length) {
      const i = next++
      reads[i] = await readSample(chainId, readers, times[i])
    }
  }
  await Promise.all(Array.from({ length: SAMPLE_CONCURRENCY[chainId] ?? 1 }, worker))
  for (const [blockTs, block, r1, r2, r3] of reads)
    readers.forEach((r, i) => r.record(blockTs, block, r1[i], r2[i], r3[i]))
}

async function readSample(chainId, readers, t) {
  {
    const block = blockAt(chainId, t)
    const run = async (lists) => {
      const flat = lists.flat()
      const res = flat.length ? await multicall(chainId, block, flat) : []
      let k = 0
      return lists.map((l) => res.slice(k, (k += l.length)))
    }
    const head = [{ to: MULTICALL3, fn: 'getCurrentBlockTimestamp' }]
    const [h, ...r1] = await run([head, ...readers.map((r) => r.pass1())])
    const blockTs = num(h[0].value)
    const r2 = await run(readers.map((r, i) => r.pass2(r1[i])))
    const r3 = await run(readers.map((r, i) => r.pass3(r1[i], r2[i])))
    return [blockTs, block, r1, r2, r3]
  }
}

// ------------------------------------------------------------------ assemble

/** One point in the replay's shape: collateral in units of the main Stream asset. */
function toPoint(p, market, prices) {
  if (p.closed)
    return {
      ts: p.ts,
      collateral: 0,
      collateralValue: null,
      collateralUsd: null,
      borrow: 0,
      borrowUsd: 0,
    }
  const parts = p.parts
  const main = parts.reduce((m, x) => (x.oracleUsd > (m?.oracleUsd ?? -1) ? x : m), null)
  const value = p.collateralValue
  const lt =
    value > 0 ? parts.reduce((s, x) => s + (x.oracleUsd ?? 0) * x.lt, 0) / value : market.lltv
  // Collateral in main-asset units, priced at the main asset's oracle unit price.
  const mainUnit = main && main.units > 0 ? (main.oracleUsd ?? 0) / main.units : null
  const collateral = mainUnit ? value / mainUnit : (main?.units ?? 0)
  // Market value: each part at its own market price; a PT at the xUSD market × its oracle ratio.
  let marketValue = 0
  for (const x of parts) {
    const base = x.sym.startsWith('PT-xUSD') ? 'xUSD' : x.sym
    const px = priceAt(prices[base], p.ts)
    if (px === null || !MARKET_KEYS[base]) {
      marketValue = null
      break
    }
    if (x.sym.startsWith('PT-')) {
      const xusd = parts.find((y) => y.sym === 'xUSD')
      const ratio =
        x.unitOracleUsd && xusd?.unitOracleUsd ? x.unitOracleUsd / xusd.unitOracleUsd : null
      if (ratio === null) {
        marketValue = null
        break
      }
      marketValue += x.units * px * ratio
    } else marketValue += x.units * px
  }
  return {
    ts: p.ts,
    collateral,
    collateralValue: value,
    collateralUsd: null,
    marketValueUsd: marketValue,
    borrow: p.borrow,
    borrowUsd: p.borrow,
    lt,
    adjustedCollateralUsd: p.adjustedCollateralUsd ?? null,
    parts,
  }
}

async function main() {
  const t0 = Date.now()
  console.log('prices …')
  const prices = {}
  for (const [sym, key] of Object.entries(MARKET_KEYS)) prices[sym] = await llama(key)
  const btc = await binanceBtcHourly()

  const markets = []
  const positions = []
  const liquidations = []
  const cohortLog = []
  /** chainId → [{ reader, market }] */
  const byChain = {}
  const add = (chainId, reader, market) => (byChain[chainId] ??= []).push({ reader, market })

  // Setup per market; chains run in parallel, markets on one chain in turn.
  const setups = []
  for (const m of EULER.filter((x) => wanted(x.sym))) setups.push([m.chainId, () => setupEuler(m)])
  for (const s of SILO.filter((x) => wanted(`silo-${x.id}`)))
    setups.push([s.chainId, () => setupSilo(s)])
  for (const g of GEARBOX.filter(() => wanted('gearbox')))
    setups.push([g.chainId, () => setupGearbox(g)])
  const chains = [...new Set(setups.map(([c]) => c))]
  await Promise.all(
    chains.map(async (c) => {
      for (const [chainId, run] of setups) if (chainId === c) await run()
    }),
  )
  const byOrder = (a, b) =>
    a.venue.localeCompare(b.venue) ||
    a.chainId - b.chainId ||
    String(a.market ?? a.marketId).localeCompare(String(b.market ?? b.marketId))
  markets.sort(byOrder)
  cohortLog.sort(byOrder)
  for (const list of Object.values(byChain)) list.sort((a, b) => byOrder(a.market, b.market))
  for (const l of liquidations) {
    const b = await rpc(l.chainId, 'eth_getBlockByNumber', [toHex(l.block), false])
    l.ts = Number(b.timestamp)
  }
  liquidations.sort((a, b) => a.chainId - b.chainId || a.block - b.block)

  async function setupEuler(m) {
    const start = blockAt(m.chainId, SPEC.fromTs)
    const [loan, oracleOf] = await multicall(m.chainId, start, [
      { to: m.vault, fn: 'asset' },
      { to: m.vault, fn: 'oracle' },
    ])
    m.loanToken = loan.value.toLowerCase()
    const dec = await decimalsOf(
      m.chainId,
      [...new Set([...m.colls.map(([, a]) => a), m.loanToken])],
      start,
    )
    const c = await cachedCohort(`euler-${m.chainId}-${m.sym}`, () => eulerCohort(m))
    cohortLog.push({
      venue: 'euler',
      chainId: m.chainId,
      market: m.sym,
      ...c,
      accounts: c.accounts.length,
    })
    console.log(
      `  euler ${m.chainId} ${m.sym}: ${c.borrowers} borrowers ever, ${c.withDebt} with debt at Nov 2, ${c.accounts.length} on Stream collateral`,
    )
    const market = {
      venue: 'euler',
      chainId: m.chainId,
      marketId: m.vault,
      marketName: m.sym,
      collateral: STREAM_ASSETS[m.chainId][m.colls[0][1]],
      collaterals: m.colls.map(([v, a, lt]) => ({
        vault: v,
        asset: a,
        sym: STREAM_ASSETS[m.chainId][a],
        liquidationLtv: lt,
      })),
      loan: m.loan,
      lltv: m.colls[0][2],
      curator: m.curator,
      oracle: oracleOf.value,
    }
    markets.push(market)
    if (c.accounts.length) add(m.chainId, eulerReader(m, c.accounts, dec, oracleOf.value), market)
    const liq = await logs(
      m.chainId,
      m.vault,
      [T_LIQUIDATE],
      blockAt(m.chainId, HISTORY.fromTs),
      blockAt(m.chainId, HISTORY.toTs),
    )
    for (const l of liq)
      liquidations.push({
        venue: 'euler',
        chainId: m.chainId,
        marketId: m.vault,
        user: addr(l.topics[2]),
        block: Number(l.blockNumber),
        tx: l.transactionHash,
      })
  }

  async function setupSilo(s) {
    const start = blockAt(s.chainId, SPEC.fromTs)
    const dec = await decimalsOf(s.chainId, [s.token0, s.token1], start)
    const c = await cachedCohort(`silo-${s.chainId}-${s.id}`, () => siloCohort(s))
    cohortLog.push({
      venue: 'silo',
      chainId: s.chainId,
      market: `silo ${s.id}`,
      ...c,
      accounts: c.accounts.length,
    })
    console.log(
      `  silo ${s.chainId} ${s.id}: ${c.borrowers} borrowers ever, ${c.withDebt} with debt at Nov 2`,
    )
    const sym = STREAM_ASSETS[s.chainId][s.token0]
    const market = {
      venue: 'silo',
      chainId: s.chainId,
      marketId: s.config,
      marketName: `Silo ${s.id} ${sym}/${s.loan}`,
      collateral: sym,
      loan: s.loan,
      lltv: s.lt0,
      curator: s.curator,
      oracle: s.oracle0,
    }
    markets.push(market)
    if (c.accounts.length) add(s.chainId, siloReader(s, c.accounts, dec, btc), market)
    const [cfg] = await multicall(s.chainId, start, [
      { to: s.config, fn: 'getConfig', args: [s.silo0] },
    ])
    const hook = cfg.value.hookReceiver.toLowerCase()
    const liq = await logs(
      s.chainId,
      hook,
      [T_SILO_LIQ],
      blockAt(s.chainId, HISTORY.fromTs),
      blockAt(s.chainId, HISTORY.toTs),
    )
    for (const l of liq)
      liquidations.push({
        venue: 'silo',
        chainId: s.chainId,
        marketId: s.config,
        user: addr(l.topics[3]),
        silo: addr(l.topics[2]),
        block: Number(l.blockNumber),
        tx: l.transactionHash,
      })
  }

  async function setupGearbox(g) {
    const start = blockAt(g.chainId, SPEC.fromTs)
    const dec = await decimalsOf(g.chainId, [g.xusd], start)
    const c = await gearboxCohort(g)
    cohortLog.push({
      venue: 'gearbox',
      chainId: g.chainId,
      market: g.name,
      ...c,
      accounts: c.accounts.length,
    })
    console.log(`  gearbox ${g.chainId} ${g.name}: ${c.accounts.length} credit accounts at Nov 2`)
    const market = {
      venue: 'gearbox',
      chainId: g.chainId,
      marketId: g.cm,
      marketName: g.name,
      collateral: 'xUSD',
      loan: g.loan,
      lltv: g.lt,
      curator: g.curator,
    }
    markets.push(market)
    if (c.accounts.length) add(g.chainId, gearboxReader(g, c.accounts, dec), market)
    const end = blockAt(g.chainId, HISTORY.toTs)
    const [facade] = await multicall(g.chainId, end, [{ to: g.cm, fn: 'creditFacade' }])
    const liq = await logs(
      g.chainId,
      facade.value.toLowerCase(),
      [[T_GB_PARTIAL, T_GB_LIQ]],
      blockAt(g.chainId, HISTORY.fromTs),
      end,
    )
    for (const l of liq)
      liquidations.push({
        venue: 'gearbox',
        chainId: g.chainId,
        marketId: g.cm,
        user: addr(l.topics[1]),
        partial: l.topics[0] === T_GB_PARTIAL,
        block: Number(l.blockNumber),
        tx: l.transactionHash,
      })
  }

  console.log('sampling every 2h, chains in parallel …')
  await Promise.all(
    Object.entries(byChain).map(async ([chainId, list]) => {
      const t = Date.now()
      await sampleChain(
        Number(chainId),
        list.map((x) => x.reader),
      )
      console.log(
        `  chain ${chainId}: ${list.length} markets sampled in ${((Date.now() - t) / 1000).toFixed(0)}s`,
      )
    }),
  )
  for (const list of Object.values(byChain))
    for (const { reader, market } of list)
      for (const [user, h] of Object.entries(reader.hist))
        positions.push({
          venue: market.venue,
          chainId: market.chainId,
          marketId: market.marketId,
          user,
          history: h.map((p) => toPoint(p, market, prices)),
        })

  const body = {
    label:
      'Recall Coverage Dataset spec E2 off Morpho: Euler v2, Silo v2 and Gearbox v3.1 positions on xUSD, xBTC, xETH, deUSD, sdeUSD (Nov 2025)',
    specWindow: SPEC,
    historyWindow: HISTORY,
    sampleStepS: STEP_S,
    source:
      "Archive eth_call through Multicall3 every 2 hours at the block nearest each time (keyless RPCs per chain); cohort from Borrow logs (Euler), debt-share mints (Silo) and creditAccounts() (Gearbox) up to the Nov 2 block. Collateral and debt valued at each venue's own oracle (Euler accountLiquidity / getQuote, Silo solvency-oracle quotes, Gearbox calcDebtAndCollateral). Market prices: DefiLlama CoinGecko ids, hourly; BTC.b debt at Binance BTCUSDT.",
    uncovered:
      'xBTC and xETH have no market price series (oracle basis only). Liquidations: Euler Liquidate, Silo v2 hook LiquidationCall, Gearbox v3.1 facade (partial and full); a Gearbox credit facade replaced inside the window would be missed.',
    cohort: cohortLog,
    markets,
    positions,
    liquidations,
    marketPrices: Object.fromEntries([
      ...Object.entries(MARKET_KEYS).map(([sym, key]) => [sym, { key, series: prices[sym] }]),
      ['BTC/USD (Binance)', { key: 'binance:BTCUSDT 1h', series: btc }],
    ]),
    fetchedAt: new Date().toISOString(),
  }
  await mkdir(OUT, { recursive: true })
  const text = JSON.stringify(body)
  await writeFile(join(OUT, FILE), text)
  const manifestPath = join(OUT, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.files[FILE] = {
    builder: 'scripts/research/build-position-alert-e2-offmorpho.mjs',
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    fetchedAt: body.fetchedAt,
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    `${FILE}: ${positions.length} positions on ${markets.length} markets, ${(Buffer.byteLength(text) / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
