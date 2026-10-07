/**
 * Event catalog + a minimal ABI decoder for the curator action feed. Pure, no I/O.
 *
 * Every signature below is copied from the deployed contracts' source (fetched
 * 2026-10-07):
 *   MetaMorpho v1.0 / v1.1  morpho-org/metamorpho{,-v1.1} src/libraries/EventsLib.sol
 *   Vault V2                morpho-org/vault-v2 src/libraries/EventsLib.sol,
 *                           src/interfaces/IVaultV2Factory.sol
 *   Public Allocator        morpho-org/public-allocator src/libraries/EventsLib.sol
 *   Euler Earn              euler-xyz/euler-earn src/libraries/EventsLib.sol
 *   Aave v3 PoolConfigurator aave-dao/aave-v3-origin src/contracts/interfaces/IPoolConfigurator.sol
 *   Morpho Blue             morpho-org/morpho-blue src/libraries/EventsLib.sol
 * `Id` is bytes32 and `IERC4626` is address in the canonical signature, so Euler Earn's
 * SubmitCap(address,address,uint256) has a different topic0 from MetaMorpho's
 * SubmitCap(address,bytes32,uint256). Some config events (SetCurator, SetIsAllocator,
 * SetTimelock, …) share one topic0 across MetaMorpho, Euler Earn and Vault V2; the
 * emitter's verified kind decides which protocol it belongs to.
 *
 * The topic0 hex is written out (not computed at load) so it can be grepped; the unit
 * test recomputes each one with keccak.ts.
 */

export type EmitterKind =
  | 'mm'
  | 'v2'
  | 'ee'
  | 'pa'
  | 'eepa'
  | 'aave'
  | 'blue'
  | 'mmFactory'
  | 'v2Factory'
  | 'eeFactory'

export type AbiType =
  | 'address'
  | 'uint256'
  | 'int256'
  | 'bool'
  | 'bytes32'
  | 'bytes4'
  | 'bytes'
  | 'string'
  | 'bytes32[]'
  | 'address[]'
  | '(address,address,address,address,uint256)'

export interface AbiInput {
  name: string
  type: AbiType
  indexed: boolean
}

export interface EventDef {
  /** Event name as declared, e.g. "SubmitCap". */
  name: string
  /** Canonical signature, e.g. "SubmitCap(address,bytes32,uint256)". */
  sig: string
  topic0: string
  inputs: AbiInput[]
  /** Emitter kinds that declare this exact signature. */
  kinds: EmitterKind[]
}

/** Parse "Name(type indexed name, type name)" → name + inputs. */
export function parseEventSignature(human: string): { name: string; inputs: AbiInput[] } {
  const m = human.match(/^(\w+)\((.*)\)$/)
  if (!m) throw new Error(`bad event signature: ${human}`)
  const body = m[2].trim()
  const inputs: AbiInput[] = []
  if (body) {
    // Tuples are written without inner spaces, so a plain comma split at depth 0 works.
    let depth = 0
    let cur = ''
    const parts: string[] = []
    for (const ch of body) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) {
        parts.push(cur)
        cur = ''
      } else cur += ch
    }
    parts.push(cur)
    for (const p of parts) {
      const toks = p.trim().split(/\s+/)
      const type = toks[0] as AbiType
      const indexed = toks.includes('indexed')
      const name =
        toks.length > 1 && toks[toks.length - 1] !== 'indexed' ? toks[toks.length - 1] : ''
      inputs.push({ name, type, indexed })
    }
  }
  return { name: m[1], inputs }
}

export const canonicalSignature = (name: string, inputs: AbiInput[]): string =>
  `${name}(${inputs.map((i) => i.type).join(',')})`

const def = (kinds: EmitterKind[], human: string, topic0: string): EventDef => {
  const { name, inputs } = parseEventSignature(human)
  return { name, sig: canonicalSignature(name, inputs), topic0, inputs, kinds }
}

const VAULTS: EmitterKind[] = ['mm', 'ee', 'v2']
const V1LIKE: EmitterKind[] = ['mm', 'ee']

