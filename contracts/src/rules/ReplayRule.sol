// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PaymentRules} from "./PaymentRules.sol";

/// @title 재전송·연타 막기
/// @notice 구매자 지갑(from) 하나가 사용자 한 명이다. 요청 번호는 서버(src/lib/rules/replay.ts)에서도 막고, 횟수는 체인에서만 막는다.
///   - 요청 번호당 결제는 1번. 서버는 보관 기간이 지나면 잊지만 체인은 영구히 기억한다
///   - 한 지갑이 창(기본 60초) 안에 결제를 rateLimit(기본 5)건 넘게 하지 못함
/// 창은 첫 결제 때 열리고, rateWindow 가 지난 뒤의 첫 결제에서 새로 열린다.
/// 숫자는 운영자만 바꿀 수 있다.
abstract contract ReplayRule is Ownable, PaymentRules {
    uint256 public rateLimit = 5;
    uint256 public rateWindow = 60;

    mapping(bytes32 => bool) public usedRequestIds;
    mapping(address => uint256) public windowStart;
    mapping(address => uint256) public paymentsInWindow;

    error RequestIdReused(bytes32 requestId);
    error TooManyPayments(address from, uint256 count);
    error InvalidRateLimit();

    event RateLimitChanged(uint256 rateLimit, uint256 rateWindow);

    function setRateLimit(uint256 limit, uint256 window) external onlyOwner {
        if (limit == 0 || window == 0) revert InvalidRateLimit();
        rateLimit = limit;
        rateWindow = window;
        emit RateLimitChanged(limit, window);
    }

    function _checkPayment(address from, address to, uint256 amount, bytes32 requestId) internal virtual override {
        super._checkPayment(from, to, amount, requestId);

        if (usedRequestIds[requestId]) revert RequestIdReused(requestId);
        usedRequestIds[requestId] = true;

        uint256 count;
        if (paymentsInWindow[from] == 0 || block.timestamp >= windowStart[from] + rateWindow) {
            windowStart[from] = block.timestamp;
            count = 1;
        } else {
            count = paymentsInWindow[from] + 1;
        }
        if (count > rateLimit) revert TooManyPayments(from, count);
        paymentsInWindow[from] = count;
    }
}
