/**
* This file was automatically generated by @cosmwasm/ts-codegen@0.35.3.
* DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
* and run the @cosmwasm/ts-codegen generate command to regenerate this file.
*/

import { CosmWasmClient, SigningCosmWasmClient, ExecuteResult } from "@cosmjs/cosmwasm-stargate";
import { StdFee } from "@cosmjs/amino";
import { Coin } from "@cosmjs/stargate";
import { Addr, Auction, Bid, SubmissionItem, SubmissionInfo, Uint128, BidAssetAuction, Decimal, Config, ExecuteMsg, Timestamp, Uint64, InstantiateMsg, CollectionParams, CollectionInfoForRoyaltyInfoResponse, RoyaltyInfoResponse, PendingAuctionResponse, QueryMsg, SubmissionsResponse, Votes } from "./BraneAuction.types";
export interface BraneAuctionReadOnlyInterface {
  contractAddress: string;
  config: () => Promise<Config>;
  submissions: ({
    limit,
    startAfter,
    submissionId
  }: {
    limit?: number;
    startAfter?: number;
    submissionId?: number;
  }) => Promise<SubmissionsResponse>;
  pendingAuctions: ({
    limit,
    startAfter
  }: {
    limit?: number;
    startAfter?: number;
  }) => Promise<PendingAuctionResponse>;
  liveNftAuction: () => Promise<Auction>;
  liveBidAssetAuction: () => Promise<BidAssetAuction>;
}
export class BraneAuctionQueryClient implements BraneAuctionReadOnlyInterface {
  client: CosmWasmClient;
  contractAddress: string;

  constructor(client: CosmWasmClient, contractAddress: string) {
    this.client = client;
    this.contractAddress = contractAddress;
    this.config = this.config.bind(this);
    this.submissions = this.submissions.bind(this);
    this.pendingAuctions = this.pendingAuctions.bind(this);
    this.liveNftAuction = this.liveNftAuction.bind(this);
    this.liveBidAssetAuction = this.liveBidAssetAuction.bind(this);
  }

  config = async (): Promise<Config> => {
    return this.client.queryContractSmart(this.contractAddress, {
      config: {}
    });
  };
  submissions = async ({
    limit,
    startAfter,
    submissionId
  }: {
    limit?: number;
    startAfter?: number;
    submissionId?: number;
  }): Promise<SubmissionsResponse> => {
    return this.client.queryContractSmart(this.contractAddress, {
      submissions: {
        limit,
        start_after: startAfter,
        submission_id: submissionId
      }
    });
  };
  pendingAuctions = async ({
    limit,
    startAfter
  }: {
    limit?: number;
    startAfter?: number;
  }): Promise<PendingAuctionResponse> => {
    return this.client.queryContractSmart(this.contractAddress, {
      pending_auctions: {
        limit,
        start_after: startAfter
      }
    });
  };
  liveNftAuction = async (): Promise<Auction> => {
    return this.client.queryContractSmart(this.contractAddress, {
      live_nft_auction: {}
    });
  };
  liveBidAssetAuction = async (): Promise<BidAssetAuction> => {
    return this.client.queryContractSmart(this.contractAddress, {
      live_bid_asset_auction: {}
    });
  };
}
export interface BraneAuctionInterface extends BraneAuctionReadOnlyInterface {
  contractAddress: string;
  sender: string;
  submitNft: ({
    proceedRecipient,
    tokenUri
  }: {
    proceedRecipient: string;
    tokenUri: string;
  }, fee?: number | StdFee | "auto", memo?: string, _funds?: Coin[]) => Promise<ExecuteResult>;
  voteToCurate: ({
    submissionIds
  }: {
    submissionIds: number[];
  }, fee?: number | StdFee | "auto", memo?: string, _funds?: Coin[]) => Promise<ExecuteResult>;
  bidForNft: (fee?: number | StdFee | "auto", memo?: string, _funds?: Coin[]) => Promise<ExecuteResult>;
  bidForAssets: (fee?: number | StdFee | "auto", memo?: string, _funds?: Coin[]) => Promise<ExecuteResult>;
  concludeAuction: (fee?: number | StdFee | "auto", memo?: string, _funds?: Coin[]) => Promise<ExecuteResult>;
  updateConfig: ({
    auctionPeriod,
    bidDenom,
    curationThreshold,
    freeVoteAddr,
    incentiveBidPercent,
    incentiveDenom,
    minimumOutbid,
    mintCost,
    owner,
    submissionCost,
    submissionLimit,
    submissionVotePeriod
  }: {
    auctionPeriod?: number;
    bidDenom?: string;
    curationThreshold?: Decimal;
    freeVoteAddr?: string;
    incentiveBidPercent?: Decimal;
    incentiveDenom?: string;
    minimumOutbid?: Decimal;
    mintCost?: number;
    owner?: string;
    submissionCost?: number;
    submissionLimit?: number;
    submissionVotePeriod?: number;
  }, fee?: number | StdFee | "auto", memo?: string, _funds?: Coin[]) => Promise<ExecuteResult>;
}
export class BraneAuctionClient extends BraneAuctionQueryClient implements BraneAuctionInterface {
  client: SigningCosmWasmClient;
  sender: string;
  contractAddress: string;

