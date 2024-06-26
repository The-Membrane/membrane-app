/**
* This file was automatically generated by @cosmwasm/ts-codegen@0.35.7.
* DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
* and run the @cosmwasm/ts-codegen generate command to regenerate this file.
*/

import { UseQueryOptions, useQuery, useMutation, UseMutationOptions } from "@tanstack/react-query";
import { ExecuteResult } from "@cosmjs/cosmwasm-stargate";
import { StdFee, Coin } from "@cosmjs/amino";
import { Uint256, Uint128, Decimal256, BidResponse, ClaimsResponse, AssetInfo, Addr, Config, ExecuteMsg, Decimal, BidInput, InstantiateMsg, LiquidatibleResponse, QueryMsg, QueueResponse, Asset, SlotResponse, Bid } from "./LiquidationQueue.types";
import { LiquidationQueueQueryClient, LiquidationQueueClient } from "./LiquidationQueue.client";
export const liquidationQueueQueryKeys = {
  contract: ([{
    contract: "liquidationQueue"
  }] as const),
  address: (contractAddress: string | undefined) => ([{ ...liquidationQueueQueryKeys.contract[0],
    address: contractAddress
  }] as const),
  config: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "config",
    args
  }] as const),
  bid: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "bid",
    args
  }] as const),
  bidsByUser: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "bids_by_user",
    args
  }] as const),
  queue: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "queue",
    args
  }] as const),
  queues: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "queues",
    args
  }] as const),
  checkLiquidatible: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "check_liquidatible",
    args
  }] as const),
  userClaims: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "user_claims",
    args
  }] as const),
  premiumSlot: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "premium_slot",
    args
  }] as const),
  premiumSlots: (contractAddress: string | undefined, args?: Record<string, unknown>) => ([{ ...liquidationQueueQueryKeys.address(contractAddress)[0],
    method: "premium_slots",
    args
  }] as const)
};
export const liquidationQueueQueries = {
  config: <TData = ConfigResponse,>({
    client,
    options
  }: LiquidationQueueConfigQuery<TData>): UseQueryOptions<ConfigResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.config(client?.contractAddress),
    queryFn: () => client ? client.config() : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  bid: <TData = BidResponse,>({
    client,
    args,
    options
  }: LiquidationQueueBidQuery<TData>): UseQueryOptions<BidResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.bid(client?.contractAddress, args),
    queryFn: () => client ? client.bid({
      bidFor: args.bidFor,
      bidId: args.bidId
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  bidsByUser: <TData = BidsByUserResponse,>({
    client,
    args,
    options
  }: LiquidationQueueBidsByUserQuery<TData>): UseQueryOptions<BidsByUserResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.bidsByUser(client?.contractAddress, args),
    queryFn: () => client ? client.bidsByUser({
      bidFor: args.bidFor,
      limit: args.limit,
      startAfter: args.startAfter,
      user: args.user
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  queue: <TData = QueueResponse,>({
    client,
    args,
    options
  }: LiquidationQueueQueueQuery<TData>): UseQueryOptions<QueueResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.queue(client?.contractAddress, args),
    queryFn: () => client ? client.queue({
      bidFor: args.bidFor
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  queues: <TData = QueuesResponse,>({
    client,
    args,
    options
  }: LiquidationQueueQueuesQuery<TData>): UseQueryOptions<QueuesResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.queues(client?.contractAddress, args),
    queryFn: () => client ? client.queues({
      limit: args.limit,
      startAfter: args.startAfter
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  checkLiquidatible: <TData = CheckLiquidatibleResponse,>({
    client,
    args,
    options
  }: LiquidationQueueCheckLiquidatibleQuery<TData>): UseQueryOptions<CheckLiquidatibleResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.checkLiquidatible(client?.contractAddress, args),
    queryFn: () => client ? client.checkLiquidatible({
      bidFor: args.bidFor,
      collateralAmount: args.collateralAmount,
      collateralPrice: args.collateralPrice,
      creditInfo: args.creditInfo,
      creditPrice: args.creditPrice
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  userClaims: <TData = UserClaimsResponse,>({
    client,
    args,
    options
  }: LiquidationQueueUserClaimsQuery<TData>): UseQueryOptions<UserClaimsResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.userClaims(client?.contractAddress, args),
    queryFn: () => client ? client.userClaims({
      user: args.user
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  premiumSlot: <TData = PremiumSlotResponse,>({
    client,
    args,
    options
  }: LiquidationQueuePremiumSlotQuery<TData>): UseQueryOptions<PremiumSlotResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.premiumSlot(client?.contractAddress, args),
    queryFn: () => client ? client.premiumSlot({
      bidFor: args.bidFor,
      premium: args.premium
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  }),
  premiumSlots: <TData = PremiumSlotsResponse,>({
    client,
    args,
    options
  }: LiquidationQueuePremiumSlotsQuery<TData>): UseQueryOptions<PremiumSlotsResponse, Error, TData> => ({
    queryKey: liquidationQueueQueryKeys.premiumSlots(client?.contractAddress, args),
    queryFn: () => client ? client.premiumSlots({
      bidFor: args.bidFor,
      limit: args.limit,
      startAfter: args.startAfter
    }) : Promise.reject(new Error("Invalid client")),
    ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  })
};
export interface LiquidationQueueReactQuery<TResponse, TData = TResponse> {
  client: LiquidationQueueQueryClient | undefined;
  options?: Omit<UseQueryOptions<TResponse, Error, TData>, "'queryKey' | 'queryFn' | 'initialData'"> & {
    initialData?: undefined;
  };
}
export interface LiquidationQueuePremiumSlotsQuery<TData> extends LiquidationQueueReactQuery<PremiumSlotsResponse, TData> {
  args: {
    bidFor: AssetInfo;
    limit?: number;
    startAfter?: number;
  };
}
export function useLiquidationQueuePremiumSlotsQuery<TData = PremiumSlotsResponse>({
  client,
  args,
  options
}: LiquidationQueuePremiumSlotsQuery<TData>) {
  return useQuery<PremiumSlotsResponse, Error, TData>(liquidationQueueQueryKeys.premiumSlots(client?.contractAddress, args), () => client ? client.premiumSlots({
    bidFor: args.bidFor,
    limit: args.limit,
    startAfter: args.startAfter
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueuePremiumSlotQuery<TData> extends LiquidationQueueReactQuery<PremiumSlotResponse, TData> {
  args: {
    bidFor: AssetInfo;
    premium: number;
  };
}
export function useLiquidationQueuePremiumSlotQuery<TData = PremiumSlotResponse>({
  client,
  args,
  options
}: LiquidationQueuePremiumSlotQuery<TData>) {
  return useQuery<PremiumSlotResponse, Error, TData>(liquidationQueueQueryKeys.premiumSlot(client?.contractAddress, args), () => client ? client.premiumSlot({
    bidFor: args.bidFor,
    premium: args.premium
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueUserClaimsQuery<TData> extends LiquidationQueueReactQuery<UserClaimsResponse, TData> {
  args: {
    user: string;
  };
}
export function useLiquidationQueueUserClaimsQuery<TData = UserClaimsResponse>({
  client,
  args,
  options
}: LiquidationQueueUserClaimsQuery<TData>) {
  return useQuery<UserClaimsResponse, Error, TData>(liquidationQueueQueryKeys.userClaims(client?.contractAddress, args), () => client ? client.userClaims({
    user: args.user
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueCheckLiquidatibleQuery<TData> extends LiquidationQueueReactQuery<CheckLiquidatibleResponse, TData> {
  args: {
    bidFor: AssetInfo;
    collateralAmount: Uint256;
    collateralPrice: Decimal;
    creditInfo: AssetInfo;
    creditPrice: Decimal;
  };
}
export function useLiquidationQueueCheckLiquidatibleQuery<TData = CheckLiquidatibleResponse>({
  client,
  args,
  options
}: LiquidationQueueCheckLiquidatibleQuery<TData>) {
  return useQuery<CheckLiquidatibleResponse, Error, TData>(liquidationQueueQueryKeys.checkLiquidatible(client?.contractAddress, args), () => client ? client.checkLiquidatible({
    bidFor: args.bidFor,
    collateralAmount: args.collateralAmount,
    collateralPrice: args.collateralPrice,
    creditInfo: args.creditInfo,
    creditPrice: args.creditPrice
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueQueuesQuery<TData> extends LiquidationQueueReactQuery<QueuesResponse, TData> {
  args: {
    limit?: number;
    startAfter?: AssetInfo;
  };
}
export function useLiquidationQueueQueuesQuery<TData = QueuesResponse>({
  client,
  args,
  options
}: LiquidationQueueQueuesQuery<TData>) {
  return useQuery<QueuesResponse, Error, TData>(liquidationQueueQueryKeys.queues(client?.contractAddress, args), () => client ? client.queues({
    limit: args.limit,
    startAfter: args.startAfter
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueQueueQuery<TData> extends LiquidationQueueReactQuery<QueueResponse, TData> {
  args: {
    bidFor: AssetInfo;
  };
}
export function useLiquidationQueueQueueQuery<TData = QueueResponse>({
  client,
  args,
  options
}: LiquidationQueueQueueQuery<TData>) {
  return useQuery<QueueResponse, Error, TData>(liquidationQueueQueryKeys.queue(client?.contractAddress, args), () => client ? client.queue({
    bidFor: args.bidFor
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueBidsByUserQuery<TData> extends LiquidationQueueReactQuery<BidsByUserResponse, TData> {
  args: {
    bidFor: AssetInfo;
    limit?: number;
    startAfter?: Uint128;
    user: string;
  };
}
export function useLiquidationQueueBidsByUserQuery<TData = BidsByUserResponse>({
  client,
  args,
  options
}: LiquidationQueueBidsByUserQuery<TData>) {
  return useQuery<BidsByUserResponse, Error, TData>(liquidationQueueQueryKeys.bidsByUser(client?.contractAddress, args), () => client ? client.bidsByUser({
    bidFor: args.bidFor,
    limit: args.limit,
    startAfter: args.startAfter,
    user: args.user
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueBidQuery<TData> extends LiquidationQueueReactQuery<BidResponse, TData> {
  args: {
    bidFor: AssetInfo;
    bidId: Uint128;
  };
}
export function useLiquidationQueueBidQuery<TData = BidResponse>({
  client,
  args,
  options
}: LiquidationQueueBidQuery<TData>) {
  return useQuery<BidResponse, Error, TData>(liquidationQueueQueryKeys.bid(client?.contractAddress, args), () => client ? client.bid({
    bidFor: args.bidFor,
    bidId: args.bidId
  }) : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueConfigQuery<TData> extends LiquidationQueueReactQuery<ConfigResponse, TData> {}
export function useLiquidationQueueConfigQuery<TData = ConfigResponse>({
  client,
  options
}: LiquidationQueueConfigQuery<TData>) {
  return useQuery<ConfigResponse, Error, TData>(liquidationQueueQueryKeys.config(client?.contractAddress), () => client ? client.config() : Promise.reject(new Error("Invalid client")), { ...options,
    enabled: !!client && (options?.enabled != undefined ? options.enabled : true)
  });
}
export interface LiquidationQueueUpdateConfigMutation {
  client: LiquidationQueueClient;
  msg: {
    maximumWaitingBids?: number;
    minimumBid?: Uint128;
    owner?: string;
    waitingPeriod?: number;
  };
  args?: {
    fee?: number | StdFee | "auto";
    memo?: string;
    funds?: Coin[];
  };
}
export function useLiquidationQueueUpdateConfigMutation(options?: Omit<UseMutationOptions<ExecuteResult, Error, LiquidationQueueUpdateConfigMutation>, "mutationFn">) {
  return useMutation<ExecuteResult, Error, LiquidationQueueUpdateConfigMutation>(({
    client,
    msg,
    args: {
      fee,
      memo,
      funds
    } = {}
  }) => client.updateConfig(msg, fee, memo, funds), options);
}
export interface LiquidationQueueUpdateQueueMutation {
  client: LiquidationQueueClient;
  msg: {
    bidFor: AssetInfo;
    bidThreshold?: Uint256;
    maxPremium?: Uint128;
  };
  args?: {
    fee?: number | StdFee | "auto";
    memo?: string;
    funds?: Coin[];
  };
}
export function useLiquidationQueueUpdateQueueMutation(options?: Omit<UseMutationOptions<ExecuteResult, Error, LiquidationQueueUpdateQueueMutation>, "mutationFn">) {
  return useMutation<ExecuteResult, Error, LiquidationQueueUpdateQueueMutation>(({
    client,
    msg,
    args: {
      fee,
      memo,
      funds
    } = {}
  }) => client.updateQueue(msg, fee, memo, funds), options);
}
export interface LiquidationQueueAddQueueMutation {
  client: LiquidationQueueClient;
  msg: {
    bidFor: AssetInfo;
    bidThreshold: Uint256;
    maxPremium: Uint128;
  };
  args?: {
    fee?: number | StdFee | "auto";
    memo?: string;
    funds?: Coin[];
  };
}
export function useLiquidationQueueAddQueueMutation(options?: Omit<UseMutationOptions<ExecuteResult, Error, LiquidationQueueAddQueueMutation>, "mutationFn">) {
  return useMutation<ExecuteResult, Error, LiquidationQueueAddQueueMutation>(({
    client,
    msg,
    args: {
      fee,
      memo,
      funds
    } = {}
  }) => client.addQueue(msg, fee, memo, funds), options);
}
export interface LiquidationQueueClaimLiquidationsMutation {
  client: LiquidationQueueClient;
  msg: {
    bidFor: AssetInfo;
    bidIds?: Uint128[];
  };
  args?: {
    fee?: number | StdFee | "auto";
    memo?: string;
    funds?: Coin[];
  };
}
export function useLiquidationQueueClaimLiquidationsMutation(options?: Omit<UseMutationOptions<ExecuteResult, Error, LiquidationQueueClaimLiquidationsMutation>, "mutationFn">) {
  return useMutation<ExecuteResult, Error, LiquidationQueueClaimLiquidationsMutation>(({
    client,
    msg,
    args: {
      fee,
      memo,
      funds
    } = {}
  }) => client.claimLiquidations(msg, fee, memo, funds), options);
}
export interface LiquidationQueueLiquidateMutation {
  client: LiquidationQueueClient;
  msg: {
    bidFor: AssetInfo;
    collateralAmount: Uint256;
    collateralPrice: Decimal;
    creditPrice: Decimal;
    positionId: Uint128;
    positionOwner: string;
  };
  args?: {
    fee?: number | StdFee | "auto";
    memo?: string;
    funds?: Coin[];
  };
}
export function useLiquidationQueueLiquidateMutation(options?: Omit<UseMutationOptions<ExecuteResult, Error, LiquidationQueueLiquidateMutation>, "mutationFn">) {
  return useMutation<ExecuteResult, Error, LiquidationQueueLiquidateMutation>(({
    client,
    msg,
    args: {
      fee,
      memo,
      funds
    } = {}
  }) => client.liquidate(msg, fee, memo, funds), options);
}
export interface LiquidationQueueRetractBidMutation {
  client: LiquidationQueueClient;
  msg: {
    amount?: Uint256;
    bidFor: AssetInfo;
    bidId: Uint128;
  };
  args?: {
    fee?: number | StdFee | "auto";
    memo?: string;
    funds?: Coin[];
  };
}
export function useLiquidationQueueRetractBidMutation(options?: Omit<UseMutationOptions<ExecuteResult, Error, LiquidationQueueRetractBidMutation>, "mutationFn">) {
  return useMutation<ExecuteResult, Error, LiquidationQueueRetractBidMutation>(({
    client,
    msg,
    args: {
      fee,
      memo,
      funds
    } = {}
  }) => client.retractBid(msg, fee, memo, funds), options);
}
export interface LiquidationQueueSubmitBidMutation {
  client: LiquidationQueueClient;
  msg: {
    bidInput: BidInput;
    bidOwner?: string;
  };
  args?: {
    fee?: number | StdFee | "auto";
    memo?: string;
    funds?: Coin[];
  };
}
export function useLiquidationQueueSubmitBidMutation(options?: Omit<UseMutationOptions<ExecuteResult, Error, LiquidationQueueSubmitBidMutation>, "mutationFn">) {
  return useMutation<ExecuteResult, Error, LiquidationQueueSubmitBidMutation>(({
    client,
    msg,
    args: {
      fee,
      memo,
      funds
    } = {}
  }) => client.submitBid(msg, fee, memo, funds), options);
}