export const EVENTS: EventDef[] = [
  // ── MetaMorpho v1.0 / v1.1 (Id = bytes32) ────────────────────────────────────
  def(
    ['mm'],
    'SubmitCap(address indexed caller, bytes32 indexed id, uint256 cap)',
    '0xe851bb5856808a50efd748be463b8f35bcfb5ec74c5bfde776fe0a4d2a26db27',
  ),
  def(
    ['mm'],
    'SetCap(address indexed caller, bytes32 indexed id, uint256 cap)',
    '0xe86b6d3313d3098f4c5f689c935de8fde876a597c185def2cedab85efedac686',
  ),
  def(
    ['mm'],
    'RevokePendingCap(address indexed caller, bytes32 indexed id)',
    '0x1026ceca5ed3747eb5edec555732d4a6f901ce1a875ecf981064628cadde1120',
  ),
  def(
    ['mm'],
    'SubmitMarketRemoval(address indexed caller, bytes32 indexed id)',
    '0x3240fc70754c5a2b4dab10bf7081a00024bfc8491581ee3d355360ec0dd91f16',
  ),
  def(
    ['mm'],
    'RevokePendingMarketRemoval(address indexed caller, bytes32 indexed id)',
    '0xcbeb8ecdaa5a3c133e62219b63bfc35bce3fda13065d2bed32e3b7dde60a59f4',
  ),
  def(
    ['mm'],
    'SetSupplyQueue(address indexed caller, bytes32[] newSupplyQueue)',
    '0x6ce31538fc7fba95714ddc8a275a09252b4b1fb8f33d2550aa58a5f62ad934de',
  ),
  def(
    ['mm'],
    'SetWithdrawQueue(address indexed caller, bytes32[] newWithdrawQueue)',
    '0xe0c2db6b54586be6d7d49943139fccf0dd315ba63e55364a76c73cd8fdba724d',
  ),
  def(
    ['mm'],
    'ReallocateSupply(address indexed caller, bytes32 indexed id, uint256 suppliedAssets, uint256 suppliedShares)',
    '0x89bf199df65bf65155e3e0a8abc4ad4a1be606220c8295840dba2ab5656c1f6d',
  ),
  def(
    ['mm'],
    'ReallocateWithdraw(address indexed caller, bytes32 indexed id, uint256 withdrawnAssets, uint256 withdrawnShares)',
    '0xdd8bf5226dff861316e0fa7863fdb7dc7b87c614eb29a135f524eb79d5a1189a',
  ),
  // ── shared by MetaMorpho, Euler Earn (and some by Vault V2) ──────────────────
  def(
    V1LIKE,
    'SubmitTimelock(uint256 newTimelock)',
    '0xb3aa0ade2442acf51d06713c2d1a5a3ec0373cce969d42b53f4689f97bccf380',
  ),
  def(
    V1LIKE,
    'SetTimelock(address indexed caller, uint256 newTimelock)',
    '0xd28e9b90ee9b37c5936ff84392d71f29ff18117d7e76bcee60615262a90a3f75',
  ),
  def(
    V1LIKE,
    'RevokePendingTimelock(address indexed caller)',
    '0x921828337692c347c634c5d2aacbc7b756014674bd236f3cc2058d8e284a951b',
  ),
  def(
    VAULTS,
    'SetCurator(address indexed newCurator)',
    '0xbd0a63c12948fbc9194a5839019f99c9d71db924e5c70018265bc778b8f1a506',
  ),
  def(
    VAULTS,
    'SetIsAllocator(address indexed allocator, bool isAllocator)',
    '0x74dc60cbc81a9472d04ad1d20e151d369c41104d655ed3f2f3091166a502cd8d',
  ),
  def(
    V1LIKE,
    'SubmitGuardian(address indexed newGuardian)',
    '0x7633313af54753bce8a149927263b1a55eba857ba4ef1d13c6aee25d384d3c4b',
  ),
  def(
    V1LIKE,
    'SetGuardian(address indexed caller, address indexed guardian)',
    '0xcb11cc8aade2f5a556749d1b2380d108a16fac3431e6a5d5ce12ef9de0bd76e3',
  ),
  def(
    V1LIKE,
    'RevokePendingGuardian(address indexed caller)',
    '0xc40a085ccfa20f5fd518ade5c3a77a7ecbdfbb4c75efcdca6146a8e3c841d663',
  ),
  def(
    V1LIKE,
    'OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
    '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',
  ),
  // ── Vault V2 ─────────────────────────────────────────────────────────────────
  def(
    ['v2'],
    'Submit(bytes4 indexed selector, bytes data, uint256 executableAt)',
    '0x8b18afeb361b83b025999ed5b42f1d90c68aaa5a0fd49c015f04c3b8b81e80eb',
  ),
  def(
    ['v2'],
    'Accept(bytes4 indexed selector, bytes data)',
    '0x29aa42fc192ff77ef42105abba283197ac841341e196e417a7fc2784cdc4e5fb',
  ),
  def(
    ['v2'],
    'Revoke(address indexed sender, bytes4 indexed selector, bytes data)',
    '0x70521cf6a7c2458c5ad406081ad7b3bc4afd31b01b586a157a9780fcee6a77cb',
  ),
  def(
    ['v2'],
    'IncreaseAbsoluteCap(bytes32 indexed id, bytes idData, uint256 newAbsoluteCap)',
    '0x7368d59ed82f6a538f6deef9baa54623fe3699ce07b19031f762f740c8c34b03',
  ),
  def(
    ['v2'],
    'DecreaseAbsoluteCap(address indexed sender, bytes32 indexed id, bytes idData, uint256 newAbsoluteCap)',
    '0xbc2ffe81312f53db4f327eca188ebdc13df66a8ce25f7dec6f5b4495fe27b371',
  ),
  def(
    ['v2'],
    'IncreaseRelativeCap(bytes32 indexed id, bytes idData, uint256 newRelativeCap)',
    '0x2a343b9a1ceba40853d01c6adeea53f5c0e4b95b4eb870ed4af309a0ead7e399',
  ),
  def(
    ['v2'],
    'DecreaseRelativeCap(address indexed sender, bytes32 indexed id, bytes idData, uint256 newRelativeCap)',
    '0xcedce6ffe8b7f89de49bd4f955667ca0a963a8059264196807b240ed470b25ce',
  ),
  def(
    ['v2'],
    'Allocate(address indexed sender, address indexed adapter, uint256 assets, bytes32[] ids, int256 change)',
    '0x2bc7948a96a066968d2a58aaf46eb0b305aa166b1d1951d2f7ef0919746b8c2a',
  ),
  def(
    ['v2'],
    'Deallocate(address indexed sender, address indexed adapter, uint256 assets, bytes32[] ids, int256 change)',
    '0xd602b36fb24934aef1bc2a658de029b486fa4c664a6e45de1f48e3fd1be25dd9',
  ),
  def(
    ['v2'],
    'ForceDeallocate(address indexed sender, address adapter, uint256 assets, address indexed onBehalf, bytes32[] ids, uint256 penaltyAssets)',
    '0xb98216be0267fa550428a584fe6ac1ef0f39788e0198372100e813444afecd29',
  ),
  def(
    ['v2'],
    'AddAdapter(address indexed account)',
    '0x8f125a24838c4c23e893904b255b5c672d43d4cb8af7e3d15841eaeabc1e68aa',
  ),
  def(
    ['v2'],
    'RemoveAdapter(address indexed account)',
    '0x34f33faa2592bc1f615ec3e91b55b7784665ce46461403c294824d85f9f66458',
  ),
  def(
    ['v2'],
    'SetOwner(address indexed newOwner)',
    '0x167d3e9c1016ab80e58802ca9da10ce5c6a0f4debc46a2e7a2cd9e56899a4fb5',
  ),
  def(
    ['v2'],
    'SetIsSentinel(address indexed account, bool newIsSentinel)',
    '0x8da69db4003c01b5c7be66a7bb5953423222e5118b6af0aadf54e75feef5bc50',
  ),
  def(
    ['v2'],
    'IncreaseTimelock(bytes4 indexed selector, uint256 newDuration)',
    '0xed380a7a1f0afc99b313ac7d9f1e52e44430d32b4639c7993bd0021974e30c0e',
  ),
  def(
    ['v2'],
    'DecreaseTimelock(bytes4 indexed selector, uint256 newDuration)',
    '0x488e0bfafe0a9580c2271bee1f563a47d309f0105ca950ea525d909b43b36daf',
  ),
  def(
    ['v2'],
    'Abdicate(bytes4 indexed selector)',
    '0xa8480b135a28741e8c059528bf8f82de70278485fb86bfc816a183801f0a8570',
  ),
  // ── Morpho Public Allocator (one singleton; `vault` is indexed) ──────────────
  def(
    ['pa'],
    'PublicWithdrawal(address indexed sender, address indexed vault, bytes32 indexed id, uint256 withdrawnAssets)',
    '0x6218cdb9e8efb3d0e8136d32c91d9446eaf19e2e486bc67dfcb3d574ca60d504',
  ),
  def(
    ['pa'],
    'PublicReallocateTo(address indexed sender, address indexed vault, bytes32 indexed supplyMarketId, uint256 suppliedAssets)',
    '0xf8ae80b0854dfc3c73d3eb4b6160df1996a5859e6c1d11d10f3980a7f4691991',
  ),
  // ── Euler Earn (IERC4626 strategy = address) ─────────────────────────────────
  def(
    ['ee'],
    'SubmitCap(address indexed caller, address indexed id, uint256 cap)',
    '0x7bfc48861a5d71fc7afd7b9c92b4feeef1628ab1d5145dede52590c46dd155e9',
  ),
  def(
    ['ee'],
    'SetCap(address indexed caller, address indexed id, uint256 cap)',
    '0x10dbbfa98a21bc7a80d86cb89391600c590e0e2ce25698013741bcad42956569',
  ),
  def(
    ['ee'],
    'RevokePendingCap(address indexed caller, address indexed id)',
    '0x23edd264f2dcc193d13a29cdab4ac169d60d9b4a0e74f0303c753036d8eb1c13',
  ),
  def(
    ['ee'],
    'SubmitMarketRemoval(address indexed caller, address indexed id)',
    '0x354f25f4208ab6528fb2d016019c0e2a66f51376cbb2cc8571064779735d3485',
  ),
  def(
    ['ee'],
    'RevokePendingMarketRemoval(address indexed caller, address indexed id)',
    '0x8387c3346650400a72032f8bd1aa3f5f44038cf2bf32945e8eeb8a498decea77',
  ),
  def(
    ['ee'],
    'SetSupplyQueue(address indexed caller, address[] newSupplyQueue)',
    '0xb07686dd0abe7422b9801e8f38bafd24669a65591071f11120c2f6a7c175813e',
  ),
  def(
    ['ee'],
    'SetWithdrawQueue(address indexed caller, address[] newWithdrawQueue)',
    '0x834ae37621cd31f2636b1cb6f1bded844d79ecf755af866b5d896da642d7b567',
  ),
  def(
    ['ee'],
    'ReallocateSupply(address indexed caller, address indexed id, uint256 suppliedAssets, uint256 suppliedShares)',
    '0x73e8a9d66522fa5c6fcec2e89aad8e52f6f66eadeb7fc7c172cfcbacb5283851',
  ),
  def(
    ['ee'],
    'ReallocateWithdraw(address indexed caller, address indexed id, uint256 withdrawnAssets, uint256 withdrawnShares)',
    '0x416d9fcbb15941508bf9f557a950fb085de673ae90db45a32efdc9b35f29b0f1',
  ),
  def(
    ['eepa'],
    'PublicWithdrawal(address indexed sender, address indexed vault, address indexed id, uint256 withdrawnAssets)',
    '0x78b2730a7ba1e3759ea2e3c385e57f33707440fd42c9eda192070d7da0088387',
  ),
  def(
    ['eepa'],
    'PublicReallocateTo(address indexed sender, address indexed vault, address indexed supplyId, uint256 suppliedAssets)',
    '0x4d8dc135b6ebc05d8f601ac5b4ea2029a2dc67a78c791053e7d4b252e78a4097',
  ),
  // ── Aave v3 PoolConfigurator (protocol-level analogues) ──────────────────────
  def(
    ['aave'],
    'SupplyCapChanged(address indexed asset, uint256 oldSupplyCap, uint256 newSupplyCap)',
    '0x0263602682188540a2d633561c0b4453b7d8566285e99f9f6018b8ef2facef49',
  ),
  def(
    ['aave'],
    'BorrowCapChanged(address indexed asset, uint256 oldBorrowCap, uint256 newBorrowCap)',
    '0xc51aca575985d521c5072ad11549bad77013bb786d57f30f94b40ed8f8dc9bc4',
  ),
  def(
    ['aave'],
    'CollateralConfigurationChanged(address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)',
    '0x637febbda9275aea2e85c0ff690444c8d87eb2e8339bbede9715abcc89cb0995',
  ),
  def(
    ['aave'],
    'ReserveFrozen(address indexed asset, bool frozen)',
    '0x0c4443d258a350d27dc50c378b2ebf165e6469725f786d21b30cab16823f5587',
  ),
  def(
    ['aave'],
    'ReservePaused(address indexed asset, bool paused)',
    '0xe188d542a5f11925d3a3af33703cdd30a43cb3e8066a3cf68b1b57f61a5a94b5',
  ),
  def(
    ['aave'],
    'ReserveBorrowing(address indexed asset, bool enabled)',
    '0x2443ba28e8d1d88d531a3d90b981816a4f3b3c7f1fd4085c6029e81d1b7a570d',
  ),
  // ── factories + Morpho Blue (enumeration / enrichment, not feed rows) ────────
  def(
    ['mmFactory'],
    'CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)',
    '0xed8c95d05909b0f217f3e68171ef917df4b278d5addfe4dda888e90279be7d1d',
  ),
  def(
    ['v2Factory'],
    'CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)',
    '0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e',
  ),
  def(
    ['eeFactory'],
    'CreateEulerEarn(address indexed eulerEarn, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)',
    '0x2ecfce4fdb2055c9639b56f59c2a14eeafce06a51d93d898155bc11b6141896f',
  ),
  def(
    ['blue'],
    'CreateMarket(bytes32 indexed id, (address,address,address,address,uint256) marketParams)',
    '0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac',
  ),
  def(
    ['blue'],
    'AccrueInterest(bytes32 indexed id, uint256 prevBorrowRate, uint256 interest, uint256 feeShares)',
    '0x9d9bd501d0657d7dfe415f779a620a62b78bc508ddc0891fbbd8b7ac0f8fce87',
  ),
]

