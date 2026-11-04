/**
 * Migrate / deploy-fresh sheets (lane Q41). Stable seam for the landing page:
 *   onMigrate(position)     → <MigrateSheet position onClose />
 *   onDeployFresh(position) → <DeploySheet position onClose />
 */
export { MigrateSheet } from './MigrateSheet'
export { DeploySheet } from './DeploySheet'
export type { MigrateSheetProps, DeploySheetProps, MigrateSource } from '@/lib/migrate/types'
