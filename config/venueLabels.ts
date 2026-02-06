/**
 * Mapping of deployment venue contract addresses to human-readable labels.
 * Add entries here as venues are deployed.
 */
const venueLabels: Record<string, string> = {
  // Example:
  // 'osmo1abc...xyz': 'Mars USDC Vault',
}

export const getVenueLabel = (address: string): string => {
  if (venueLabels[address]) return venueLabels[address]
  // Truncate: first 10 + ... + last 6
  if (address.length > 20) {
    return `${address.slice(0, 10)}...${address.slice(-6)}`
  }
  return address
}

export default venueLabels
