// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV4PoolManager, IUniswapV4PositionManager} from "../interfaces/IUniswapV4.sol";

interface IUnlockCallbackLike {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

contract MockPairRegistry {
    struct Economics {
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint8 decimals;
    }

    mapping(address => bool) public approvedPairTokens;
    mapping(address => Economics) public pairTokenEconomics;

    function configure(address token, uint256 phantomQuote, uint8 decimals, bool approved) external {
        approvedPairTokens[token] = approved;
        pairTokenEconomics[token] = Economics(phantomQuote, phantomQuote * 5 / 2, decimals);
    }
}

/// @dev Minimal but fund-accurate stand-in for the real v4 PoolManager. It
/// does not implement Uniswap's tick/liquidity math; instead the dev-buy swap
/// uses a fixed 1:1 nominal rate. This is enough to exercise
/// PotatoV4Pad's orchestration (unlock -> swap -> sync/settle -> take ->
/// refund) end to end against real ERC20 balances.
contract MockV4PoolManager is IUniswapV4PoolManager {
    bytes32 public lastPoolKey;
    uint160 public lastSqrtPriceX96;

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24) {
        lastPoolKey = keccak256(abi.encode(key));
        lastSqrtPriceX96 = sqrtPriceX96;
        return 0;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallbackLike(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory, SwapParams memory params, bytes calldata)
        external
        pure
        returns (int256 delta)
    {
        // Exact-input only, 1:1 nominal rate: caller owes `amountIn` on the
        // input side (negative) and receives `amountIn` on the output side
        // (positive). Direction is inferred purely from zeroForOne.
        int256 amountIn = -params.amountSpecified;
        int128 amount0;
        int128 amount1;
        if (params.zeroForOne) {
            amount0 = -int128(amountIn);
            amount1 = int128(amountIn);
        } else {
            amount0 = int128(amountIn);
            amount1 = -int128(amountIn);
        }
        assembly ("memory-safe") {
            delta := or(shl(128, amount0), and(sub(shl(128, 1), 1), amount1))
        }
    }

    function sync(address) external {}

    function settle() external payable returns (uint256) {
        return 0;
    }

    function take(address currency, address to, uint256 amount) external {
        IERC20(currency).transfer(to, amount);
    }
}

contract MockV4PositionManager is IUniswapV4PositionManager {
    uint256 public nextTokenId = 1;
    bytes public lastUnlockData;
    address public immutable poolManager;

    constructor(address poolManager_) {
        poolManager = poolManager_;
    }

    /// @dev Mirrors the real settle path closely enough for tests: SETTLE
    /// (0x0b) actions transfer this contract's own balance of the currency
    /// over to the PoolManager, exactly like the live PositionManager does
    /// when `payerIsUser` is false.
    function modifyLiquidities(bytes calldata unlockData, uint256) external payable {
        lastUnlockData = unlockData;
        (bytes memory actions, bytes[] memory params) =
            abi.decode(unlockData, (bytes, bytes[]));
        for (uint256 i; i < actions.length; ++i) {
            if (uint8(actions[i]) == 0x0b) {
                (address currency,,) = abi.decode(params[i], (address, uint256, bool));
                uint256 bal = IERC20(currency).balanceOf(address(this));
                if (bal != 0) IERC20(currency).transfer(poolManager, bal);
            } else if (uint8(actions[i]) == 0x11) {
                (address currency0, address currency1, address recipient) =
                    abi.decode(params[i], (address, address, address));
                uint256 amount0 = IERC20(currency0).balanceOf(address(this));
                uint256 amount1 = IERC20(currency1).balanceOf(address(this));
                if (amount0 != 0) IERC20(currency0).transfer(recipient, amount0);
                if (amount1 != 0) IERC20(currency1).transfer(recipient, amount1);
            }
        }
        ++nextTokenId;
    }
}
