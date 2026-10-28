// '/' is the landing page (owner ruling 2026-10-28). middleware.ts rewrites it to
// pages/[chain]/index.tsx, which renders the borrower-suite landing with a 200 and a
// canonical of '/'. This static fallback should never render.
export default function RootFallback() {
  return null
}
