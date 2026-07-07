/**
 * Centralized mock data toggle for NeutronMint.
 * When true (and in development), all modals and hooks use mock data
 * for UI testing without a live contract connection.
 */
export const USE_MOCK_DATA = process.env.NODE_ENV === 'development' && true
