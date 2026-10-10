import { constants, openSync, closeSync, readSync, fstatSync, lstatSync } from 'node:fs'

export function boundedReceiptBudget(limits, maxRecords, maxFileBytes) {
  if (limits === undefined) limits = {}
  if (
    !limits ||
    typeof limits !== 'object' ||
    Array.isArray(limits) ||
    Object.keys(limits).some((k) => !['maxRecords', 'maxTotalBytes'].includes(k))
  )
    throw Error('receipt_read_limits_invalid')
  const count = limits.maxRecords === undefined ? maxRecords : limits.maxRecords,
    total = limits.maxTotalBytes === undefined ? maxRecords * maxFileBytes : limits.maxTotalBytes
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > maxRecords ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > maxRecords * maxFileBytes
  )
    throw Error('receipt_read_limits_invalid')
  return { maxRecords: count, maxTotalBytes: total, maxFileBytes, totalBytes: 0 }
}
/** Fixed allocation and actual fd reads; preflight path sizes never authorize a whole-file read. */
export function readBoundedReceiptFile(path, budget, io = {}) {
  const open = io.openSync ?? openSync,
    close = io.closeSync ?? closeSync,
    read = io.readSync ?? readSync,
    fstat = io.fstatSync ?? fstatSync,
    lstat = io.lstatSync ?? lstatSync
  const cap = Math.min(budget.maxFileBytes, budget.maxTotalBytes - budget.totalBytes)
  if (!Number.isSafeInteger(cap) || cap < 1) throw Error('receipt_total_bytes_limit')
  const fd = open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstat(fd, { bigint: true })
    if (!before.isFile()) throw Error('receipt_file_not_regular')
    if (before.size > BigInt(cap)) throw Error('receipt_file_oversize_or_total_limit')
    const buffer = Buffer.alloc(cap + 1)
    let length = 0
    while (length < buffer.length) {
      const n = read(fd, buffer, length, buffer.length - length, null)
      if (!Number.isSafeInteger(n) || n < 0 || n > buffer.length - length)
        throw Error('receipt_read_invalid')
      if (n === 0) break
      length += n
    }
    if (length > cap) throw Error('receipt_file_oversize_or_total_limit')
    const after = fstat(fd, { bigint: true }),
      named = lstat(path, { bigint: true })
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(
        (k) => before[k] !== after[k] || after[k] !== named[k],
      ) ||
      BigInt(length) !== after.size
    )
      throw Error('receipt_file_changed_during_read')
    const bytes = buffer.subarray(0, length),
      text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw Error('receipt_file_utf8_invalid')
    budget.totalBytes += length
    return text
  } finally {
    close(fd)
  }
}
