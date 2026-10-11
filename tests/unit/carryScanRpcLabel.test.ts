import { describe, expect, it } from 'vitest'

import { redactError, rpcLabel } from '@/lib/netApy/rpc'

// Made-up account ids and keys: none of these is a real endpoint.
const QUICKNODE = 'https://acct-1a2b3c4d.ethereum-mainnet.quiknode.pro/k3y0000000000000/'
const ALCHEMY = 'https://eth-mainnet.g.alchemy.com/v2/k3y0000000000000'

// The weekly file is public (the `data` branch of a public repo) and its `rpc` field is the
// label of the first env RPC URL. `env:<full host>` would publish an account-specific
// subdomain (QuickNode <id>.ethereum-mainnet.quiknode.pro) unmasked. Only the provider's
// registrable domain is published.
describe('rpcLabel: the provider, never the account', () => {
  it('labels an env URL with its registrable domain only', () => {
    expect(rpcLabel([QUICKNODE])).toBe('env:quiknode.pro')
    expect(rpcLabel([ALCHEMY])).toBe('env:alchemy.com')
    expect(rpcLabel(['https://mainnet.infura.io/v3/k3y'])).toBe('env:infura.io')
    expect(rpcLabel(['https://rpc.ankr.com/eth/k3y'])).toBe('env:ankr.com')
    expect(rpcLabel(['https://lb.drpc.org/ogrpc?network=ethereum&dkey=k3y'])).toBe('env:drpc.org')
    expect(rpcLabel(['wss://acct-9.eth-mainnet.example.com:8546/k3y'])).toBe('env:example.com')
  })

  it('never carries a subdomain, a path, a query, a port or credentials', () => {
    const urls = [
      QUICKNODE,
      ALCHEMY,
      'https://user:pa55@node-7.rpc.example.org:8545/path/k3y?token=t0k',
    ]
    for (const u of urls) {
      const label = rpcLabel([u])
      expect(label, u).toMatch(/^env:[a-z0-9-]+\.[a-z0-9-]+$/)
      for (const secret of ['acct-1a2b3c4d', 'k3y', 'pa55', 'user', 't0k', '8545', 'node-7'])
        expect(label, u).not.toContain(secret)
    }
  })

  it('uses only the first env URL; an IP, localhost or a bad URL has no domain to show', () => {
    expect(rpcLabel([QUICKNODE, ALCHEMY])).toBe('env:quiknode.pro')
    expect(rpcLabel(['http://10.1.2.3:8545'])).toBe('env:ip-address')
    expect(rpcLabel(['http://[2001:db8::1]:8545'])).toBe('env:ip-address')
    expect(rpcLabel(['http://localhost:8545'])).toBe('env:localhost')
    expect(rpcLabel(['not a url'])).toBe('env:invalid-url')
    // No env URL: the public endpoint's own (public) host, unchanged.
    expect(rpcLabel([])).toBe('public:gateway.tenderly.co')
  })

  it('an error naming an env host, with or without a scheme, is masked to the same label', () => {
    const env = [QUICKNODE, ALCHEMY]
    const bare = new Error(
      'getaddrinfo ENOTFOUND acct-1a2b3c4d.ethereum-mainnet.quiknode.pro\nmore detail',
    )
    expect(redactError(bare, env)).toBe('getaddrinfo ENOTFOUND env:quiknode.pro')
    expect(redactError(new Error(`HTTP request failed. URL: ${QUICKNODE}`), env)).toBe(
      'HTTP request failed. URL: [rpc]',
    )
    expect(
      redactError(new Error('socket hang up at wss://eth-mainnet.g.alchemy.com/v2/k3y'), env),
    ).toBe('socket hang up at [rpc]')
    // Two env hosts where one is the other's suffix: one pass, never "env:env:alchemy.com".
    expect(
      redactError(new Error('ENOTFOUND eth-mainnet.g.alchemy.com'), [
        ALCHEMY,
        'https://alchemy.com/k3y',
      ]),
    ).toBe('ENOTFOUND env:alchemy.com')
    // A scheme-less host with its key or port glued on: the label only, nothing after it.
    expect(
      redactError(
        new Error('fetch failed acct-1a2b3c4d.ethereum-mainnet.quiknode.pro/t0k3n/ x'),
        env,
      ),
    ).toBe('fetch failed env:quiknode.pro x')
    expect(redactError(new Error('ECONNREFUSED eth-mainnet.g.alchemy.com:443/v2/k3y'), env)).toBe(
      'ECONNREFUSED env:alchemy.com',
    )
    // A message naming no env host is unchanged.
    expect(redactError(new Error('execution reverted'), env)).toBe('execution reverted')
  })
})
