import {
  freezeSusde,
  SUSDE_JOINT_HISTORY_PIN,
  type SusdeJointHistory,
} from './susdeJointHistoryPins'

/** Canonical six-capture evidence; composition time never replaces original acquisition time. */
export type SusdeJointHistoryEvidenceSource = {
  id: string
  fileSha256: string
  bodySha256: string
  fileBytes: number
  captureFileSha256: string
  nativePlanSha256: string
  driverSha256: string
  indices: number[]
  startedAt: string
  availableAt: string
}
export type SusdeJointHistoryEvidenceRow = SusdeJointHistory['rows'][number] & {
  anchorAt: string
  oldReadAt: string
  oldAvailableAt: string
  receiptSha256: string
  pairedReadStartedAt: string
  pairedReadCompletedAt: string
  provenance: {
    inputId: string
    originalFileSha256: string
    originalCaptureFileSha256: string
    originalNativePlanSha256: string
    withinCaptureIndex: number
  }
  acquisitionByOrigin: { origin: string; startedAt: string; completedAt: string }[]
}
export type SusdeJointHistoryEvidenceSet = {
  schema: 'susde_joint_history_evidence_set_pin_v1'
  evidenceSetSha256: string
  composition: { file: string; fileSha256: string; bodySha256: string }
  archive: { file: string; fileSha256: string; bodySha256: string }
  inputManifestSha256: string
  qualifiedHistorySha256: string
  compositionAtUtc: string
  availableAtUtc: string
  addresses: SusdeJointHistory['addresses']
  runtimeIdentities: SusdeJointHistory['runtimeIdentities']
  assetDecimals: 18
  sources: SusdeJointHistoryEvidenceSource[]
  rows: SusdeJointHistoryEvidenceRow[]
  missingIndices: number[]
  gaps: {
    fromIndex: number
    toIndex: number
    elapsedSeconds: number
    missingIndices: number[]
    reason: string
  }[]
  dailyDonorCount: number
  plannedPointCount: number
  actualPointCount: number
  interpretation: 'paired_correlated_NET_stocks_not_grossflows_holder_E_or_queue_Q'
}
const canonical: SusdeJointHistoryEvidenceSet = freezeSusde({
  addresses: structuredClone(SUSDE_JOINT_HISTORY_PIN.addresses),
  runtimeIdentities: structuredClone(SUSDE_JOINT_HISTORY_PIN.runtimeIdentities),
  assetDecimals: 18,
  schema: 'susde_joint_history_evidence_set_pin_v1',
  evidenceSetSha256: '81b3a336b86e75fd8c9ae398e73f958701475ac331ebcd8aabef9fcf6a04c666',
  composition: {
    file: 'data/research/venue-signals/susde-joint-history-evidence-set-2026-10-08T04-14/composition.actual.json',
    fileSha256: 'aee93b29f51fe4cb2879474381c95689107af08f080509acafc8a8d00e971e84',
    bodySha256: 'c7a139e6f506cfba56422c3ab79780d282ea09ef74ce51389a37c206f98faee3',
  },
  archive: {
    file: 'data/research/venue-signals/susde-joint-history-evidence-set-2026-10-08T04-14/evidence-archive.actual.json',
    fileSha256: '05d6e09fafc702c94350750f85c1174caa95ecff9428e2ea76f561a66529d844',
    bodySha256: '2bbe858d5fced4fa87df971764d132cc37ff959b1a60d8d1a18f998d0852cb91',
  },
  inputManifestSha256: '4badf52c01847aabe150300658491de1464c9f3f034c4243b55880a786ff92a0',
  qualifiedHistorySha256: '3c0114ed0efed78c27a77d0e0cdd7d1d931fe15a8c5434ae7d4ca45881fc994f',
  compositionAtUtc: '2026-10-08T04:14:22.470Z',
  availableAtUtc: '2026-10-08T04:14:22.470Z',
  sources: [
    {
      id: 'chunk-0',
      fileSha256: '60e379a1a7a89d887c7cba558ba1a72fcb9924637815cfe71a0a88ae4fe78d2f',
      bodySha256: 'e2ac15c58abc2216df82fdfe72dfa680eac3c3d2b84fea7c395c819b7216de26',
      fileBytes: 1552026,
      captureFileSha256: '666f1a8662216cadc65118e2bedf9194eddcd058be3757b955778b0e7e288cf8',
      nativePlanSha256: '6462814563e7fae78b1bde50739dcc94824cd3bae79561fd876476d7c7381f46',
      driverSha256: '3090e3edc44ab63ae7ddb0736c775ce3b3c9edcaaae925c12889313b5d23c810',
      indices: [0, 1, 2, 3],
      startedAt: '2026-10-08T03:39:50.755Z',
      availableAt: '2026-10-08T03:39:54.362Z',
    },
    {
      id: 'chunk-1',
      fileSha256: '4f45c937630063e40008c1d20d9f9e7db3fda93c1fb776f33125da057324bfcc',
      bodySha256: '169aeed818cb0c7fae0c968400709de75662d56bf6cb851bf9797291d39b77cd',
      fileBytes: 1592944,
      captureFileSha256: '06f6b8ec1ef9f222712b72f7eb15346aa541636522141a0ad890ad1004cea7f5',
      nativePlanSha256: '04d1d020fd7d5cdf580ecdbaa4c69900f883baf4f1416651e004f91adf38ba8f',
      driverSha256: '3090e3edc44ab63ae7ddb0736c775ce3b3c9edcaaae925c12889313b5d23c810',
      indices: [4, 5, 6, 7],
      startedAt: '2026-10-08T03:41:38.117Z',
      availableAt: '2026-10-08T03:41:41.818Z',
    },
    {
      id: 'chunk-2',
      fileSha256: '017d710130e45f30f81428f7c2afe5c909319e32a61a5dda24610a3236d805c6',
      bodySha256: '3fb1cb128d0fd354912652a751aba9a6d6a8ba7459294576b76ccd1ef24587a0',
      fileBytes: 1557295,
      captureFileSha256: 'd93117ab197e56a7ffbeeba0d1f2527673877945522202cfb57af16537f280ba',
      nativePlanSha256: '711290c1e08f05eb1a28cc1d8fe6f1e42064b01b0a4ec2ff6e192a861e21b2da',
      driverSha256: '3090e3edc44ab63ae7ddb0736c775ce3b3c9edcaaae925c12889313b5d23c810',
      indices: [8, 9, 10, 11],
      startedAt: '2026-10-08T03:41:43.906Z',
      availableAt: '2026-10-08T03:41:47.454Z',
    },
    {
      id: 'chunk-3',
      fileSha256: '35288c7d6ae9c85d4f541dfa321ed5df96cf276270d84c73f4e6c872907a3fb1',
      bodySha256: '35fe7fd9271f240ba9556273745b19a29fe820947b794f674f0922656fdda5d8',
      fileBytes: 1459134,
      captureFileSha256: '7a2a8db74d15842a146fd3636ca356bdac1f81b9afa82f61611d0ef1d46399f8',
      nativePlanSha256: 'fb72567986c8b23fc84d7aa4143a211eebc6d6e3c9f06fe8eb09e3419a8993af',
      driverSha256: '3090e3edc44ab63ae7ddb0736c775ce3b3c9edcaaae925c12889313b5d23c810',
      indices: [12, 13, 14, 15],
      startedAt: '2026-10-08T03:41:49.613Z',
      availableAt: '2026-10-08T03:41:53.162Z',
    },
    {
      id: 'chunk-4',
      fileSha256: '689d98eef9d845be483083ee156e0655df58e6245bb4bf06307150f435956869',
      bodySha256: '4f0d9445cdaa289143989a09a95b501d4d4b3e6d102aceb04787f7752ecfae9c',
      fileBytes: 1880678,
      captureFileSha256: '973c513e125383eae4453b1ab3a7780492ee4167f1059b1c5c4eba07cdc4e681',
      nativePlanSha256: 'c58df2b3eded63fcace9b5068f4bbd4b12429528b7ff1a28fa9da7f478cf9844',
      driverSha256: '3090e3edc44ab63ae7ddb0736c775ce3b3c9edcaaae925c12889313b5d23c810',
      indices: [16, 17, 18, 19],
      startedAt: '2026-10-08T03:41:55.280Z',
      availableAt: '2026-10-08T03:41:58.683Z',
    },
    {
      id: 'legacy-116-119',
      fileSha256: 'ddbc18b04950932b649145ddb5d289e9f0cf59e55cdd337e998ce7dac1c7c853',
      bodySha256: '4e8a7bed7d280595d29853c0348b83a8de008d1110cd40e8a69da1172223ecea',
      fileBytes: 1597127,
      captureFileSha256: 'a32bfd031f89ff118aaae899ee8e11e9a30288c797a1bd40744eb930a426f14e',
      nativePlanSha256: '4ae0217d542e943f04880782af2b1a6c801db407672ff5606cf3dc0242f5ea43',
      driverSha256: 'b441b4b4a04a8d5496803c4aca295b28183cfded7b1962849aec53653c83b037',
      indices: [116, 117, 118, 119],
      startedAt: '2026-10-08T00:10:30.255Z',
      availableAt: '2026-10-08T00:10:33.139Z',
    },
  ],
  rows: [
    {
      index: 0,
      blockNumber: '25254619',
      blockHash: '0x8d1632207a9a1a3e809b769c78e82cd5de319f407e8c0b614d1bc9e80b07bebe',
      sourceAt: '2026-06-05T23:59:59.000Z',
      vaultUsdeRaw: '1799709286323528827833923980',
      anchorAt: '2026-06-06T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:52:52.055Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '4ea4c9fc93698142078d36d332c47c9a04bfd5dbbb6f6e8e1d415e26d6465587',
      siloUsdeRaw: '26676728483929997300296980',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:39:50.756Z',
      pairedReadCompletedAt: '2026-10-08T03:39:53.263Z',
      availableAt: '2026-10-08T03:39:54.362Z',
      provenance: {
        inputId: 'chunk-0',
        originalFileSha256: '60e379a1a7a89d887c7cba558ba1a72fcb9924637815cfe71a0a88ae4fe78d2f',
        originalCaptureFileSha256:
          '666f1a8662216cadc65118e2bedf9194eddcd058be3757b955778b0e7e288cf8',
        originalNativePlanSha256:
          '6462814563e7fae78b1bde50739dcc94824cd3bae79561fd876476d7c7381f46',
        withinCaptureIndex: 0,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:39:50.756Z',
          completedAt: '2026-10-08T03:39:51.420Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:39:52.784Z',
          completedAt: '2026-10-08T03:39:53.263Z',
        },
      ],
    },
    {
      index: 1,
      blockNumber: '25261799',
      blockHash: '0x567ac578d5de451989a17c48b443f2b1e1872aae5d632de3c1272fa4ba43d6e2',
      sourceAt: '2026-06-06T23:59:59.000Z',
      vaultUsdeRaw: '1793413763954086037042720943',
      anchorAt: '2026-06-07T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:53:14.560Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'f24cb5845bbedb951cd24338f99296b78ec40f63a211e13b2e8c47e42ea88cef',
      siloUsdeRaw: '26679086004449382409942774',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:39:51.422Z',
      pairedReadCompletedAt: '2026-10-08T03:39:53.640Z',
      availableAt: '2026-10-08T03:39:54.362Z',
      provenance: {
        inputId: 'chunk-0',
        originalFileSha256: '60e379a1a7a89d887c7cba558ba1a72fcb9924637815cfe71a0a88ae4fe78d2f',
        originalCaptureFileSha256:
          '666f1a8662216cadc65118e2bedf9194eddcd058be3757b955778b0e7e288cf8',
        originalNativePlanSha256:
          '6462814563e7fae78b1bde50739dcc94824cd3bae79561fd876476d7c7381f46',
        withinCaptureIndex: 1,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:39:51.422Z',
          completedAt: '2026-10-08T03:39:51.855Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:39:53.264Z',
          completedAt: '2026-10-08T03:39:53.640Z',
        },
      ],
    },
    {
      index: 2,
      blockNumber: '25268963',
      blockHash: '0xd8c220f7b24518b529b93dc2bbaa78c80e8ff4a37e86432eec5fe0d09995f02e',
      sourceAt: '2026-06-07T23:59:59.000Z',
      vaultUsdeRaw: '1783109033463458006147451350',
      anchorAt: '2026-06-08T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:53:24.398Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '49e00ad2adb622b713c19e5ef044ce24fcaa5aec8ba1d11131e783c348dd8ad4',
      siloUsdeRaw: '29189473140922605066800380',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:39:51.857Z',
      pairedReadCompletedAt: '2026-10-08T03:39:54.034Z',
      availableAt: '2026-10-08T03:39:54.362Z',
      provenance: {
        inputId: 'chunk-0',
        originalFileSha256: '60e379a1a7a89d887c7cba558ba1a72fcb9924637815cfe71a0a88ae4fe78d2f',
        originalCaptureFileSha256:
          '666f1a8662216cadc65118e2bedf9194eddcd058be3757b955778b0e7e288cf8',
        originalNativePlanSha256:
          '6462814563e7fae78b1bde50739dcc94824cd3bae79561fd876476d7c7381f46',
        withinCaptureIndex: 2,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:39:51.857Z',
          completedAt: '2026-10-08T03:39:52.338Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:39:53.641Z',
          completedAt: '2026-10-08T03:39:54.034Z',
        },
      ],
    },
    {
      index: 3,
      blockNumber: '25276141',
      blockHash: '0xa63cf778f69e9c6fa60c5ca317c9bbe29b8351423f69d394b7fd61ed140fbb4e',
      sourceAt: '2026-06-08T23:59:59.000Z',
      vaultUsdeRaw: '1775448970121762149549087603',
      anchorAt: '2026-06-09T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:53:30.217Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '7e270f4b38f733aa1729e6a760c76baf0b93468580024826b0252439ae598472',
      siloUsdeRaw: '28984666541941522659997537',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:39:52.340Z',
      pairedReadCompletedAt: '2026-10-08T03:39:54.361Z',
      availableAt: '2026-10-08T03:39:54.362Z',
      provenance: {
        inputId: 'chunk-0',
        originalFileSha256: '60e379a1a7a89d887c7cba558ba1a72fcb9924637815cfe71a0a88ae4fe78d2f',
        originalCaptureFileSha256:
          '666f1a8662216cadc65118e2bedf9194eddcd058be3757b955778b0e7e288cf8',
        originalNativePlanSha256:
          '6462814563e7fae78b1bde50739dcc94824cd3bae79561fd876476d7c7381f46',
        withinCaptureIndex: 3,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:39:52.340Z',
          completedAt: '2026-10-08T03:39:52.781Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:39:54.035Z',
          completedAt: '2026-10-08T03:39:54.361Z',
        },
      ],
    },
    {
      index: 4,
      blockNumber: '25283318',
      blockHash: '0x7b3456f1817a2300eb17ac4c2f791b9d566584b45153fef34fe361da6a5f1d9c',
      sourceAt: '2026-06-09T23:59:59.000Z',
      vaultUsdeRaw: '1765979259676135506734973830',
      anchorAt: '2026-06-10T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:53:38.385Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '15fa65ec7fcd64ec91b2f2e72fa2ec9008091d8976c84e596ef75e2d51cf30ae',
      siloUsdeRaw: '29079138562323527917024877',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:38.118Z',
      pairedReadCompletedAt: '2026-10-08T03:41:40.660Z',
      availableAt: '2026-10-08T03:41:41.818Z',
      provenance: {
        inputId: 'chunk-1',
        originalFileSha256: '4f45c937630063e40008c1d20d9f9e7db3fda93c1fb776f33125da057324bfcc',
        originalCaptureFileSha256:
          '06f6b8ec1ef9f222712b72f7eb15346aa541636522141a0ad890ad1004cea7f5',
        originalNativePlanSha256:
          '04d1d020fd7d5cdf580ecdbaa4c69900f883baf4f1416651e004f91adf38ba8f',
        withinCaptureIndex: 0,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:38.118Z',
          completedAt: '2026-10-08T03:41:38.763Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:40.140Z',
          completedAt: '2026-10-08T03:41:40.660Z',
        },
      ],
    },
    {
      index: 5,
      blockNumber: '25290492',
      blockHash: '0x0a770fd9e0b3c19b4259bdf7f8022cf88192039c96ed09e2243b0e2141a0a6f5',
      sourceAt: '2026-06-10T23:59:59.000Z',
      vaultUsdeRaw: '1755088121731869098411972737',
      anchorAt: '2026-06-11T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:53:48.919Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '729f6901ce6930427d004252e906d28d1711684d52d08c53bcb173a00dff0c95',
      siloUsdeRaw: '37204827827371314238761841',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:38.766Z',
      pairedReadCompletedAt: '2026-10-08T03:41:41.027Z',
      availableAt: '2026-10-08T03:41:41.818Z',
      provenance: {
        inputId: 'chunk-1',
        originalFileSha256: '4f45c937630063e40008c1d20d9f9e7db3fda93c1fb776f33125da057324bfcc',
        originalCaptureFileSha256:
          '06f6b8ec1ef9f222712b72f7eb15346aa541636522141a0ad890ad1004cea7f5',
        originalNativePlanSha256:
          '04d1d020fd7d5cdf580ecdbaa4c69900f883baf4f1416651e004f91adf38ba8f',
        withinCaptureIndex: 1,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:38.766Z',
          completedAt: '2026-10-08T03:41:39.211Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:40.662Z',
          completedAt: '2026-10-08T03:41:41.027Z',
        },
      ],
    },
    {
      index: 6,
      blockNumber: '25297657',
      blockHash: '0xc94f21c8eac64237550551c3100b0de6683f8420c0d8de61edef0173ef6d0116',
      sourceAt: '2026-06-11T23:59:59.000Z',
      vaultUsdeRaw: '1748608524916033591919797499',
      anchorAt: '2026-06-12T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:53:57.535Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '1a0a757af8cdfae75dce7385ebccfd59670b2a4c4f3f49ac64f5660666ffc8c6',
      siloUsdeRaw: '25309187718654798725833415',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:39.213Z',
      pairedReadCompletedAt: '2026-10-08T03:41:41.453Z',
      availableAt: '2026-10-08T03:41:41.818Z',
      provenance: {
        inputId: 'chunk-1',
        originalFileSha256: '4f45c937630063e40008c1d20d9f9e7db3fda93c1fb776f33125da057324bfcc',
        originalCaptureFileSha256:
          '06f6b8ec1ef9f222712b72f7eb15346aa541636522141a0ad890ad1004cea7f5',
        originalNativePlanSha256:
          '04d1d020fd7d5cdf580ecdbaa4c69900f883baf4f1416651e004f91adf38ba8f',
        withinCaptureIndex: 2,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:39.213Z',
          completedAt: '2026-10-08T03:41:39.658Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:41.029Z',
          completedAt: '2026-10-08T03:41:41.453Z',
        },
      ],
    },
    {
      index: 7,
      blockNumber: '25304829',
      blockHash: '0x3905a3b2546fe9acee482b1df753b58f4a6fc69c23bc1eb638f14760cc4e17e2',
      sourceAt: '2026-06-12T23:59:59.000Z',
      vaultUsdeRaw: '1747052264772412362781128877',
      anchorAt: '2026-06-13T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:54:06.854Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '59d48bd8e8a85194145c3671d707672e1a3f05c409441d1aa14e2a2d555f9d1f',
      siloUsdeRaw: '20690386568099361692388332',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:39.660Z',
      pairedReadCompletedAt: '2026-10-08T03:41:41.817Z',
      availableAt: '2026-10-08T03:41:41.818Z',
      provenance: {
        inputId: 'chunk-1',
        originalFileSha256: '4f45c937630063e40008c1d20d9f9e7db3fda93c1fb776f33125da057324bfcc',
        originalCaptureFileSha256:
          '06f6b8ec1ef9f222712b72f7eb15346aa541636522141a0ad890ad1004cea7f5',
        originalNativePlanSha256:
          '04d1d020fd7d5cdf580ecdbaa4c69900f883baf4f1416651e004f91adf38ba8f',
        withinCaptureIndex: 3,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:39.660Z',
          completedAt: '2026-10-08T03:41:40.137Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:41.455Z',
          completedAt: '2026-10-08T03:41:41.817Z',
        },
      ],
    },
    {
      index: 8,
      blockNumber: '25312002',
      blockHash: '0xa27b99ff0b3686dabdb4e1627b1d7e0ab46fbfc5166176b6854fed4cf4bd84a8',
      sourceAt: '2026-06-13T23:59:59.000Z',
      vaultUsdeRaw: '1745086663393525908446620926',
      anchorAt: '2026-06-14T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:54:15.719Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'f9b7243a1cff9a1fa10f8106e9597112dd954cc264353cf10d8f949716766ae3',
      siloUsdeRaw: '19426195167482257267688250',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:43.907Z',
      pairedReadCompletedAt: '2026-10-08T03:41:46.333Z',
      availableAt: '2026-10-08T03:41:47.454Z',
      provenance: {
        inputId: 'chunk-2',
        originalFileSha256: '017d710130e45f30f81428f7c2afe5c909319e32a61a5dda24610a3236d805c6',
        originalCaptureFileSha256:
          'd93117ab197e56a7ffbeeba0d1f2527673877945522202cfb57af16537f280ba',
        originalNativePlanSha256:
          '711290c1e08f05eb1a28cc1d8fe6f1e42064b01b0a4ec2ff6e192a861e21b2da',
        withinCaptureIndex: 0,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:43.907Z',
          completedAt: '2026-10-08T03:41:44.541Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:45.843Z',
          completedAt: '2026-10-08T03:41:46.333Z',
        },
      ],
    },
    {
      index: 9,
      blockNumber: '25319172',
      blockHash: '0x9b32298f2dd451d1f5bee21a24613aa2f2bfcd28223cc86491e1a442f47eb97f',
      sourceAt: '2026-06-14T23:59:59.000Z',
      vaultUsdeRaw: '1734522604664307678296074300',
      anchorAt: '2026-06-15T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:54:27.294Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'cbb1e365226f9f4082dc95c0d1532bd09ef30bcde0e3028fe8129b2f07ea069c',
      siloUsdeRaw: '29008740573540855469004842',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:44.543Z',
      pairedReadCompletedAt: '2026-10-08T03:41:46.703Z',
      availableAt: '2026-10-08T03:41:47.454Z',
      provenance: {
        inputId: 'chunk-2',
        originalFileSha256: '017d710130e45f30f81428f7c2afe5c909319e32a61a5dda24610a3236d805c6',
        originalCaptureFileSha256:
          'd93117ab197e56a7ffbeeba0d1f2527673877945522202cfb57af16537f280ba',
        originalNativePlanSha256:
          '711290c1e08f05eb1a28cc1d8fe6f1e42064b01b0a4ec2ff6e192a861e21b2da',
        withinCaptureIndex: 1,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:44.543Z',
          completedAt: '2026-10-08T03:41:44.960Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:46.334Z',
          completedAt: '2026-10-08T03:41:46.703Z',
        },
      ],
    },
    {
      index: 10,
      blockNumber: '25326350',
      blockHash: '0x85c393d3ae4c2cc182278858dac549f6d3012b46c7195e0efd3ea5979a1dd594',
      sourceAt: '2026-06-15T23:59:59.000Z',
      vaultUsdeRaw: '1730747869582752799865356206',
      anchorAt: '2026-06-16T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:54:32.679Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '4f50a9f3e50f995abde3f1840761d18fe58088232101619070277260d7e2c060',
      siloUsdeRaw: '21254712393376847578570569',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:44.961Z',
      pairedReadCompletedAt: '2026-10-08T03:41:47.072Z',
      availableAt: '2026-10-08T03:41:47.454Z',
      provenance: {
        inputId: 'chunk-2',
        originalFileSha256: '017d710130e45f30f81428f7c2afe5c909319e32a61a5dda24610a3236d805c6',
        originalCaptureFileSha256:
          'd93117ab197e56a7ffbeeba0d1f2527673877945522202cfb57af16537f280ba',
        originalNativePlanSha256:
          '711290c1e08f05eb1a28cc1d8fe6f1e42064b01b0a4ec2ff6e192a861e21b2da',
        withinCaptureIndex: 2,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:44.961Z',
          completedAt: '2026-10-08T03:41:45.380Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:46.704Z',
          completedAt: '2026-10-08T03:41:47.072Z',
        },
      ],
    },
    {
      index: 11,
      blockNumber: '25333536',
      blockHash: '0x4cf8c356fa44c365221828ef91e7202d7bf8c9b88e808c2489f7aafa09db46d7',
      sourceAt: '2026-06-16T23:59:59.000Z',
      vaultUsdeRaw: '1723453934129912338587980705',
      anchorAt: '2026-06-17T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:54:40.479Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'ca53d3cee7652aff474e1df33e985a804f8acbd78c01b4427957e279d0997a3c',
      siloUsdeRaw: '23255685079118173856795113',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:45.381Z',
      pairedReadCompletedAt: '2026-10-08T03:41:47.452Z',
      availableAt: '2026-10-08T03:41:47.454Z',
      provenance: {
        inputId: 'chunk-2',
        originalFileSha256: '017d710130e45f30f81428f7c2afe5c909319e32a61a5dda24610a3236d805c6',
        originalCaptureFileSha256:
          'd93117ab197e56a7ffbeeba0d1f2527673877945522202cfb57af16537f280ba',
        originalNativePlanSha256:
          '711290c1e08f05eb1a28cc1d8fe6f1e42064b01b0a4ec2ff6e192a861e21b2da',
        withinCaptureIndex: 3,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:45.381Z',
          completedAt: '2026-10-08T03:41:45.840Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:47.073Z',
          completedAt: '2026-10-08T03:41:47.452Z',
        },
      ],
    },
    {
      index: 12,
      blockNumber: '25340718',
      blockHash: '0xcabcfcdc3cfc72b9edefda980d08b24b5686a7fdd23192aebe94d5fef3a1f6ce',
      sourceAt: '2026-06-17T23:59:59.000Z',
      vaultUsdeRaw: '1716177523437605626433666352',
      anchorAt: '2026-06-18T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:54:49.993Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '16cfbb575c1206b63b79a7bc95784941617cc9783375d6956a305c445e2237cc',
      siloUsdeRaw: '24139066410311992708816944',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:49.614Z',
      pairedReadCompletedAt: '2026-10-08T03:41:52.066Z',
      availableAt: '2026-10-08T03:41:53.162Z',
      provenance: {
        inputId: 'chunk-3',
        originalFileSha256: '35288c7d6ae9c85d4f541dfa321ed5df96cf276270d84c73f4e6c872907a3fb1',
        originalCaptureFileSha256:
          '7a2a8db74d15842a146fd3636ca356bdac1f81b9afa82f61611d0ef1d46399f8',
        originalNativePlanSha256:
          'fb72567986c8b23fc84d7aa4143a211eebc6d6e3c9f06fe8eb09e3419a8993af',
        withinCaptureIndex: 0,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:49.614Z',
          completedAt: '2026-10-08T03:41:50.259Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:51.584Z',
          completedAt: '2026-10-08T03:41:52.066Z',
        },
      ],
    },
    {
      index: 13,
      blockNumber: '25347893',
      blockHash: '0x03aad476fdd6e832829bb933e82612013a4d037d8540e5bbc98d8f6326b244e5',
      sourceAt: '2026-06-18T23:59:59.000Z',
      vaultUsdeRaw: '1709988280384620394355278199',
      anchorAt: '2026-06-19T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:55:00.556Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'f43bd4b4d8ece3412d2a0eaddc3afce362db2612a958a67cb07f234edb1663f5',
      siloUsdeRaw: '31680997542086141528816318',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:50.263Z',
      pairedReadCompletedAt: '2026-10-08T03:41:52.494Z',
      availableAt: '2026-10-08T03:41:53.162Z',
      provenance: {
        inputId: 'chunk-3',
        originalFileSha256: '35288c7d6ae9c85d4f541dfa321ed5df96cf276270d84c73f4e6c872907a3fb1',
        originalCaptureFileSha256:
          '7a2a8db74d15842a146fd3636ca356bdac1f81b9afa82f61611d0ef1d46399f8',
        originalNativePlanSha256:
          'fb72567986c8b23fc84d7aa4143a211eebc6d6e3c9f06fe8eb09e3419a8993af',
        withinCaptureIndex: 1,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:50.263Z',
          completedAt: '2026-10-08T03:41:50.746Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:52.066Z',
          completedAt: '2026-10-08T03:41:52.494Z',
        },
      ],
    },
    {
      index: 14,
      blockNumber: '25355071',
      blockHash: '0x9dddf99ed4031b90652a4f440969d50403c39d7ab61d1899702bba9a24c527f3',
      sourceAt: '2026-06-19T23:59:59.000Z',
      vaultUsdeRaw: '1714580960988199723417543272',
      anchorAt: '2026-06-20T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:55:09.665Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'abad60a031423ac7f51ad00ae6c65a11c8e9c87ecb7d30b6d3a008aca6b549b1',
      siloUsdeRaw: '21138384836421362741671428',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:50.748Z',
      pairedReadCompletedAt: '2026-10-08T03:41:52.814Z',
      availableAt: '2026-10-08T03:41:53.162Z',
      provenance: {
        inputId: 'chunk-3',
        originalFileSha256: '35288c7d6ae9c85d4f541dfa321ed5df96cf276270d84c73f4e6c872907a3fb1',
        originalCaptureFileSha256:
          '7a2a8db74d15842a146fd3636ca356bdac1f81b9afa82f61611d0ef1d46399f8',
        originalNativePlanSha256:
          'fb72567986c8b23fc84d7aa4143a211eebc6d6e3c9f06fe8eb09e3419a8993af',
        withinCaptureIndex: 2,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:50.748Z',
          completedAt: '2026-10-08T03:41:51.143Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:52.496Z',
          completedAt: '2026-10-08T03:41:52.814Z',
        },
      ],
    },
    {
      index: 15,
      blockNumber: '25362242',
      blockHash: '0x632ec429fa4cf6e9868a166e453629def0908afa5a22d2094119af4a5896bd49',
      sourceAt: '2026-06-20T23:59:59.000Z',
      vaultUsdeRaw: '1712127320395179511349689582',
      anchorAt: '2026-06-21T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:55:18.672Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'f73184810ddeb65236ede7ef37f75b889e1399ea6507d4103e0805c4703a3fb0',
      siloUsdeRaw: '21379252127655960730003449',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:51.145Z',
      pairedReadCompletedAt: '2026-10-08T03:41:53.161Z',
      availableAt: '2026-10-08T03:41:53.162Z',
      provenance: {
        inputId: 'chunk-3',
        originalFileSha256: '35288c7d6ae9c85d4f541dfa321ed5df96cf276270d84c73f4e6c872907a3fb1',
        originalCaptureFileSha256:
          '7a2a8db74d15842a146fd3636ca356bdac1f81b9afa82f61611d0ef1d46399f8',
        originalNativePlanSha256:
          'fb72567986c8b23fc84d7aa4143a211eebc6d6e3c9f06fe8eb09e3419a8993af',
        withinCaptureIndex: 3,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:51.145Z',
          completedAt: '2026-10-08T03:41:51.581Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:52.815Z',
          completedAt: '2026-10-08T03:41:53.161Z',
        },
      ],
    },
    {
      index: 16,
      blockNumber: '25369413',
      blockHash: '0x2a051467e479f951738e65dd832917d13f8cd9f80751217d335030cb83e037a5',
      sourceAt: '2026-06-21T23:59:59.000Z',
      vaultUsdeRaw: '1709886902039868414072129516',
      anchorAt: '2026-06-22T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:55:26.969Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '1b5442384e1a098ccb36cb0cc17f15c88fa2acc51ec8130b4a2893889210e3c6',
      siloUsdeRaw: '19518418473576168753042766',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:55.280Z',
      pairedReadCompletedAt: '2026-10-08T03:41:57.592Z',
      availableAt: '2026-10-08T03:41:58.683Z',
      provenance: {
        inputId: 'chunk-4',
        originalFileSha256: '689d98eef9d845be483083ee156e0655df58e6245bb4bf06307150f435956869',
        originalCaptureFileSha256:
          '973c513e125383eae4453b1ab3a7780492ee4167f1059b1c5c4eba07cdc4e681',
        originalNativePlanSha256:
          'c58df2b3eded63fcace9b5068f4bbd4b12429528b7ff1a28fa9da7f478cf9844',
        withinCaptureIndex: 0,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:55.280Z',
          completedAt: '2026-10-08T03:41:55.871Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:57.122Z',
          completedAt: '2026-10-08T03:41:57.592Z',
        },
      ],
    },
    {
      index: 17,
      blockNumber: '25376588',
      blockHash: '0xd52c9258cd0f03c5a53934062d35314c1853dde91cc9387158f8fc3379331412',
      sourceAt: '2026-06-22T23:59:59.000Z',
      vaultUsdeRaw: '1702465948588751303042450353',
      anchorAt: '2026-06-23T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:55:36.524Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'a2150d35d47c6048759f63ca7e1b40f360cead1dc6dd844d7bc31eb29df668e8',
      siloUsdeRaw: '26824647087537885784494800',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:55.874Z',
      pairedReadCompletedAt: '2026-10-08T03:41:57.947Z',
      availableAt: '2026-10-08T03:41:58.683Z',
      provenance: {
        inputId: 'chunk-4',
        originalFileSha256: '689d98eef9d845be483083ee156e0655df58e6245bb4bf06307150f435956869',
        originalCaptureFileSha256:
          '973c513e125383eae4453b1ab3a7780492ee4167f1059b1c5c4eba07cdc4e681',
        originalNativePlanSha256:
          'c58df2b3eded63fcace9b5068f4bbd4b12429528b7ff1a28fa9da7f478cf9844',
        withinCaptureIndex: 1,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:55.874Z',
          completedAt: '2026-10-08T03:41:56.295Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:57.593Z',
          completedAt: '2026-10-08T03:41:57.947Z',
        },
      ],
    },
    {
      index: 18,
      blockNumber: '25383756',
      blockHash: '0xeeb1028e822b045369eb0b8401059c3a89ff268adb822c07ca86d67d94619f28',
      sourceAt: '2026-06-23T23:59:59.000Z',
      vaultUsdeRaw: '1717676726369626336355507469',
      anchorAt: '2026-06-24T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:55:42.689Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '8d52e7873e926c47d4137f2dec04095503d875719720397280e2fd93e1d8cd7b',
      siloUsdeRaw: '22832753479021253303316324',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:56.297Z',
      pairedReadCompletedAt: '2026-10-08T03:41:58.316Z',
      availableAt: '2026-10-08T03:41:58.683Z',
      provenance: {
        inputId: 'chunk-4',
        originalFileSha256: '689d98eef9d845be483083ee156e0655df58e6245bb4bf06307150f435956869',
        originalCaptureFileSha256:
          '973c513e125383eae4453b1ab3a7780492ee4167f1059b1c5c4eba07cdc4e681',
        originalNativePlanSha256:
          'c58df2b3eded63fcace9b5068f4bbd4b12429528b7ff1a28fa9da7f478cf9844',
        withinCaptureIndex: 2,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:56.297Z',
          completedAt: '2026-10-08T03:41:56.719Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:57.948Z',
          completedAt: '2026-10-08T03:41:58.316Z',
        },
      ],
    },
    {
      index: 19,
      blockNumber: '25390910',
      blockHash: '0xfaa0230efc073d88f8de3ead2a96047317bed179f3b8da4e8650261cb189235b',
      sourceAt: '2026-06-24T23:59:59.000Z',
      vaultUsdeRaw: '1727185748055843946070509949',
      anchorAt: '2026-06-25T00:00:00.000Z',
      oldReadAt: '2026-09-30T22:55:51.120Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '30c079a7f696c486ad58bd465d671a5777739132b5c408cffe535f82ffaa477b',
      siloUsdeRaw: '29738326002730344883713326',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T03:41:56.721Z',
      pairedReadCompletedAt: '2026-10-08T03:41:58.683Z',
      availableAt: '2026-10-08T03:41:58.683Z',
      provenance: {
        inputId: 'chunk-4',
        originalFileSha256: '689d98eef9d845be483083ee156e0655df58e6245bb4bf06307150f435956869',
        originalCaptureFileSha256:
          '973c513e125383eae4453b1ab3a7780492ee4167f1059b1c5c4eba07cdc4e681',
        originalNativePlanSha256:
          'c58df2b3eded63fcace9b5068f4bbd4b12429528b7ff1a28fa9da7f478cf9844',
        withinCaptureIndex: 3,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T03:41:56.721Z',
          completedAt: '2026-10-08T03:41:57.120Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T03:41:58.318Z',
          completedAt: '2026-10-08T03:41:58.683Z',
        },
      ],
    },
    {
      index: 116,
      blockNumber: '26086569',
      blockHash: '0x47f2ef87e05d0a9f6d4f9cc1c47cfa504b8dc94bb1a52a8b8f778a409328c250',
      sourceAt: '2026-09-29T23:59:59.000Z',
      vaultUsdeRaw: '1288097605250583534685668968',
      anchorAt: '2026-09-30T00:00:00.000Z',
      oldReadAt: '2026-10-01T00:35:14.091Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '893025755f8bfe5dfcb47e267fd8c6dd7ef3aa48654a036f3b2d3fd85a379e17',
      siloUsdeRaw: '22597306925077501890077083',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T00:10:30.268Z',
      pairedReadCompletedAt: '2026-10-08T00:10:32.440Z',
      availableAt: '2026-10-08T00:10:33.139Z',
      provenance: {
        inputId: 'legacy-116-119',
        originalFileSha256: 'ddbc18b04950932b649145ddb5d289e9f0cf59e55cdd337e998ce7dac1c7c853',
        originalCaptureFileSha256:
          'a32bfd031f89ff118aaae899ee8e11e9a30288c797a1bd40744eb930a426f14e',
        originalNativePlanSha256:
          '4ae0217d542e943f04880782af2b1a6c801db407672ff5606cf3dc0242f5ea43',
        withinCaptureIndex: 0,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T00:10:30.268Z',
          completedAt: '2026-10-08T00:10:31.055Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T00:10:32.044Z',
          completedAt: '2026-10-08T00:10:32.440Z',
        },
      ],
    },
    {
      index: 117,
      blockNumber: '26093737',
      blockHash: '0xcd26204e996dceb606ccf0bc6f5bf8ea6747a471df8be73b5855f01624d5d743',
      sourceAt: '2026-09-30T23:59:59.000Z',
      vaultUsdeRaw: '1261373395092895015454085745',
      anchorAt: '2026-10-01T00:00:00.000Z',
      oldReadAt: '2026-10-02T00:28:30.671Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: '80454bf4e91a196d36eda1868ddaa1d8df286b87e10b6f08779d8201f07c4cd6',
      siloUsdeRaw: '39914389141714085071203333',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T00:10:31.064Z',
      pairedReadCompletedAt: '2026-10-08T00:10:32.652Z',
      availableAt: '2026-10-08T00:10:33.139Z',
      provenance: {
        inputId: 'legacy-116-119',
        originalFileSha256: 'ddbc18b04950932b649145ddb5d289e9f0cf59e55cdd337e998ce7dac1c7c853',
        originalCaptureFileSha256:
          'a32bfd031f89ff118aaae899ee8e11e9a30288c797a1bd40744eb930a426f14e',
        originalNativePlanSha256:
          '4ae0217d542e943f04880782af2b1a6c801db407672ff5606cf3dc0242f5ea43',
        withinCaptureIndex: 1,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T00:10:31.064Z',
          completedAt: '2026-10-08T00:10:31.415Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T00:10:32.441Z',
          completedAt: '2026-10-08T00:10:32.652Z',
        },
      ],
    },
    {
      index: 118,
      blockNumber: '26100913',
      blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
      sourceAt: '2026-10-01T23:59:59.000Z',
      vaultUsdeRaw: '1256086455940514932066787384',
      anchorAt: '2026-10-02T00:00:00.000Z',
      oldReadAt: '2026-10-05T10:57:29.991Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'dc9ecd89dbe3eb7b96ac780c75c6833dbaefb52ae37a2a7cdd1f77d816dd5307',
      siloUsdeRaw: '17354430845212029574792495',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T00:10:31.421Z',
      pairedReadCompletedAt: '2026-10-08T00:10:32.935Z',
      availableAt: '2026-10-08T00:10:33.139Z',
      provenance: {
        inputId: 'legacy-116-119',
        originalFileSha256: 'ddbc18b04950932b649145ddb5d289e9f0cf59e55cdd337e998ce7dac1c7c853',
        originalCaptureFileSha256:
          'a32bfd031f89ff118aaae899ee8e11e9a30288c797a1bd40744eb930a426f14e',
        originalNativePlanSha256:
          '4ae0217d542e943f04880782af2b1a6c801db407672ff5606cf3dc0242f5ea43',
        withinCaptureIndex: 2,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T00:10:31.421Z',
          completedAt: '2026-10-08T00:10:31.741Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T00:10:32.652Z',
          completedAt: '2026-10-08T00:10:32.935Z',
        },
      ],
    },
    {
      index: 119,
      blockNumber: '26108081',
      blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
      sourceAt: '2026-10-02T23:59:59.000Z',
      vaultUsdeRaw: '1251252340494661426761783289',
      anchorAt: '2026-10-03T00:00:00.000Z',
      oldReadAt: '2026-10-05T10:57:37.472Z',
      oldAvailableAt: '2026-10-05T10:57:37.472Z',
      receiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      siloUsdeRaw: '20831458906481737687655564',
      cooldownDurationSeconds: '86400',
      pairedReadStartedAt: '2026-10-08T00:10:31.744Z',
      pairedReadCompletedAt: '2026-10-08T00:10:33.138Z',
      availableAt: '2026-10-08T00:10:33.139Z',
      provenance: {
        inputId: 'legacy-116-119',
        originalFileSha256: 'ddbc18b04950932b649145ddb5d289e9f0cf59e55cdd337e998ce7dac1c7c853',
        originalCaptureFileSha256:
          'a32bfd031f89ff118aaae899ee8e11e9a30288c797a1bd40744eb930a426f14e',
        originalNativePlanSha256:
          '4ae0217d542e943f04880782af2b1a6c801db407672ff5606cf3dc0242f5ea43',
        withinCaptureIndex: 3,
      },
      acquisitionByOrigin: [
        {
          origin: 'https://eth-mainnet.g.alchemy.com',
          startedAt: '2026-10-08T00:10:31.744Z',
          completedAt: '2026-10-08T00:10:32.043Z',
        },
        {
          origin: 'https://rpc.ankr.com',
          startedAt: '2026-10-08T00:10:32.937Z',
          completedAt: '2026-10-08T00:10:33.138Z',
        },
      ],
    },
  ],
  missingIndices: [
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
    44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67,
    68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91,
    92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
    113, 114, 115,
  ],
  gaps: [
    {
      fromIndex: 19,
      toIndex: 116,
      elapsedSeconds: 8380800,
      missingIndices: [
        20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
        43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
        66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
        89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
        109, 110, 111, 112, 113, 114, 115,
      ],
      reason: 'not_adjacent_daily_native_observations',
    },
  ],
  dailyDonorCount: 22,
  plannedPointCount: 120,
  actualPointCount: 24,
  interpretation: 'paired_correlated_NET_stocks_not_grossflows_holder_E_or_queue_Q',
})
export const SUSDE_JOINT_HISTORY_EVIDENCE_SET_PIN = canonical
export function susdePinnedJointHistoryEvidenceSet(): SusdeJointHistoryEvidenceSet {
  return structuredClone(canonical)
}
