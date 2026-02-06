import { toPng, toBlob } from 'html-to-image'

/**
 * Wait for fonts to load
 */
const waitForFonts = (): Promise<void> => {
    return document.fonts.ready.then(() => {
        // Additional wait to ensure fonts are fully rendered
        return new Promise(resolve => setTimeout(resolve, 100))
    })
}

/**
 * Wait for images to load
 */
const waitForImages = (element: HTMLElement): Promise<void> => {
    const images = element.querySelectorAll('img')
    const promises = Array.from(images).map(img => {
        if (img.complete) return Promise.resolve()
        return new Promise<void>((resolve) => {
            img.onload = () => resolve()
            img.onerror = () => resolve() // Continue even if image fails
            // Timeout after 5 seconds
            setTimeout(() => resolve(), 5000)
        })
    })
    return Promise.all(promises).then(() => { })
}

/**
 * Export a DOM element as a PNG image
 */
export const exportElementAsImage = async (
    element: HTMLElement,
    filename: string = 'membrane-card.png'
): Promise<void> => {
    try {
        // Find the actual card element (might be nested)
        const cardElement = element.querySelector('[data-card-element]') as HTMLElement || element

        // Wait for fonts and images to load
        await waitForFonts()
        await waitForImages(cardElement)

        // Small delay to ensure rendering
        await new Promise(resolve => setTimeout(resolve, 300))

        // Use html-to-image for high quality rendering
        // pixelRatio: 3 for retina/high DPI displays
        const dataUrl = await toPng(cardElement, {
            quality: 1.0,
            backgroundColor: '#1a1a2e',
            pixelRatio: 3,
            cacheBust: true,
            fontEmbedCSS: '', // Disable font embedding to avoid CORS issues with Google Fonts
            filter: (node: Node) => {
                // Skip external stylesheets that cause CORS errors
                if (node instanceof HTMLLinkElement && node.rel === 'stylesheet') {
                    try {
                        const sheet = node.sheet
                        if (sheet) {
                            const rules = sheet.cssRules || sheet.rules
                            return rules !== null
                        }
                    } catch (e) {
                        return false
                    }
                }
                return true
            },
        })

        // Download the image
        const link = document.createElement('a')
        link.download = filename
        link.href = dataUrl
        link.click()
    } catch (error) {
        console.error('Error exporting image:', error)
        throw error
    }
}

/**
 * Attempt to write blob to clipboard with retry logic
 */
const writeBlobToClipboard = async (
    imageBlob: Blob,
    maxAttempts: number = 5,
    attempt: number = 1
): Promise<boolean> => {
    if (attempt > maxAttempts) {
        console.error(`Failed to copy after ${maxAttempts} attempts`)
        return false
    }

    try {
        // Ensure document is focused before each attempt
        window.focus()
        document.body.focus()

        // Wait a bit longer on retries
        if (attempt > 1) {
            await new Promise(resolve => setTimeout(resolve, 200 * attempt))
        }

        // Check if ClipboardItem is available
        if (typeof ClipboardItem !== 'undefined') {
            const clipboardItem = new ClipboardItem({
                'image/png': imageBlob,
            })
            await navigator.clipboard.write([clipboardItem])
            return true
        } else {
            // Fallback: convert to data URL and copy as text
            const reader = new FileReader()
            const dataUrl = await new Promise<string>((resolve, reject) => {
                reader.onload = () => resolve(reader.result as string)
                reader.onerror = reject
                reader.readAsDataURL(imageBlob)
            })
            await navigator.clipboard.writeText(dataUrl)
            return true
        }
    } catch (error: any) {
        console.error(`Clipboard write attempt ${attempt} failed:`, error)

        // Retry on focus errors or other transient errors
        if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
            if (attempt < maxAttempts) {
                console.log(`Retrying clipboard write (attempt ${attempt + 1}/${maxAttempts})...`)
                return writeBlobToClipboard(imageBlob, maxAttempts, attempt + 1)
            }
        }

        // If it's the last attempt, try fallback method
        if (attempt === maxAttempts) {
            try {
                const reader = new FileReader()
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    reader.onload = () => resolve(reader.result as string)
                    reader.onerror = reject
                    reader.readAsDataURL(imageBlob)
                })
                window.focus()
                await new Promise(resolve => setTimeout(resolve, 200))
                await navigator.clipboard.writeText(dataUrl)
                console.log('Final fallback: copied as data URL')
                return true
            } catch (fallbackError) {
                console.error('Final fallback also failed:', fallbackError)
                return false
            }
        }

        return false
    }
}

