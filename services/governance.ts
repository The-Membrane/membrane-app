import contracts from '@/config/contracts.json'
import {
  GovernanceClient,
  GovernanceQueryClient,
} from '@/contracts/codegen/governance/Governance.client'
import {
  Addr,
  Config,
  Proposal,
  ProposalResponse as ProposalResponseType,
  ProposalStatus,
} from '@/contracts/codegen/governance/Governance.types'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { num } from '@/helpers/num'
import { coin } from '@cosmjs/amino'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import dayjs from 'dayjs'

export const getGovernanceClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new GovernanceQueryClient(cosmWasmClient, contracts.governance)
}

export const getSigningGovernanceClient = (signingClient: SigningCosmWasmClient, address: Addr) => {
  return new GovernanceClient(signingClient, address, contracts.governance)
}

const mockProposal = [
  {
    proposal_id: '9945',
    submitter: 'osmo1988s5h45qwkaqch8km4ceagw2e08vdw28mwk4n',
    status: 'active',
    aligned_power: '786875',
    for_power: '4289864',
    against_power: '0',
    amendment_power: '0',
    removal_power: '0',
    start_block: 13590102,
    start_time: 1706905814,
    end_block: 13633302,
    delayed_end_block: 13633303,
    expiration_block: 13834903,
    title: 'Add Axelar ETH to the Oracle',
    description: 'Add ETHaxl to the oracle',
    messages: [
      {
        order: '1',
        msg: {
          wasm: {
            execute: {
              contract_addr: 'osmo16sgcpe0hcs42qk5vumk06jzmstkpka9gjda9tfdelwn65ksu3l7s7d4ggs',
              msg: 'ewogICJhZGRfYXNzZXQiOiB7CiAgICAiYXNzZXRfaW5mbyI6IHsKICAgICAgIm5hdGl2ZV90b2tlbiI6IHsKICAgICAgICAiZGVub20iOiAiaWJjL0VBMUQ0Mzk4MUQ1QzlBMUM0QUFFQTlDMjNCQjFENEZBMTI2QkE5QkM3MDIwQTI1RTBBRTRBQTg0MUVBMjVEQzUiCiAgICAgIH0KICAgIH0sCiAgICAib3JhY2xlX2luZm8iOiB7CiAgICAgICJiYXNrZXRfaWQiOiAiMSIsCiAgICAgICJkZWNpbWFscyI6IDE4LAogICAgICAibHBfcG9vbF9pbmZvIjogbnVsbCwKICAgICAgInBvb2xzX2Zvcl9vc21vX3R3YXAiOiBbCiAgICAgICAgewogICAgICAgICAgImJhc2VfYXNzZXRfZGVub20iOiAiaWJjL0VBMUQ0Mzk4MUQ1QzlBMUM0QUFFQTlDMjNCQjFENEZBMTI2QkE5QkM3MDIwQTI1RTBBRTRBQTg0MUVBMjVEQzUiLAogICAgICAgICAgInBvb2xfaWQiOiA3MDQsCiAgICAgICAgICAicXVvdGVfYXNzZXRfZGVub20iOiAidW9zbW8iCiAgICAgICAgfQogICAgICBdLAogICAgICAiaXNfdXNkX3BhciI6IGZhbHNlCiAgICB9CiAgfQp9',
              funds: [],
            },
          },
        },
      },
    ],
    link: 'https://discord.com/channels/1060217330258432010/1194692158549151764',
  },
  {
    proposal_id: '29495',
    submitter: 'osmo1988s5h45qwkaqch8km4ceagw2e08vdw28mwk4n',
    status: 'passed',
    aligned_power: '786875',
    for_power: '4289864',
    against_power: '0',
    amendment_power: '0',
    removal_power: '0',
    start_block: 13590102,
    start_time: 1706905814,
    end_block: 13633302,
    delayed_end_block: 13633303,
    expiration_block: 13834903,
    title: 'Add Axelar ETH to the Oracle',
    description: 'Add ETHaxl to the oracle',
    messages: [
      {
        order: '1',
        msg: {
          wasm: {
            execute: {
              contract_addr: 'osmo16sgcpe0hcs42qk5vumk06jzmstkpka9gjda9tfdelwn65ksu3l7s7d4ggs',
              msg: 'ewogICJhZGRfYXNzZXQiOiB7CiAgICAiYXNzZXRfaW5mbyI6IHsKICAgICAgIm5hdGl2ZV90b2tlbiI6IHsKICAgICAgICAiZGVub20iOiAiaWJjL0VBMUQ0Mzk4MUQ1QzlBMUM0QUFFQTlDMjNCQjFENEZBMTI2QkE5QkM3MDIwQTI1RTBBRTRBQTg0MUVBMjVEQzUiCiAgICAgIH0KICAgIH0sCiAgICAib3JhY2xlX2luZm8iOiB7CiAgICAgICJiYXNrZXRfaWQiOiAiMSIsCiAgICAgICJkZWNpbWFscyI6IDE4LAogICAgICAibHBfcG9vbF9pbmZvIjogbnVsbCwKICAgICAgInBvb2xzX2Zvcl9vc21vX3R3YXAiOiBbCiAgICAgICAgewogICAgICAgICAgImJhc2VfYXNzZXRfZGVub20iOiAiaWJjL0VBMUQ0Mzk4MUQ1QzlBMUM0QUFFQTlDMjNCQjFENEZBMTI2QkE5QkM3MDIwQTI1RTBBRTRBQTg0MUVBMjVEQzUiLAogICAgICAgICAgInBvb2xfaWQiOiA3MDQsCiAgICAgICAgICAicXVvdGVfYXNzZXRfZGVub20iOiAidW9zbW8iCiAgICAgICAgfQogICAgICBdLAogICAgICAiaXNfdXNkX3BhciI6IGZhbHNlCiAgICB9CiAgfQp9',
              funds: [],
            },
          },
        },
      },
    ],
    link: 'https://discord.com/channels/1060217330258432010/1194692158549151764',
  },
  {
    proposal_id: '294895',
    submitter: 'osmo1feygna5jhurw8m53ze9z2deqrwm36tksxj8r3g',
    status: 'pending',
    aligned_power: '786875',
    for_power: '4289864',
    against_power: '0',
    amendment_power: '0',
    removal_power: '0',
    start_block: 13590102,
    start_time: 1706905814,
    end_block: 13633302,
    delayed_end_block: 13633303,
    expiration_block: 13834903,
    title: 'Add Axelar ETH to the Oracle',
    description: 'Add ETHaxl to the oracle',
    messages: [
      {
        order: '1',
        msg: {
          wasm: {
            execute: {
              contract_addr: 'osmo16sgcpe0hcs42qk5vumk06jzmstkpka9gjda9tfdelwn65ksu3l7s7d4ggs',
              msg: 'ewogICJhZGRfYXNzZXQiOiB7CiAgICAiYXNzZXRfaW5mbyI6IHsKICAgICAgIm5hdGl2ZV90b2tlbiI6IHsKICAgICAgICAiZGVub20iOiAiaWJjL0VBMUQ0Mzk4MUQ1QzlBMUM0QUFFQTlDMjNCQjFENEZBMTI2QkE5QkM3MDIwQTI1RTBBRTRBQTg0MUVBMjVEQzUiCiAgICAgIH0KICAgIH0sCiAgICAib3JhY2xlX2luZm8iOiB7CiAgICAgICJiYXNrZXRfaWQiOiAiMSIsCiAgICAgICJkZWNpbWFscyI6IDE4LAogICAgICAibHBfcG9vbF9pbmZvIjogbnVsbCwKICAgICAgInBvb2xzX2Zvcl9vc21vX3R3YXAiOiBbCiAgICAgICAgewogICAgICAgICAgImJhc2VfYXNzZXRfZGVub20iOiAiaWJjL0VBMUQ0Mzk4MUQ1QzlBMUM0QUFFQTlDMjNCQjFENEZBMTI2QkE5QkM3MDIwQTI1RTBBRTRBQTg0MUVBMjVEQzUiLAogICAgICAgICAgInBvb2xfaWQiOiA3MDQsCiAgICAgICAgICAicXVvdGVfYXNzZXRfZGVub20iOiAidW9zbW8iCiAgICAgICAgfQogICAgICBdLAogICAgICAiaXNfdXNkX3BhciI6IGZhbHNlCiAgICB9CiAgfQp9',
              funds: [],
            },
          },
        },
      },
    ],
    link: 'https://discord.com/channels/1060217330258432010/1194692158549151764',
  },
]

