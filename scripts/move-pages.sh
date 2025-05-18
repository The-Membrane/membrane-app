#!/bin/bash

# Create chain-specific directories for each page
for page in borrow bid stake manic management; do
  mkdir -p "pages/[chain]/$page"
  # Move the page content to the new location
  mv "pages/$page.tsx" "pages/[chain]/$page/index.tsx"
done

# Move the index page
mv "pages/index.tsx" "pages/[chain]/index.tsx"

# Create a redirect from the old paths to the default chain
for page in borrow bid stake manic management; do
  cat > "pages/$page.tsx" << EOF
import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { supportedChains } from '@/config/chains'

export default function Redirect() {
  const router = useRouter()
  
  useEffect(() => {
    router.replace(\`/\${supportedChains[0].name}/${page}\`)
  }, [router])

  return null
}
EOF
done

# Create a redirect for the index page
cat > "pages/index.tsx" << EOF
import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { supportedChains } from '@/config/chains'

export default function Redirect() {
  const router = useRouter()
  
  useEffect(() => {
    router.replace(\`/\${supportedChains[0].name}\`)
  }, [router])

  return null
}
EOF 