/**
 * Copy element as image to clipboard
 */
export const copyElementToClipboard = async (element: HTMLElement): Promise<boolean> => {
    try {
        // Find the actual card element (might be nested)
        const cardElement = element.querySelector('[data-card-element]') as HTMLElement || element

        if (!cardElement) {
            console.error('Card element not found')
            return false
        }

        // Wait for fonts and images to load
        await waitForFonts()
        await waitForImages(cardElement)

        // Small delay to ensure rendering
        await new Promise(resolve => setTimeout(resolve, 500))

        // Check clipboard API availability
        if (!navigator.clipboard || !navigator.clipboard.write) {
            console.error('Clipboard API not available')
            return false
        }

        // Use html-to-image toBlob directly
        // Skip font embedding to avoid CORS errors with Google Fonts
        const blob = await toBlob(cardElement, {
            quality: 1.0,
            backgroundColor: '#1a1a2e',
            pixelRatio: 3,
            cacheBust: true,
            fontEmbedCSS: '', // Disable font embedding to avoid CORS issues
            filter: (node: Node) => {
                // Skip external stylesheets that cause CORS errors
                if (node instanceof HTMLLinkElement && node.rel === 'stylesheet') {
                    try {
                        // Try to access the stylesheet - if it fails, skip it
                        const sheet = node.sheet
                        if (sheet) {
                            // Try to access cssRules - this will throw if CORS blocks it
                            const rules = sheet.cssRules || sheet.rules
                            return rules !== null
                        }
                    } catch (e) {
                        // CORS error - skip this stylesheet
                        return false
                    }
                }
                return true
            },
        })

        if (!blob) {
            console.error('Failed to create blob')
            return false
        }

        // Ensure blob type is correct
        const imageBlob = blob.type === 'image/png'
            ? blob
            : new Blob([blob], { type: 'image/png' })

        // Attempt to write to clipboard with retry logic (max 5 attempts)
        return await writeBlobToClipboard(imageBlob, 5, 1)
    } catch (error) {
        console.error('Error copying to clipboard:', error)
        return false
    }
}

/**
 * Get element as data URL
 */
export const getElementAsDataUrl = async (element: HTMLElement): Promise<string> => {
    await waitForFonts()
    await waitForImages(element)

    const cardElement = element.querySelector('[data-card-element]') as HTMLElement || element

    return await toPng(cardElement, {
        quality: 1.0,
        backgroundColor: '#1a1a2e',
        pixelRatio: 3,
        cacheBust: true,
        fontEmbedCSS: '', // Disable font embedding to avoid CORS issues
        filter: (node: Node) => {
            // Skip external stylesheets that cause CORS errors
            if (node instanceof HTMLLinkElement && node.rel === 'stylesheet') {
                try {
                    const sheet = node.sheet
                    if (sheet) {
                        const rules = sheet.cssRules || sheet.rules
                        return rules !== null
                    }
                } catch (e) {
                    return false
                }
            }
            return true
        },
    })
}

/**
 * Generate Twitter share URL
 */
export const getTwitterShareUrl = (text: string, url?: string): string => {
    const params = new URLSearchParams({
        text,
        ...(url && { url }),
    })
    return `https://twitter.com/intent/tweet?${params.toString()}`
}

/**
 * Generate LinkedIn share URL
 */
export const getLinkedInShareUrl = (url: string, title?: string): string => {
    const params = new URLSearchParams({
        url,
        ...(title && { title }),
    })
    return `https://www.linkedin.com/sharing/share-offsite/?${params.toString()}`
}

/**
 * Card type definitions
 */
export type CardType = 'revenue' | 'boost' | 'contribution' | 'points' | 'portfolio'

export interface ShareableCardData {
    // Revenue data
    totalRevenue?: number
    revenuePerSecond?: number
    milestones?: Array<{ value: number; achieved: boolean }>

    // Boost data
    boostPercentage?: number
    mbrnAmount?: number
    nextMilestone?: number

    // Contribution data
    contributionPercentage?: number
    tvlContribution?: number
    revenueContribution?: number
    tier?: string

    // Points data
    rank?: number
    totalPoints?: number
    level?: number
    pointsInLevel?: number
    levelUpMaxPoints?: number
}
