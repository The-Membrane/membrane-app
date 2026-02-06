import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'

/**
 * Hook to determine the page title based on the current route
 * Returns a title string in the format "Membrane | PageName"
 */
export const usePageTitle = (): string => {
    const router = useRouter()
    const [title, setTitle] = useState('Membrane')

    useEffect(() => {
        // Return default title if router is not ready yet (during initial load)
        if (!router.isReady || !router.pathname) {
            setTitle('Membrane')
            return
        }

        const { pathname, query } = router

        // Handle home page with view query parameter
        if (pathname === '/[chain]' || pathname === '/') {
            const view = query.view as string
            if (view === 'lobby') {
                setTitle('Membrane | Lobby')
                return
            }
            if (view === 'about') {
                setTitle('Membrane | About')
                return
            }
            if (view === 'levels') {
                setTitle('Membrane | Levels')
                return
            }
            if (view === 'storefront' || !view) {
                setTitle('Membrane | Storefront')
                return
            }
        }

        // Handle other routes based on pathname
        const routeTitles: Record<string, string> = {
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
            '/tournament': 'Membrane | Tournament',
        }

        // Check for exact match first
        if (routeTitles[pathname]) {
            setTitle(routeTitles[pathname])
            return
        }

        // Handle dynamic routes with segments
        if (pathname.includes('/disco')) {
            setTitle('Membrane | Disco')
            return
        }
        if (pathname.includes('/flywheel')) {
            setTitle('Membrane | Flywheel')
            return
        }
        if (pathname.includes('/headquarters')) {
            setTitle('Membrane | Headquarters')
            return
        }
        if (pathname.includes('/mint')) {
            setTitle('Membrane | Mint')
            return
        }
        if (pathname.includes('/stake')) {
            setTitle('Membrane | Stake')
            return
        }
        if (pathname.includes('/portfolio')) {
            setTitle('Membrane | Portfolio')
            return
        }
        if (pathname.includes('/visualize')) {
            setTitle('Membrane | Visualize')
            return
        }
        if (pathname.includes('/tournament')) {
            setTitle('Membrane | Tournament')
            return
        }
        if (pathname.includes('/maze-runners')) {
            setTitle('Membrane | Maze Runners')
            return
        }
        if (pathname.includes('/cityscape')) {
            setTitle('Membrane | Cityscape')
            return
        }
        if (pathname.includes('/control-room')) {
            setTitle('Membrane | Control Room')
            return
        }
        if (pathname.includes('/liquidate')) {
            setTitle('Membrane | Liquidate')
            return
        }
        if (pathname.includes('/manic')) {
            setTitle('Membrane | Manic')
            return
        }
        if (pathname.includes('/isolated')) {
            setTitle('Membrane | Isolated Markets')
            return
        }
        if (pathname.includes('/transmuter')) {
            setTitle('Membrane | Transmuter')
            return
        }

        // Default title
        setTitle('Membrane')
    }, [router.isReady, router.pathname, router.query])

    return title
}