/** (kind, topic0) → definition. A shared topic0 resolves per emitter kind. */
const BY_KIND_TOPIC = new Map<string, EventDef>()
for (const e of EVENTS) for (const k of e.kinds) BY_KIND_TOPIC.set(`${k}:${e.topic0}`, e)

export const eventFor = (kind: EmitterKind, topic0: string): EventDef | undefined =>
  BY_KIND_TOPIC.get(`${kind}:${topic0.toLowerCase()}`)

/** Every topic0 a given emitter kind can produce — the OR-list for one getLogs filter. */
export const topicsFor = (kind: EmitterKind): string[] => [
  ...new Set(EVENTS.filter((e) => e.kinds.includes(kind)).map((e) => e.topic0)),
]

export const eventByName = (kind: EmitterKind, name: string): EventDef => {
  const e = EVENTS.find((x) => x.kinds.includes(kind) && x.name === name)
  if (!e) throw new Error(`no ${kind} event ${name}`)
  return e
}

// ── Vault V2 timelocked functions (selector of Submit/Accept/Revoke `data`) ─────

export const V2_SELECTORS: Record<string, string> = {
  '0xf6f98fd5': 'increaseAbsoluteCap(bytes,uint256)',
  '0x2438525b': 'increaseRelativeCap(bytes,uint256)',
  '0x8c54519b': 'decreaseAbsoluteCap(bytes,uint256)',
  '0x57975270': 'decreaseRelativeCap(bytes,uint256)',
  '0x60d54d41': 'addAdapter(address)',
  '0x585cd34b': 'removeAdapter(address)',
  '0xb192a84a': 'setIsAllocator(address,bool)',
  '0x47966291': 'increaseTimelock(bytes4,uint256)',
  '0x5c1a1a4f': 'decreaseTimelock(bytes4,uint256)',
  '0xb2e32848': 'abdicate(bytes4)',
  '0x2cb19f98': 'setReceiveSharesGate(address)',
  '0xc21ad028': 'setSendSharesGate(address)',
  '0x04dbf0ce': 'setReceiveAssetsGate(address)',
  '0x871c979c': 'setSendAssetsGate(address)',
  '0x5b34b823': 'setAdapterRegistry(address)',
  '0x70897b23': 'setPerformanceFee(uint256)',
  '0xfe56e232': 'setManagementFee(uint256)',
  '0x6a5f1aa2': 'setPerformanceFeeRecipient(address)',
  '0x9faae464': 'setManagementFeeRecipient(address)',
  '0x3e9d2ac7': 'setForceDeallocatePenalty(address,uint256)',
  '0xaa4abe7f': 'setMaxRate(uint256)',
}