  constructor(client: SigningCosmWasmClient, sender: string, contractAddress: string) {
    super(client, contractAddress);
    this.client = client;
    this.sender = sender;
    this.contractAddress = contractAddress;
    this.submitNft = this.submitNft.bind(this);
    this.voteToCurate = this.voteToCurate.bind(this);
    this.bidForNft = this.bidForNft.bind(this);
    this.bidForAssets = this.bidForAssets.bind(this);
    this.concludeAuction = this.concludeAuction.bind(this);
    this.updateConfig = this.updateConfig.bind(this);
  }

  submitNft = async ({
    proceedRecipient,
    tokenUri
  }: {
    proceedRecipient: string;
    tokenUri: string;
  }, fee: number | StdFee | "auto" = "auto", memo?: string, _funds?: Coin[]): Promise<ExecuteResult> => {
    return await this.client.execute(this.sender, this.contractAddress, {
      submit_nft: {
        proceed_recipient: proceedRecipient,
        token_uri: tokenUri
      }
    }, fee, memo, _funds);
  };
  voteToCurate = async ({
    submissionIds
  }: {
    submissionIds: number[];
  }, fee: number | StdFee | "auto" = "auto", memo?: string, _funds?: Coin[]): Promise<ExecuteResult> => {
    return await this.client.execute(this.sender, this.contractAddress, {
      vote_to_curate: {
        submission_ids: submissionIds
      }
    }, fee, memo, _funds);
  };
  bidForNft = async (fee: number | StdFee | "auto" = "auto", memo?: string, _funds?: Coin[]): Promise<ExecuteResult> => {
    return await this.client.execute(this.sender, this.contractAddress, {
      bid_for_nft: {}
    }, fee, memo, _funds);
  };
  bidForAssets = async (fee: number | StdFee | "auto" = "auto", memo?: string, _funds?: Coin[]): Promise<ExecuteResult> => {
    return await this.client.execute(this.sender, this.contractAddress, {
      bid_for_assets: {}
    }, fee, memo, _funds);
  };
  concludeAuction = async (fee: number | StdFee | "auto" = "auto", memo?: string, _funds?: Coin[]): Promise<ExecuteResult> => {
    return await this.client.execute(this.sender, this.contractAddress, {
      conclude_auction: {}
    }, fee, memo, _funds);
  };
  updateConfig = async ({
    auctionPeriod,
    bidDenom,
    curationThreshold,
    freeVoteAddr,
    incentiveBidPercent,
    incentiveDenom,
    minimumOutbid,
    mintCost,
    owner,
    submissionCost,
    submissionLimit,
    submissionVotePeriod
  }: {
    auctionPeriod?: number;
    bidDenom?: string;
    curationThreshold?: Decimal;
    freeVoteAddr?: string;
    incentiveBidPercent?: Decimal;
    incentiveDenom?: string;
    minimumOutbid?: Decimal;
    mintCost?: number;
    owner?: string;
    submissionCost?: number;
    submissionLimit?: number;
    submissionVotePeriod?: number;
  }, fee: number | StdFee | "auto" = "auto", memo?: string, _funds?: Coin[]): Promise<ExecuteResult> => {
    return await this.client.execute(this.sender, this.contractAddress, {
      update_config: {
        auction_period: auctionPeriod,
        bid_denom: bidDenom,
        curation_threshold: curationThreshold,
        free_vote_addr: freeVoteAddr,
        incentive_bid_percent: incentiveBidPercent,
        incentive_denom: incentiveDenom,
        minimum_outbid: minimumOutbid,
        mint_cost: mintCost,
        owner,
        submission_cost: submissionCost,
        submission_limit: submissionLimit,
        submission_vote_period: submissionVotePeriod
      }
    }, fee, memo, _funds);
  };
}