/**
 * Centralized mock data toggle for NeutronMint.
 *
 * Mock data is a development-only affordance for exercising UI states without a
 * live contract connection. It MUST NEVER be active in production — a real user
 * must only ever see on-chain data. Gated on NODE_ENV so production builds
 * always resolve this to `false`.
 */
export const USE_MOCK_DATA = process.env.NODE_ENV !== 'production'