// ── decoder ────────────────────────────────────────────────────────────────────

export type AbiValue = string | bigint | boolean | AbiValue[]

const strip = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h)
const word = (hex: string, i: number): string => {
  const w = hex.slice(i * 64, i * 64 + 64)
  if (w.length !== 64) throw new Error(`abi: read past end at word ${i}`)
  return w
}
const wordAt = (hex: string, byteOffset: number): string => {
  if (byteOffset % 32 !== 0) throw new Error(`abi: unaligned offset ${byteOffset}`)
  return word(hex, byteOffset / 32)
}

const toAddress = (w: string): string => '0x' + w.slice(24).toLowerCase()
const toUint = (w: string): bigint => BigInt('0x' + w)
const toInt = (w: string): bigint => {
  const u = BigInt('0x' + w)
  return u >= 1n << 255n ? u - (1n << 256n) : u
}

function decodeStatic(type: AbiType, w: string): AbiValue {
  switch (type) {
    case 'address':
      return toAddress(w)
    case 'uint256':
      return toUint(w)
    case 'int256':
      return toInt(w)
    case 'bool':
      return toUint(w) !== 0n
    case 'bytes32':
      return '0x' + w.toLowerCase()
    case 'bytes4':
      return '0x' + w.slice(0, 8).toLowerCase()
    default:
      throw new Error(`abi: ${type} is not a static word type`)
  }
}

