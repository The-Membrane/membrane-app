/**
 * keccak256 (the Ethereum variant: 0x01 padding, not SHA3's 0x06).
 *
 * Dependency-free on purpose: the manipulation engine runs from a bare checkout (no
 * node_modules) in the build script and the fork tests. Throughput is irrelevant here
 * (selectors, topics and Morpho market ids are hashed a few thousand times per build),
 * so the state is 25 BigInt lanes rather than a 32-bit-halves implementation.
 */

const MASK = (1n << 64n) - 1n

const RC: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

// ROT[x][y]: rho offsets for lane (x, y).
const ROT: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
]

const rotl = (v: bigint, n: number): bigint =>
  n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK

function keccakF(a: bigint[]): void {
  const c = new Array<bigint>(5)
  const b = new Array<bigint>(25)
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x][y])
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 25; y += 5) a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y])
    }
    a[0] ^= RC[round]
  }
}

const RATE = 136

export function keccak256Bytes(data: Uint8Array): Uint8Array {
  const padLen = RATE - (data.length % RATE)
  const msg = new Uint8Array(data.length + padLen)
  msg.set(data)
  msg[data.length] ^= 0x01
  msg[msg.length - 1] ^= 0x80
  const a = new Array<bigint>(25).fill(0n)
  for (let off = 0; off < msg.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + k])
      a[i] ^= lane
    }
    keccakF(a)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    let lane = a[i]
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn)
      lane >>= 8n
    }
  }
  return out
}

export const bytesToHex = (b: Uint8Array): `0x${string}` => {
  let s = '0x'
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s as `0x${string}`
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length % 2) throw new Error(`hexToBytes: odd length ${h.length}`)
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** keccak256 of a 0x-hex string (bytes) or, with `utf8`, of a text string. */
export function keccak256(input: string, enc: 'hex' | 'utf8' = 'hex'): `0x${string}` {
  const bytes = enc === 'utf8' ? new TextEncoder().encode(input) : hexToBytes(input)
  return bytesToHex(keccak256Bytes(bytes))
}

const selectorCache = new Map<string, `0x${string}`>()
/** 4-byte selector of a canonical signature such as `balanceOf(address)`. */
export function selector(sig: string): `0x${string}` {
  let s = selectorCache.get(sig)
  if (!s) {
    s = keccak256(sig, 'utf8').slice(0, 10) as `0x${string}`
    selectorCache.set(sig, s)
  }
  return s
}

/** 32-byte event topic of a canonical event signature. */
export const topic = (sig: string): `0x${string}` => keccak256(sig, 'utf8')
