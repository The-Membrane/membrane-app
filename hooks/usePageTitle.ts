import { useRouter } from 'next/router'

/**
 * Route-derived page title, in the format "Membrane | PageName".
 *
 * Computed during render (no state/effect) so the title is present in the
 * SERVER HTML — the old useEffect version served `<title>Membrane</title>` on
 * every route, which is what crawlers and link previews indexed (SEO rule R3).
 */
const EXACT_TITLES: Record<string, string> = {
  '/[chain]/disco': 'Membrane | Disco',
  '/[chain]/flywheel': 'Membrane | Flywheel',
  '/[chain]/headquarters': 'Membrane | Headquarters',
  '/[chain]/levels': 'Membrane | Levels',
  '/[chain]/mint': 'Membrane | Mint',
  '/[chain]/stake': 'Membrane | Stake',
  '/[chain]/portfolio': 'Membrane | Portfolio',
  '/[chain]/visualize': 'Membrane | Visualize',
  '/[chain]/tournament': 'Membrane | Tournament',
  '/[chain]/maze-runners': 'Membrane | Maze Runners',
  '/[chain]/cityscape': 'Membrane | Cityscape',
  '/[chain]/control-room': 'Membrane | Control Room',
  '/[chain]/liquidate': 'Membrane | Liquidate',
  '/[chain]/manic': 'Membrane | Manic',
  '/[chain]/isolated': 'Membrane | Isolated Markets',
  '/[chain]/transmuter': 'Membrane | Transmuter',
  '/bid': 'Membrane | Bid',
  '/borrow': 'Membrane | Borrow',
  '/lockdrop': 'Membrane | Lockdrop',
  '/management': 'Membrane | Management',
  '/manic': 'Membrane | Manic',
  '/nft': 'Membrane | NFT',
  '/stake': 'Membrane | Stake',
  '/terms': 'Membrane | Terms of Service',
  '/tournament': 'Membrane | Tournament',
}

// Fallbacks for nested dynamic routes (e.g. /[chain]/disco/[slot]).
const SEGMENT_TITLES: Array<[string, string]> = [
  ['/disco', 'Disco'],
  ['/flywheel', 'Flywheel'],
  ['/headquarters', 'Headquarters'],
  ['/mint', 'Mint'],
  ['/stake', 'Stake'],
  ['/portfolio', 'Portfolio'],
  ['/visualize', 'Visualize'],
  ['/tournament', 'Tournament'],
  ['/maze-runners', 'Maze Runners'],
  ['/cityscape', 'Cityscape'],
  ['/control-room', 'Control Room'],
  ['/liquidate', 'Liquidate'],
  ['/manic', 'Manic'],
  ['/isolated', 'Isolated Markets'],
  ['/transmuter', 'Transmuter'],
]

export const usePageTitle = (): string => {
  const { pathname, query } = useRouter()

  if (pathname === '/[chain]' || pathname === '/') {
    const view = typeof query.view === 'string' ? query.view : undefined
    if (view === 'lobby') return 'Membrane | Lobby'
    if (view === 'about') return 'Membrane | About'
    if (view === 'levels') return 'Membrane | Levels'
    return 'Membrane | Storefront'
  }

  const exact = EXACT_TITLES[pathname]
  if (exact) return exact

  for (const [segment, name] of SEGMENT_TITLES) {
    if (pathname.includes(segment)) return `Membrane | ${name}`
  }

  return 'Membrane'
}
