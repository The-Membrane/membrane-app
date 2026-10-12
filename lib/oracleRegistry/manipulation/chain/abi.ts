/**
 * A small Solidity ABI codec: enough for view calls, Multicall3 and event logs.
 *
 * Types are written as Solidity type strings: `uint256`, `address[]`, `(address,uint256)`,
 * `(bool,bytes)[]`. Values: uintN/intN → bigint, address → lowercase 0x string, bool →
 * boolean, bytes/bytesN → 0x string, string → string, arrays and tuples → JS arrays.
 */

import { selector } from './keccak'

export type Hex = `0x${string}`

export type AbiType =
  | { kind: 'uint' | 'int'; bits: number }
  | { kind: 'address' }
  | { kind: 'bool' }
  | { kind: 'fixedBytes'; size: number }
  | { kind: 'bytes' }
  | { kind: 'string' }
  | { kind: 'array'; of: AbiType; length: number | null }
  | { kind: 'tuple'; items: AbiType[] }

// Values are deliberately loose (`any`): decoded shapes are fixed by the type string,
// and every call site destructures with the shape it asked for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AbiValue = any

/** Split a comma list at depth 0 (tuples nest). */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim())
}

export function parseType(raw: string): AbiType {
  const s = raw.trim()
  const arr = s.match(/^(.*)\[(\d*)\]$/)
  if (arr) return { kind: 'array', of: parseType(arr[1]), length: arr[2] === '' ? null : Number(arr[2]) }
  if (s.startsWith('(')) {
    if (!s.endsWith(')')) throw new Error(`abi: bad tuple ${s}`)
    const inner = s.slice(1, -1)
    return { kind: 'tuple', items: inner.trim() === '' ? [] : splitTop(inner).map(parseType) }
  }
  // Drop a trailing parameter name (`address owner`) if present.
  const t = s.split(/\s+/)[0]
  if (t === 'address') return { kind: 'address' }
  if (t === 'bool') return { kind: 'bool' }
  if (t === 'string') return { kind: 'string' }
  if (t === 'bytes') return { kind: 'bytes' }
  const fb = t.match(/^bytes(\d+)$/)
  if (fb) return { kind: 'fixedBytes', size: Number(fb[1]) }
  const n = t.match(/^(u?int)(\d*)$/)
  if (n) return { kind: n[1] === 'uint' ? 'uint' : 'int', bits: n[2] ? Number(n[2]) : 256 }
  throw new Error(`abi: unsupported type ${s}`)
}

const parseList = (s: string): AbiType[] => {
  const t = parseType(s.trim().startsWith('(') ? s : `(${s})`)
  return t.kind === 'tuple' ? t.items : [t]
}

function isDynamic(t: AbiType): boolean {
  if (t.kind === 'bytes' || t.kind === 'string') return true
  if (t.kind === 'array') return t.length === null || isDynamic(t.of)
  if (t.kind === 'tuple') return t.items.some(isDynamic)
  return false
}

/** Static head size in 32-byte words. */
function headWords(t: AbiType): number {
  if (isDynamic(t)) return 1
  if (t.kind === 'array') return (t.length ?? 0) * headWords(t.of)
  if (t.kind === 'tuple') return t.items.reduce((a, x) => a + headWords(x), 0)
  return 1
}

const word = (v: bigint): string => {
  const x = v < 0n ? (1n << 256n) + v : v
  return x.toString(16).padStart(64, '0')
}

function encodeOne(t: AbiType, v: AbiValue): string {
  switch (t.kind) {
    case 'uint':
    case 'int':
      return word(BigInt(v))
    case 'address':
      return String(v).toLowerCase().replace(/^0x/, '').padStart(64, '0')
    case 'bool':
      return word(v ? 1n : 0n)
    case 'fixedBytes':
      return String(v).replace(/^0x/, '').padEnd(64, '0')
    case 'bytes':
    case 'string': {
      const hex =
        t.kind === 'string'
          ? Array.from(new TextEncoder().encode(String(v)), (b) => b.toString(16).padStart(2, '0')).join('')
          : String(v).replace(/^0x/, '')
      const len = hex.length / 2
      const padded = hex.padEnd(Math.ceil(len / 32) * 64, '0')
      return word(BigInt(len)) + padded
    }
    case 'array': {
      const items = v as AbiValue[]
      const body = encodeTuple(new Array(items.length).fill(t.of), items)
      return t.length === null ? word(BigInt(items.length)) + body : body
    }
    case 'tuple':
      return encodeTuple(t.items, v as AbiValue[])
  }
}

