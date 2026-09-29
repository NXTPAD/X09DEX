// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title X09 Launch Token
/// @notice Fixed-supply ERC-20 launched from X09 DEX.
///         - Whole supply is minted once to the creator; no mint function exists.
///         - No buy/sell taxes, no blacklist, no pause.
///         - Optional anti-sniper: buys from the pool are refused for the first
///           `deadBlocks` blocks after trading opens, and for the first `antiSnipeBlocks`
///           blocks no wallet can hold more than `maxWallet` tokens.
///         - Before trading opens only the creator can move tokens (so liquidity can be
///           added safely). Once open, trading can never be closed again.
contract X09Token {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;
    string public metadataURI;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isLimitExempt;

    address public owner;
    address public pair;                      // main liquidity pool, set when trading opens
    uint256 public tradingBlock;              // 0 until trading opens
    uint256 public immutable deadBlocks;      // blocks after opening where pool buys revert
    uint256 public immutable antiSnipeBlocks; // length of the max-wallet window
    uint256 public immutable maxWallet;       // cap per wallet during the window

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TradingOpened(uint256 blockNumber, address pair);

    modifier onlyOwner() {
        require(msg.sender == owner, "X09: not owner");
        _;
    }

    /// @param name_           token name
    /// @param symbol_         token ticker
    /// @param supply_         total supply in whole tokens (18 decimals are added)
    /// @param maxWalletBps_   max wallet during anti-snipe window, in basis points of supply (1-10000)
    /// @param antiSnipeBlocks_ blocks the max-wallet rule lasts after trading opens (0 = off)
    /// @param deadBlocks_     blocks after opening in which buys from the pool are refused (0-5)
    /// @param openTrading_    open trading immediately (use when not adding liquidity from X09)
    /// @param metadataURI_    link to the token's JSON metadata (logo, socials)
    /// @param feeTo_          receives any launch fee sent with the deployment
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        uint256 maxWalletBps_,
        uint256 antiSnipeBlocks_,
        uint256 deadBlocks_,
        bool openTrading_,
        string memory metadataURI_,
        address feeTo_
    ) payable {
        require(supply_ > 0 && supply_ <= 1e15, "X09: bad supply");
        require(maxWalletBps_ > 0 && maxWalletBps_ <= 10000, "X09: bad max wallet");
        require(antiSnipeBlocks_ <= 1000, "X09: window too long");
        require(deadBlocks_ <= 5, "X09: too many dead blocks");

        name = name_;
        symbol = symbol_;
        metadataURI = metadataURI_;

        uint256 total = supply_ * 1e18;
        totalSupply = total;
        maxWallet = (total * maxWalletBps_) / 10000;
        antiSnipeBlocks = antiSnipeBlocks_;
        deadBlocks = deadBlocks_;

        owner = msg.sender;
        isLimitExempt[msg.sender] = true;
        balanceOf[msg.sender] = total;
        emit OwnershipTransferred(address(0), msg.sender);
        emit Transfer(address(0), msg.sender, total);

        if (openTrading_) {
            tradingBlock = block.number;
            emit TradingOpened(block.number, address(0));
        }

        if (msg.value > 0) {
            require(feeTo_ != address(0), "X09: no fee recipient");
            (bool ok, ) = payable(feeTo_).call{value: msg.value}("");
            require(ok, "X09: fee transfer failed");
        }
    }

    // ---------------------------------------------------------------- ERC-20

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "X09: allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "X09: zero address");

        if (tradingBlock == 0) {
            // Pre-launch: only the creator may move tokens (e.g. to add liquidity).
            require(from == owner || to == owner, "X09: trading not open");
        } else if (from == pair && pair != address(0) && to != owner && block.number < tradingBlock + deadBlocks) {
            revert("X09: launch blocks - buys open shortly");
        } else if (
            antiSnipeBlocks > 0 &&
            block.number < tradingBlock + antiSnipeBlocks &&
            !isLimitExempt[to]
        ) {
            require(balanceOf[to] + value <= maxWallet, "X09: anti-snipe max wallet");
        }

        uint256 bal = balanceOf[from];
        require(bal >= value, "X09: balance");
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // ---------------------------------------------------------------- creator

    /// @notice Opens trading forever. `pair` (the liquidity pool) is exempt from the
    ///         max-wallet rule so people can sell during the anti-snipe window.
    function openTrading(address pair_) external onlyOwner {
        require(tradingBlock == 0, "X09: already open");
        if (pair_ != address(0)) {
            pair = pair_;
            isLimitExempt[pair_] = true;
        }
        tradingBlock = block.number;
        emit TradingOpened(block.number, pair_);
    }

    /// @notice Gives up creator control. Only allowed once trading is open, so the
    ///         token can never be left stuck in pre-launch mode.
    function renounceOwnership() external onlyOwner {
        require(tradingBlock != 0, "X09: open trading first");
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function antiSnipeActive() external view returns (bool) {
        return tradingBlock != 0 && antiSnipeBlocks > 0 && block.number < tradingBlock + antiSnipeBlocks;
    }
}
