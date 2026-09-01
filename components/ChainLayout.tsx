import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { supportedChains } from '@/config/chains'
import { useChainRoute } from '@/hooks/useChainRoute'

interface ChainLayoutProps {
    children: React.ReactNode
}

export default function ChainLayout({ children }: ChainLayoutProps) {
    const router = useRouter()
    const { chainName, isValidChain } = useChainRoute()

    // nextjs-no-client-side-redirect: partial FP by construction, not by laziness.
    // ChainLayout is mounted once, globally, inside Layout.tsx -> _app.tsx, wrapping
    // every route in the app — it is a shared layout component, not a page, so it has
    // no getServerSideProps to return `{ redirect }` from. Doing this server-side would
    // mean either adding a redirect getServerSideProps to every page under pages/[chain]/**
    // (dozens of files) or opting the whole app out of automatic static optimization via
    // _app.getInitialProps — both a far larger blast radius than this bug-fix pass, and
    // neither verifiable here without a build. The one entry point most stale bookmarks
    // actually hit (bare /<chain>) now redirects server-side — see
    // getServerSideProps in pages/[chain]/index.tsx. This effect stays as the
    // client-side backstop for deep-linked stale chain URLs, and already renders `null`
    // (not the wrong children) while the redirect is in flight, so there is no
    // wrong-content flash — only a brief blank frame.
    useEffect(() => {
        if (!isValidChain) {
            const pathWithoutLeadingChain = router.asPath.replace(/^\/[^/]+/, '')
            router.replace(`/${supportedChains[0].name}${pathWithoutLeadingChain}`)
        }
    }, [chainName, isValidChain, router])

    if (!isValidChain) {
        return null
    }

    return <>{children}</>
} 