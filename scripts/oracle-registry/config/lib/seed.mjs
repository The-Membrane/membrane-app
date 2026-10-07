// Point-read seed of the LayerZero replay state (lib/oracleRegistry/config/lzReplay.ts
// LzReplayState) for one OApp and a set of eids at one block. Used where a full history scan
// is not affordable (remote chains through public RPCs): replay a window of events on top of
// the state read at the window's first block.

import { FN, fnAbi } from './abi.mjs'
import { ulnFromTuple } from './lz.mjs'
import { tryRead } from './rpc.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'

export async function seedLzState(client, { chainId, endpoint, oapp, eids, block }) {
  const s = {
    chainId,
    defaults: {},
    overrides: {},
    defaultSendLib: {},
    defaultRecvLib: {},
    defaultRecvTimeout: {},
    sendLib: {},
    recvLib: {},
    recvTimeout: {},
    peers: {},
    delegates: {},
    routes: [],
  }
  const o = oapp.toLowerCase()
  const ep = (sig) => fnAbi(sig)
  const del = await tryRead(client, endpoint, ep(FN.delegates), 'delegates', [oapp], block)
  if (del.ok) s.delegates[o] = del.value.toLowerCase()
  for (const eid of eids) {
    const e = String(eid)
    const sl = await tryRead(
      client,
      endpoint,
      ep('function defaultSendLibrary(uint32) view returns (address)'),
      'defaultSendLibrary',
      [eid],
      block,
    )
    const rl = await tryRead(
      client,
      endpoint,
      ep('function defaultReceiveLibrary(uint32) view returns (address)'),
      'defaultReceiveLibrary',
      [eid],
      block,
    )
    if (sl.ok) s.defaultSendLib[e] = sl.value.toLowerCase()
    if (rl.ok) s.defaultRecvLib[e] = rl.value.toLowerCase()
    const dt = await tryRead(
      client,
      endpoint,
      ep(FN.defaultReceiveLibraryTimeout),
      'defaultReceiveLibraryTimeout',
      [eid],
      block,
    )
    if (dt.ok && dt.value[0] !== ZERO)
      s.defaultRecvTimeout[e] = { lib: dt.value[0].toLowerCase(), expiry: Number(dt.value[1]) }
    const own = await tryRead(
      client,
      endpoint,
      ep(FN.getSendLibrary),
      'getSendLibrary',
      [oapp, eid],
      block,
    )
    const isDef = await tryRead(
      client,
      endpoint,
      ep(FN.isDefaultSendLibrary),
      'isDefaultSendLibrary',
      [oapp, eid],
      block,
    )
    if (own.ok && isDef.ok && !isDef.value)
      (s.sendLib[o] = s.sendLib[o] ?? {})[e] = own.value.toLowerCase()
    const rown = await tryRead(
      client,
      endpoint,
      ep(FN.getReceiveLibrary),
      'getReceiveLibrary',
      [oapp, eid],
      block,
    )
    if (rown.ok && !rown.value[1])
      (s.recvLib[o] = s.recvLib[o] ?? {})[e] = rown.value[0].toLowerCase()
    const t = await tryRead(
      client,
      endpoint,
      ep(FN.receiveLibraryTimeout),
      'receiveLibraryTimeout',
      [oapp, eid],
      block,
    )
    if (t.ok && t.value[0] !== ZERO)
      (s.recvTimeout[o] = s.recvTimeout[o] ?? {})[e] = {
        lib: t.value[0].toLowerCase(),
        expiry: Number(t.value[1]),
      }
    // Every library this OApp can resolve to on this eid: default + own + grace.
    const libs = new Set(
      [
        s.defaultSendLib[e],
        s.defaultRecvLib[e],
        s.sendLib[o]?.[e],
        s.recvLib[o]?.[e],
        s.recvTimeout[o]?.[e]?.lib,
        s.defaultRecvTimeout[e]?.lib,
      ].filter(Boolean),
    )
    for (const lib of libs) {
      const d = await tryRead(
        client,
        lib,
        ep(FN.getAppUlnConfig),
        'getAppUlnConfig',
        [ZERO, eid],
        block,
      )
      if (d.ok) (s.defaults[lib] = s.defaults[lib] ?? {})[e] = ulnFromTuple(d.value)
      const a = await tryRead(
        client,
        lib,
        ep(FN.getAppUlnConfig),
        'getAppUlnConfig',
        [oapp, eid],
        block,
      )
      if (a.ok)
        ((s.overrides[lib] = s.overrides[lib] ?? {})[o] = s.overrides[lib][o] ?? {})[e] =
          ulnFromTuple(a.value)
    }
    const p = await tryRead(client, oapp, ep(FN.peers), 'peers', [eid], block)
    if (p.ok) (s.peers[o] = s.peers[o] ?? {})[e] = String(p.value).toLowerCase()
    s.routes.push(`${o}|${eid}`)
  }
  return s
}