type Ratio = {
  forRatio: number
  againstRatio: number
  amendRatio: number
  removeRatio: number
  alignRatio: number
}

export type ProposalResponse = ProposalResponseType & {
  badge: string
  status: ProposalStatus & ('completed' | 'pending')
  result: string
  ratio: Ratio
}

export const calcuateRatio = (proposal: ProposalResponse) => {
  const { for_power, amendment_power, removal_power, against_power, aligned_power } = proposal
  const totalVotes = num(for_power)
    .plus(amendment_power)
    .plus(removal_power)
    .plus(against_power)
    .plus(aligned_power)
  const forRatio = num(for_power).div(totalVotes).times(100).dp(2).toNumber()
  const againstRatio = num(against_power).div(totalVotes).times(100).dp(2).toNumber()
  const amendRatio = num(amendment_power).div(totalVotes).times(100).dp(2).toNumber()
  const alignRatio = num(aligned_power).div(totalVotes).times(100).dp(2).toNumber()
  const removeRatio = num(removal_power).div(totalVotes).times(100).dp(2).toNumber()
  return { forRatio, againstRatio, amendRatio, removeRatio, alignRatio }
}

export const calculateProposalResult = (proposal: ProposalResponseType, config: Config) => {
  let threshold = parseFloat(config.proposal_required_threshold)

  const { for_power, amendment_power, removal_power, against_power } = proposal
  var totalVotes = num(for_power).plus(amendment_power).plus(removal_power).plus(against_power)
  const hasMessages = !!proposal.messages

  if (hasMessages) {
    threshold = 0.5
  }

  if (num(for_power).div(totalVotes).gt(threshold)) {
    return 'For'
  } else if (num(amendment_power).div(totalVotes).gt(threshold)) {
    return 'Amend'
  } else if (num(removal_power).div(totalVotes).gt(threshold)) {
    return 'Remove'
  } else {
    return 'Against'
  }
}