const isDynamic = (t: AbiType): boolean => t === 'bytes' || t === 'string' || t.endsWith('[]')
const headWords = (t: AbiType): number => (t.startsWith('(') ? t.slice(1, -1).split(',').length : 1)

/** Decode non-indexed parameters from log `data` (or return data). */
export function decodeParams(types: AbiType[], data: string): AbiValue[] {
  const hex = strip(data)
  const out: AbiValue[] = []
  let w = 0
  for (const t of types) {
    if (isDynamic(t)) {
      const off = Number(toUint(word(hex, w)))
      w++
      const len = Number(toUint(wordAt(hex, off)))
      const body = off + 32
      if (t === 'bytes' || t === 'string') {
        const raw = hex.slice(body * 2, body * 2 + len * 2)
        if (raw.length !== len * 2) throw new Error('abi: bytes past end')
        out.push(
          t === 'string' ? new TextDecoder().decode(hexBytes(raw)) : '0x' + raw.toLowerCase(),
        )
      } else {
        const elem = t.slice(0, -2) as AbiType
        const arr: AbiValue[] = []
        for (let i = 0; i < len; i++) arr.push(decodeStatic(elem, wordAt(hex, body + i * 32)))
        out.push(arr)
      }
    } else if (t.startsWith('(')) {
      const comps = t.slice(1, -1).split(',') as AbiType[]
      out.push(comps.map((c, i) => decodeStatic(c, word(hex, w + i))))
      w += headWords(t)
    } else {
      out.push(decodeStatic(t, word(hex, w)))
      w++
    }
  }
  return out
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** An indexed topic → value. Dynamic indexed types arrive as their keccak hash. */
export function decodeTopic(type: AbiType, topic: string): AbiValue {
  const w = strip(topic).padStart(64, '0')
  if (isDynamic(type) || type.startsWith('(')) return '0x' + w.toLowerCase()
  return decodeStatic(type, w)
}

export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: number
  logIndex: number
  transactionHash: string
  /** Unix seconds. */
  timestamp: number
}

