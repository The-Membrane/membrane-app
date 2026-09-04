import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Title + meta description moved to <Seo> in _app (per-page, server-rendered).
            next/document is the wrong place for them — they'd be identical on every
            route and Next ignores a _document <title> in newer versions anyway. */}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/images/favicon-16x16.png" />
        <link rel="manifest" href="/images/site.webmanifest" />
        <link rel="mask-icon" href="/images/safari-pinned-tab.svg" color="#09090a" />
        <meta name="msapplication-TileColor" content="#da532c" />
        <meta name="theme-color" content="#09090a" />
        {/* Pre-paint theme stamp: [data-membrane-theme] must exist before first
            paint or light-mode users flash dark. Namespaced attribute — Chakra's
            ColorModeProvider owns plain [data-theme] and re-stamps it on
            hydration. Keep this script tiny and synchronous.
            Order: localStorage membrane.theme → prefers-color-scheme → dark. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('membrane.theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-membrane-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content',t==='light'?'#e7dfcc':'#09090a')}}catch(e){document.documentElement.setAttribute('data-membrane-theme','dark')}})()`,
          }}
        />
        {/* Pre-establish connection to Skip API so widget API calls are instant */}
        <link rel="preconnect" href="https://api.skip.build" />
        <link rel="dns-prefetch" href="https://api.skip.build" />
        {/* Inter is now self-hosted via next/font/google (see pages/_app.tsx), so the
            render-blocking Google Fonts <link> and its fonts.googleapis.com/fonts.gstatic.com
            preconnects were removed. No other Google font is linked here. */}
      </Head>
      {/* No overflowX here: an inline hidden axis on <body> combines with the
          theme's body sizing to make body the scroll container instead of the
          document. The horizontal overflow it was hiding is fixed at source in
          theme/index.ts (width:100% rather than 100vw). */}
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
