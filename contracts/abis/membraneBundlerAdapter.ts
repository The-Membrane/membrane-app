// GENERATED from contracts/migrator/src/MembraneBundlerAdapter.sol (forge build, contracts/migrator/out) — do not edit.
export const membraneBundlerAdapterAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "bundler3",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "cdp",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "BUNDLER3",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CDP",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ICdpForAdapter"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "depositAndBorrowFor",
    "inputs": [
      {
        "name": "positionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "collateralDenom",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "maxBorrowCdt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "repayToken",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "repayTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "repayTarget",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "finalPositionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "MembraneLegExecuted",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "collateralDenom",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "collateralDeposited",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "borrowedCdt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "proceedsPulled",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BorrowAboveCap",
    "inputs": [
      {
        "name": "borrowCdt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxBorrowCdt",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoCollateral",
    "inputs": [
      {
        "name": "denom",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotOperator",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "adapter",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotPegPaired",
    "inputs": [
      {
        "name": "repayToken",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "paired",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotPositionOwner",
    "inputs": [
      {
        "name": "initiator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnauthorizedSender",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnregisteredCollateral",
    "inputs": [
      {
        "name": "denom",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const
