// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PaymentRules} from "../src/rules/PaymentRules.sol";
import {ReplayRule} from "../src/rules/ReplayRule.sol";

/// AEGIS 의 pay 에 ReplayRule 만 붙인 시험용 토큰. 다른 사람의 규칙이 먼저 막지 않게 따로 둔다.
contract ReplayToken is ERC20, Ownable, PaymentRules, ReplayRule {
    constructor(address initialOwner) ERC20("AEGIS", "AEGIS") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function pay(address to, uint256 amount, bytes32 requestId) external {
        _checkPayment(msg.sender, to, amount, requestId);
        _transfer(msg.sender, to, amount);
    }

    function _checkPayment(address from, address to, uint256 amount, bytes32 requestId)
        internal
        override(PaymentRules, ReplayRule)
    {
        super._checkPayment(from, to, amount, requestId);
    }
}

contract ReplayRuleTest is Test {
    ReplayToken token;
    address owner = makeAddr("owner");
    address buyer = makeAddr("buyer");
    address other = makeAddr("other");
    address seller = makeAddr("seller");
    uint256 constant AMOUNT = 1_000;

    function setUp() public {
        token = new ReplayToken(owner);
        vm.startPrank(owner);
        token.mint(buyer, 1_000_000_000);
        token.mint(other, 1_000_000_000);
        vm.stopPrank();
    }

    function _pay(address from, bytes32 requestId) internal {
        vm.prank(from);
        token.pay(seller, AMOUNT, requestId);
    }

    function _id(string memory name, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(name, index));
    }

    function test_sameRequestIdPaysOnlyOnce() public {
        bytes32 requestId = keccak256("req-replay");
        _pay(buyer, requestId);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ReplayRule.RequestIdReused.selector, requestId));
        token.pay(seller, AMOUNT, requestId);
        assertEq(token.balanceOf(seller), AMOUNT);
    }

    function test_requestIdIsGlobalAcrossWallets() public {
        bytes32 requestId = keccak256("req-shared");
        _pay(buyer, requestId);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(ReplayRule.RequestIdReused.selector, requestId));
        token.pay(seller, AMOUNT, requestId);
    }

    function test_burstOverLimitReverts() public {
        uint256 max = token.rateLimit();
        for (uint256 i = 0; i < max; i++) _pay(buyer, _id("burst", i));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ReplayRule.TooManyPayments.selector, buyer, max + 1));
        token.pay(seller, AMOUNT, _id("burst", max));
        assertEq(token.balanceOf(seller), AMOUNT * max);
    }

    function test_windowResetsAfterWindowSeconds() public {
        uint256 max = token.rateLimit();
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i = 0; i < max; i++) _pay(buyer, _id("first", i));
        vm.warp(start + token.rateWindow() - 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ReplayRule.TooManyPayments.selector, buyer, max + 1));
        token.pay(seller, AMOUNT, _id("first", max));

        vm.warp(start + token.rateWindow());
        _pay(buyer, _id("second", 0));
        assertEq(token.paymentsInWindow(buyer), 1);
    }

    function test_limitIsPerWallet() public {
        uint256 max = token.rateLimit();
        for (uint256 i = 0; i < max; i++) _pay(buyer, _id("buyer", i));
        _pay(other, _id("other", 0));
        assertEq(token.paymentsInWindow(other), 1);
    }

    function test_ownerChangesLimit() public {
        uint256 max = token.rateLimit() + 2;
        uint256 window = token.rateWindow() * 2;
        vm.prank(owner);
        token.setRateLimit(max, window);
        assertEq(token.rateLimit(), max);
        assertEq(token.rateWindow(), window);
        for (uint256 i = 0; i < max; i++) _pay(buyer, _id("raised", i));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ReplayRule.TooManyPayments.selector, buyer, max + 1));
        token.pay(seller, AMOUNT, _id("raised", max));
    }

    function test_othersCannotChangeLimit() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        token.setRateLimit(100, 1);
    }

    function test_zeroLimitRejected() public {
        vm.prank(owner);
        vm.expectRevert(ReplayRule.InvalidRateLimit.selector);
        token.setRateLimit(0, 60);
    }
}
