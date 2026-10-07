// Typed, validated loader for data/oracle-registry/config/subjects.json — the config-card
// subjects (contracts, power paths, mint/redeem getters, queues, governance channels).
// A bad enum, a malformed address or a power path that names an undeclared contract throws at
// load time instead of rendering a wrong card (same policy as lib/oracleRegistry/catalog.ts).

import subjectsJson from '@/data/oracle-registry/config/subjects.json'
import type {
  ConfigSubject,
  ContractRole,
  Dimension,
  ParamRule,
  PowerSpec,
  SubjectsFile,
} from './types'

const DIMENSIONS: Dimension[] = ['bridge', 'oracle', 'admin', 'mint_redeem']
const ROLES: ContractRole[] = [
  'token',
  'oft',
  'oft_adapter',
  'lz_oapp',
  'ccip_pool',
  'proxy',
  'config',
  'oracle',
  'minting',
  'timelock',
  'safe',
  'multisig',
  'proxy_admin',
  'controller',
  'other',
]
const POWERS: PowerSpec['power'][] = [
  'upgrade',
  'mint',
  'bridge_config',
  'oracle',
  'pause',
  'caps',
  'roles',
]
const RULES: ParamRule[] = [
  'pauser',
  'rate_provider',
  'minter',
  'price_oracle',
  'bound_upper',
  'quorum',
  'quorum_members',
  'cap',
  'whitelist_gate',
  'cooldown',
  'info',
]
const CLASSES = ['lrt', 'bridged', 'pt', 'custodial'] as const
const STEP =
  /^(owner|eip1967_admin|zos_admin|lz_delegate|call:[A-Za-z0-9_]+\(\)|role:[A-Z0-9_]+|role_admin:[A-Z0-9_]+|acl_manager:[A-Z0-9_]+)$/
const ADDR = /^0x[0-9a-f]{40}$/

function fail(msg: string): never {
  throw new Error(`config subjects: ${msg}`)
}

export function parseSubjects(raw: unknown): SubjectsFile {
  const f = raw as SubjectsFile
  if (!f || f.version !== 1 || !Array.isArray(f.subjects)) fail('not a version-1 subjects file')
  if (!Number.isInteger(f.scanFloor) || f.scanFloor <= 0) fail('scanFloor must be a positive block')
  const keys = new Set<string>()
  for (const s of f.subjects) {
    const where = `subject ${s.key}`
    if (!/^[a-z0-9-]+$/.test(s.key) || keys.has(s.key)) fail(`${where}: bad or duplicate key`)
    keys.add(s.key)
    if (!CLASSES.includes(s.class)) fail(`${where}: class ${s.class}`)
    const declared = new Set<string>()
    for (const c of s.contracts) {
      if (!ADDR.test(c.address))
        fail(`${where}: contract address ${c.address} must be lower-case hex`)
      if (!ROLES.includes(c.role)) fail(`${where}: contract role ${c.role}`)
      if (!DIMENSIONS.includes(c.dimension)) fail(`${where}: dimension ${c.dimension}`)
      if (!Number.isInteger(c.deployBlock) || c.deployBlock <= 0)
        fail(`${where}: ${c.address} deployBlock`)
      if (c.chainId !== 1) fail(`${where}: v1 subjects are Ethereum-only contracts`)
      declared.add(c.address)
    }
    for (const a of [
      ...s.lzOApps,
      ...s.ccipPools,
      ...s.timelocks,
      ...(s.nttManagers ?? []),
      ...(s.aragonAcl ? [s.aragonAcl] : []),
    ])
      if (!declared.has(a)) fail(`${where}: ${a} is not a declared contract`)
    for (const b of s.canonicalBridges ?? []) {
      if (!declared.has(b.address)) fail(`${where}: bridge ${b.address} is not a declared contract`)
      if (!ADDR.test(b.token)) fail(`${where}: bridge ${b.address} token ${b.token}`)
      if (!b.chain || !b.operator) fail(`${where}: bridge ${b.address} needs a chain and an operator`)
    }
    for (const a of s.safes) if (!ADDR.test(a)) fail(`${where}: safe ${a}`)
    for (const p of s.powers) {
      if (!POWERS.includes(p.power)) fail(`${where}: power ${p.power}`)
      if (!declared.has(p.contract)) fail(`${where}: power on undeclared contract ${p.contract}`)
      if (!p.path.length || !p.path.every((x) => STEP.test(x)))
        fail(`${where}: power path ${p.path.join(' → ')}`)
      // functions a timelock whitelist may pass without exercising the power: signatures or selectors
      if (
        p.bypassExclude !== undefined &&
        (!Array.isArray(p.bypassExclude) ||
          !p.bypassExclude.every(
            (x) => /^0x[0-9a-f]{8}$/.test(x) || /^[a-zA-Z_]\w*\([\w,()[\]]*\)$/.test(x),
          ))
      )
        fail(`${where}: power ${p.label} bypassExclude must list function signatures or selectors`)
    }
    const pkeys = new Set<string>()
    for (const p of s.params) {
      if (pkeys.has(p.key)) fail(`${where}: duplicate param ${p.key}`)
      pkeys.add(p.key)
      if (!RULES.includes(p.rule)) fail(`${where}: param rule ${p.rule}`)
      if (!declared.has(p.contract)) fail(`${where}: param on undeclared contract ${p.contract}`)
      if (!p.eventsOnly && !/^function \w+\(.*\) view returns \(.+\)$/.test(p.sig))
        fail(`${where}: param ${p.key} sig`)
      if (p.rule === 'cap' && !p.zero)
        fail(`${where}: cap ${p.key} must say what 0 means for this asset`)
      if (p.count !== undefined && (p.count !== true || !/returns \(address\[\]/.test(p.sig)))
        fail(`${where}: param ${p.key} count needs a getter returning a list first`)
    }
    for (const g of s.govChannels)
      if (g.kind !== 'snapshot' && g.kind !== 'discourse')
        fail(`${where}: gov channel ${(g as { kind: string }).kind}`)
    // severity rank pricing (owner ruling #9): a registry asset × an optional on-chain rate
    if (s.valuation !== undefined) {
      const v = s.valuation
      if (!v || typeof v.asset !== 'string' || !v.asset) fail(`${where}: valuation.asset`)
      if (
        v.rate !== undefined &&
        (!declared.has(v.rate.contract) ||
          !/^function \w+\(\) view returns \(uint\d*\)$/.test(v.rate.sig) ||
          !Number.isInteger(v.rate.decimals) ||
          v.rate.decimals < 0)
      )
        fail(`${where}: valuation.rate must be a declared contract's uint getter with decimals`)
    }
  }
  return f
}

let cached: SubjectsFile | null = null
export function getConfigSubjects(): SubjectsFile {
  if (!cached) cached = parseSubjects(subjectsJson as unknown)
  return cached
}

export function subjectByKey(key: string): ConfigSubject | undefined {
  return getConfigSubjects().subjects.find((s) => s.key === key)
}
