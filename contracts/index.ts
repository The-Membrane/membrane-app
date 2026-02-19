/**
 * Ditto Page Contracts
 * 
 * This module exports all page contracts for the Ditto companion system.
 * Each contract defines the facts, messages, shortcuts, and thresholds
 * that Ditto can use on a specific page.
 */

export { manicContract, default as manicContractDefault } from './manicContract'
export { discoContract, default as discoContractDefault } from './discoContract'
export { transmuterContract, default as transmuterContractDefault } from './transmuterContract'
export { portfolioContract, default as portfolioContractDefault } from './portfolioContract'

import { manicContract } from './manicContract'
import { discoContract } from './discoContract'
import { transmuterContract } from './transmuterContract'
import { portfolioContract } from './portfolioContract'
import { DittoPageContract } from '@/components/DittoSpeechBox/types/dittoContract'

/**
 * Map of page IDs to their contracts
 */
export const pageContracts: Record<string, DittoPageContract> = {
    manic: manicContract,
    disco: discoContract,
    transmuter: transmuterContract,
    portfolio: portfolioContract,
}

/**
 * Get contract for a page by ID
 */
export const getContractForPage = (pageId: string): DittoPageContract | null => {
    return pageContracts[pageId] || null
}

/**
 * Get contract for a route path
 */
export const getContractForRoute = (pathname: string): DittoPageContract | null => {
    if (pathname.includes('/manic')) return manicContract
    if (pathname.includes('/disco')) return discoContract
    if (pathname.includes('/transmuter')) return transmuterContract
    if (pathname.includes('/portfolio')) return portfolioContract
    return null
}









