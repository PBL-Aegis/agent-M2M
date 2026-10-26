// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AegisToken} from "../src/AegisToken.sol";

contract AegisTokenTest is Test {
    AegisToken token;
    address owner = makeAddr("owner");
    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");

    function setUp() public {
        token = new AegisToken(owner);
    }

    function test_decimalsIsSix() public view {
        assertEq(token.decimals(), 6);
    }

    function test_ownerMints() public {
        vm.prank(owner);
        token.mint(buyer, 3_000_000);
        assertEq(token.balanceOf(buyer), 3_000_000);
    }

    function test_othersCannotMint() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        token.mint(buyer, 1);
    }

    function test_transferMovesBalance() public {
        vm.prank(owner);
        token.mint(buyer, 400_000);
        vm.prank(buyer);
        token.transfer(seller, 400_000);
        assertEq(token.balanceOf(seller), 400_000);
        assertEq(token.balanceOf(buyer), 0);
    }
}