function encodeTuple(types: AbiType[], values: AbiValue[]): string {
  if (types.length !== values.length) throw new Error(`abi: ${types.length} types, ${values.length} values`)
  const heads: string[] = []
  const tails: string[] = []
  let offset = types.reduce((a, t) => a + headWords(t), 0) * 32
  types.forEach((t, i) => {
    const enc = encodeOne(t, values[i])
    if (isDynamic(t)) {
      heads.push(word(BigInt(offset)))
      tails.push(enc)
      offset += enc.length / 2
    } else heads.push(enc)
  })
  return heads.join('') + tails.join('')
}

export function encodeAbi(types: string | AbiType[], values: AbiValue[]): Hex {
  const ts = typeof types === 'string' ? parseList(types) : types
  return `0x${encodeTuple(ts, values)}`
}

function readWord(data: string, byteOff: number): bigint {
  const s = data.slice(byteOff * 2, byteOff * 2 + 64)
  if (s.length < 64) throw new Error(`abi: read past end at ${byteOff} (len ${data.length / 2})`)
  return BigInt(`0x${s}`)
}

function decodeOne(t: AbiType, data: string, base: number, headOff: number): AbiValue {
  if (isDynamic(t)) {
    const rel = Number(readWord(data, headOff))
    return decodeAt(t, data, base + rel)
  }
  return decodeAt(t, data, headOff)
}

function decodeAt(t: AbiType, data: string, off: number): AbiValue {
  switch (t.kind) {
    case 'uint': {
      const v = readWord(data, off)
      return t.bits < 256 ? v & ((1n << BigInt(t.bits)) - 1n) : v
    }
    case 'int': {
      let v = readWord(data, off)
      if (v >> 255n) v -= 1n << 256n
      return v
    }
    case 'address':
      return `0x${data.slice(off * 2 + 24, off * 2 + 64)}`
    case 'bool':
      return readWord(data, off) !== 0n
    case 'fixedBytes':
      return `0x${data.slice(off * 2, off * 2 + t.size * 2)}`
    case 'bytes':
    case 'string': {
      const len = Number(readWord(data, off))
      const hex = data.slice((off + 32) * 2, (off + 32 + len) * 2)
      if (t.kind === 'bytes') return `0x${hex}`
      const bytes = new Uint8Array(hex.length / 2)
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      return new TextDecoder().decode(bytes)
    }
    case 'array': {
      let n = t.length
      let start = off
      if (n === null) {
        n = Number(readWord(data, off))
        start = off + 32
      }
      return decodeTuple(new Array(n).fill(t.of), data, start)
    }
    case 'tuple':
      return decodeTuple(t.items, data, off)
  }
}

function decodeTuple(types: AbiType[], data: string, base: number): AbiValue[] {
  const out: AbiValue[] = []
  let head = base
  for (const t of types) {
    out.push(decodeOne(t, data, base, head))
    head += headWords(t) * 32
  }
  return out
}

export function decodeAbi(types: string | AbiType[], data: string): AbiValue[] {
  const ts = typeof types === 'string' ? parseList(types) : types
  const hex = data.startsWith('0x') ? data.slice(2) : data
  if (ts.length === 0) return []
  return decodeTuple(ts, hex, 0)
}

/**
 * A view-function descriptor: `fn('getReserveData(address)', '(uint256,uint128)')`.
 * `encode(args)` builds calldata, `decode(ret)` returns the outputs; with a single
 * output, the bare value.
 */
export interface Fn {
  sig: string
  selector: Hex
  encode: (args?: AbiValue[]) => Hex
  decode: (ret: string) => AbiValue
}

export function fn(sig: string, returns = ''): Fn {
  const name = sig.slice(0, sig.indexOf('('))
  const inputs = parseList(sig.slice(sig.indexOf('(')))
  const canonical = `${name}(${inputs.map(canon).join(',')})`
  const sel = selector(canonical)
  const outs = returns.trim() === '' ? [] : parseList(returns)
  return {
    sig: canonical,
    selector: sel,
    encode: (args = []) => (`${sel}${encodeAbi(inputs, args).slice(2)}` as Hex),
    decode: (ret: string) => {
      const v = decodeAbi(outs, ret)
      return outs.length === 1 ? v[0] : v
    },
  }
}

export function canon(t: AbiType): string {
  switch (t.kind) {
    case 'uint':
    case 'int':
      return `${t.kind}${t.bits}`
    case 'fixedBytes':
      return `bytes${t.size}`
    case 'array':
      return `${canon(t.of)}[${t.length ?? ''}]`
    case 'tuple':
      return `(${t.items.map(canon).join(',')})`
    default:
      return t.kind
  }
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const lower = (a: string): string => a.toLowerCase()
export const isZero = (a: string | null | undefined): boolean => !a || /^0x0{40}$/i.test(a)