const getDaysLeft = (proposal: any) => {
  const VOTING_PERIOD_IN_DAYS = 7
  const EXPEDITED_VOTING_PERIOD_IN_DAYS = 3
  const SECONDS_PER_DAY = 86400
  const SECONDS_PER_HOUR = 3600
  const SECONDS_PER_MINUTE = 60

  const votingPeriodInSeconds =
    proposal.end_block - proposal.start_time === 259200
      ? EXPEDITED_VOTING_PERIOD_IN_DAYS * SECONDS_PER_DAY
      : VOTING_PERIOD_IN_DAYS * SECONDS_PER_DAY

  const secondsRemaining = Math.max(
    votingPeriodInSeconds - (dayjs().unix() - proposal.start_time),
    0,
  )

  const days = Math.floor(secondsRemaining / SECONDS_PER_DAY)
  const hours = Math.floor((secondsRemaining % SECONDS_PER_DAY) / SECONDS_PER_HOUR)
  const minutes = Math.floor((secondsRemaining % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)

  return { days, hours, minutes }
}

const parseProposal = (proposals: ProposalResponseType[]) => {
  const activeProposals = proposals
    .filter(({ status }) => status === 'active')
    .map((proposal) => ({
      ...proposal,
      badge: 'active',
      daysLeft: getDaysLeft(proposal),
    }))

  const completedBadge: Record<string, string> = {
    passed: 'passed',
    rejected: 'rejected',
    amendment_desired: 'amended',
    expired: 'expired',
  }
  const completedProposals = proposals
    .filter(
      ({ status }) =>
        status === 'passed' ||
        status === 'rejected' ||
        status === 'amendment_desired' ||
        status === 'expired',
    )
    .map((proposal) => ({
      ...proposal,
      status: 'completed',
      badge: completedBadge[proposal.status],
    }))

  const executedProposals = proposals
    .filter(({ status }) => status === 'executed')
    .map((proposal) => ({
      ...proposal,
      badge: 'executed',
    }))
  const pendingProposals = proposals
    .filter(({ status }) => status === 'pending')
    .map((proposal) => ({
      ...proposal,
      badge: 'pending',
    }))

  return [...activeProposals, ...completedProposals, ...executedProposals, ...pendingProposals]
}

export const getConfig = async () => {
  const client = await getGovernanceClient()
  return client.config()
}

export const getProposals = async () => {
  const client = await getGovernanceClient()
  const config = await getConfig()
  // const requiredQuorum = parseFloat(config.proposal_required_quorum)
  const requiredQuorum = num(config.proposal_required_quorum).times(100).toNumber()

  const start = 0
  const limit = 30

  const activeProposals = client.activeProposals({ start, limit }).then((res) => res.proposal_list)
  const pendingProposals = client.pendingProposals({}).then((res) => res.proposal_list)

  const statusOrder: Record<string, number> = {
    active: 0,
    pending: 1,
    complited: 2,
    executed: 3,
  }

  const allProposals = await Promise.all([activeProposals, pendingProposals])
    .then(([active, pending]) => [...active, ...pending, ...mockProposal])
    .then(parseProposal)
    .then((proposals) =>
      proposals.sort((a, b) => {
        return statusOrder[a.status] - statusOrder[b.status]
      }),
    )

  return allProposals.map((proposal) => ({
    ...proposal,
    result: calculateProposalResult(proposal, config),
    ratio: calcuateRatio(proposal),
    requiredQuorum,
  }))
}

const checkIfVoted = (proposal: Proposal, address?: Addr) => {
  if (!address)
    return {
      votedAgents: false,
      votedFor: false,
      votedAmend: false,
      votedRemove: false,
      votedAlign: false,
      voted: false,
    }
  let voted = false
  const votedAgents = proposal.against_voters?.includes(address)
  const votedFor = proposal.for_voters?.includes(address)
  const votedAmend = proposal.amendment_voters?.includes(address)
  const votedRemove = proposal.removal_voters?.includes(address)
  const votedAlign = proposal.aligned_voters?.includes(address)
  if (votedAgents || votedFor || votedAmend || votedRemove || votedAlign) {
    voted = true
  }
  return {
    votedAgents,
    votedFor,
    votedAmend,
    votedRemove,
    votedAlign,
    voted,
  }
}

const getTotalVotingPower = async (proposal: Proposal) => {
  const client = await getGovernanceClient()

  return client.totalVotingPower({
    proposalId: Number(proposal.proposal_id),
  })
}

const getQuorum = async (proposal: Proposal) => {
  const { against_power, for_power, aligned_power, amendment_power, removal_power } = proposal

  const totalVotingPower = await getTotalVotingPower(proposal)

  console.log({ totalVotingPower })

  const power = num(against_power)
    .plus(for_power)
    .plus(aligned_power)
    .plus(amendment_power)
    .plus(removal_power)

  return power.div(totalVotingPower).dp(2).toNumber()

  // var quorum = (parseInt(proposal.against_power) + parseInt(proposal.for_power) + aligned_power + parseInt(proposal.amendment_power) + parseInt(proposal.removal_power)) / totalVotingPower;
}

export const getProposal = async (proposalId: number, address?: Addr) => {
  const client = await getGovernanceClient()
  const proposal = await client.proposal({ proposalId })
  const quorum = await getQuorum(proposal)
  const vote = checkIfVoted(proposal, address)

  return {
    ...proposal,
    ...vote,
    quorum,
  }
}