/** Decode one log against a known definition → named args. Throws on malformed data. */
export function decodeLogArgs(
  e: EventDef,
  log: Pick<RawLog, 'topics' | 'data'>,
): Record<string, AbiValue> {
  const args: Record<string, AbiValue> = {}
  const indexed = e.inputs.filter((i) => i.indexed)
  if (log.topics.length !== indexed.length + 1)
    throw new Error(
      `abi: ${e.sig} expects ${indexed.length} indexed topics, got ${log.topics.length - 1}`,
    )
  indexed.forEach((inp, i) => (args[inp.name] = decodeTopic(inp.type, log.topics[i + 1])))
  const plain = e.inputs.filter((i) => !i.indexed)
  const vals = decodeParams(
    plain.map((p) => p.type),
    log.data,
  )
  plain.forEach((inp, i) => (args[inp.name] = vals[i]))
  return args
}

// ── encoder (static args only — enough for view calls) ───────────────────────

export type StaticArg = {
  type: 'address' | 'uint256' | 'bytes32' | 'bool'
  value: string | bigint | boolean
}

export function encodeStatic(args: StaticArg[]): string {
  return args
    .map((a) => {
      switch (a.type) {
        case 'address':
          return strip(String(a.value)).toLowerCase().padStart(64, '0')
        case 'bytes32':
          return strip(String(a.value)).toLowerCase().padEnd(64, '0')
        case 'bool':
          return (a.value ? 1n : 0n).toString(16).padStart(64, '0')
        case 'uint256':
          return BigInt(a.value as bigint)
            .toString(16)
            .padStart(64, '0')
      }
    })
    .join('')
}
