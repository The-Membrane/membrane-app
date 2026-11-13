/**
 * DEV / TEST ONLY. An EIP-5792-style atomic batch on a local anvil, which has no
 * wallet_sendCalls: the owner's EOA delegates (EIP-7702) to contracts/migrator BatchExecutor and
 * calls itself `execute(calls)` in ONE transaction — what a 7702 smart-account wallet does behind
 * wallet_sendCalls. Needs a local account (it signs the authorization) and anvil --hardfork prague.
 * Production uses sendBatch5792 (lib/migrate/exec.ts). Nothing in the app bundle imports this
 * file: the dev page loads it through a NODE_ENV-guarded dynamic import, and the unit tests import
 * it directly.
 */

import { encodeFunctionData, parseAbi, type Abi, type Address } from 'viem'
import { signAuthorization } from 'viem/actions'

import { assertWalletChain, batchSettlement, type SendBatch } from './exec'

const executorAbi = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'function execute(Call[] calls) payable',
])

export function sendBatch7702(executor: Address): SendBatch {
  return async ({ client, wallet, owner, calls, chain }) => {
    if (process.env.NODE_ENV === 'production') throw new Error('sendBatch7702 is dev/test only')
    await assertWalletChain(wallet, chain)
    const account = wallet.account
    if (!account || account.type !== 'local') throw new Error('sendBatch7702 needs a local account')
    const authorization = await signAuthorization(wallet, { account, contractAddress: executor, executor: 'self' })
    const data = encodeFunctionData({
      abi: executorAbi,
      functionName: 'execute',
      args: [calls.map((c) => ({ to: c.to, value: 0n, data: encodeFunctionData({ abi: c.abi as Abi, functionName: c.functionName, args: c.args as unknown[] }) }))],
    })
    const hash = await wallet.sendTransaction({ account, chain, to: owner, data, authorizationList: [authorization] })
    const rc = await client.waitForTransactionReceipt({ hash })
    // one transaction is atomic by construction; the same settlement rule as the wallet path
    return batchSettlement({ atomic: true, status: 'success', receipts: [{ status: rc.status, transactionHash: hash }] })
  }
}
