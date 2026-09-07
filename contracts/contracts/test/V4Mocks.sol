// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUniswapV4PoolManager, IUniswapV4PositionManager} from "../interfaces/IUniswapV4.sol";

contract MockV4PoolManager is IUniswapV4PoolManager {
    bytes32 public lastPoolKey;
    uint160 public lastSqrtPriceX96;

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24) {
        lastPoolKey = keccak256(abi.encode(key));
        lastSqrtPriceX96 = sqrtPriceX96;
        return 0;
    }
}

contract MockV4PositionManager is IUniswapV4PositionManager {
    uint256 public nextTokenId = 1;
    bytes public lastUnlockData;

    function modifyLiquidities(bytes calldata unlockData, uint256) external payable {
        lastUnlockData = unlockData;
        ++nextTokenId;
    }
}
