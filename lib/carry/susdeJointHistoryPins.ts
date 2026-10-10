/** Literal paired native stocks. No holder rights, gross flow or forecast authority. */
export function freezeSusde<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeSusde)
    Object.freeze(value)
  }
  return value
}
const canonical = freezeSusde({
  file: 'data/research/venue-signals/susde-joint-native-history-2026-10-08T00-10.json',
  fileSha256: 'ddbc18b04950932b649145ddb5d289e9f0cf59e55cdd337e998ce7dac1c7c853',
  bodySha256: '4e8a7bed7d280595d29853c0348b83a8de008d1110cd40e8a69da1172223ecea',
  captureFileSha256: 'a32bfd031f89ff118aaae899ee8e11e9a30288c797a1bd40744eb930a426f14e',
  availableAtUtc: '2026-10-08T00:10:33.139Z',
  addresses: {
    vault: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
    asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    silo: '0x7fc7c91d556b400afa565013e3f32055a0713425',
  },
  runtimeIdentities: {
    vault: '4ef7631314ff56c84fc45b5bbff1d2ee56a6ce1746d9f494bad8939822ecb0e7',
    asset: 'e496966ae06cccbbab0d5b90f79b52d954778b10ecc8ea2a16f287ce602c06a6',
    silo: 'cbcdcfde9e967fb283d69d4978cf091cf09f632bd1247c858578e69632d7b9fe',
  },
  assetDecimals: 18,
  rows: [
    {
      index: 116,
      blockNumber: '26086569',
      blockHash: '0x47f2ef87e05d0a9f6d4f9cc1c47cfa504b8dc94bb1a52a8b8f778a409328c250',
      sourceAt: '2026-09-29T23:59:59.000Z',
      vaultUsdeRaw: '1288097605250583534685668968',
      siloUsdeRaw: '22597306925077501890077083',
      cooldownDurationSeconds: '86400',
      availableAt: '2026-10-08T00:10:33.139Z',
    },
    {
      index: 117,
      blockNumber: '26093737',
      blockHash: '0xcd26204e996dceb606ccf0bc6f5bf8ea6747a471df8be73b5855f01624d5d743',
      sourceAt: '2026-09-30T23:59:59.000Z',
      vaultUsdeRaw: '1261373395092895015454085745',
      siloUsdeRaw: '39914389141714085071203333',
      cooldownDurationSeconds: '86400',
      availableAt: '2026-10-08T00:10:33.139Z',
    },
    {
      index: 118,
      blockNumber: '26100913',
      blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
      sourceAt: '2026-10-01T23:59:59.000Z',
      vaultUsdeRaw: '1256086455940514932066787384',
      siloUsdeRaw: '17354430845212029574792495',
      cooldownDurationSeconds: '86400',
      availableAt: '2026-10-08T00:10:33.139Z',
    },
    {
      index: 119,
      blockNumber: '26108081',
      blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
      sourceAt: '2026-10-02T23:59:59.000Z',
      vaultUsdeRaw: '1251252340494661426761783289',
      siloUsdeRaw: '20831458906481737687655564',
      cooldownDurationSeconds: '86400',
      availableAt: '2026-10-08T00:10:33.139Z',
    },
  ],
})
export const SUSDE_JOINT_HISTORY_PIN = canonical
export function susdePinnedJointHistory() {
  return structuredClone(canonical)
}
export type SusdeJointHistory = ReturnType<typeof susdePinnedJointHistory>
