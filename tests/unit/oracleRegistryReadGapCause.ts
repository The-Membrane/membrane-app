// RV11-1 (F4, 2026-10-12; R3, 2026-10-12): a card never renders a read gap it does not count.
// `causeListed` / `restsOnAGap` live in lib/oracleRegistry/config/readGapCause.ts since S1
// (2026-10-12: the card view lists the rows of a stored card whose cause the stored read gaps do
// not name). Re-exported here for the weETH F4 / R2 tests and the R3 every-shape test; not a test
// file itself.

export { causeListed, restsOnAGap } from '@/lib/oracleRegistry/config/readGapCause'
