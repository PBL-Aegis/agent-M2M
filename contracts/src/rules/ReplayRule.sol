// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PaymentRules} from "./PaymentRules.sol";

/// @title 재전송·연타 막기
/// @notice 서버의 src/lib/rules/replay.ts 와 같은 일을 체인에서 다시 한다. 구매자 지갑(from) 하나가 사용자 한 명이다.
///   - 요청 번호당 결제는 1번
///   - 한 지갑이 창(기본 60초) 안에 결제를 maxPaymentsPerWindow(기본 5)건 넘게 하지 못함
/// 창은 첫 결제 때 열리고, windowSeconds 가 지난 뒤의 첫 결제에서 새로 열린다.
/// 숫자는 운영자만 바꿀 수 있다. 기본값은 서버(AUDIT_REPLAY_MAX_PAYMENTS, AUDIT_REPLAY_WINDOW_SECONDS)와 같게 둔다.
abstract contract ReplayRule is Ownable, PaymentRules {
    uint256 public maxPaymentsPerWindow = 5;
    uint256 public windowSeconds = 60;

    mapping(bytes32 => bool) public usedRequestIds;
    mapping(address => uint256) public windowStart;
    mapping(address => uint256) public paymentsInWindow;

    error RequestIdReused(bytes32 requestId);
    error TooManyPayments(address from, uint256 count);
    error InvalidReplayLimit();

    event ReplayLimitChanged(uint256 maxPaymentsPerWindow, uint256 windowSeconds);

    function setReplayLimit(uint256 maxPayments, uint256 window) external onlyOwner {
        if (maxPayments == 0 || window == 0) revert InvalidReplayLimit();
        maxPaymentsPerWindow = maxPayments;
        windowSeconds = window;
        emit ReplayLimitChanged(maxPayments, window);
    }

    function _checkPayment(address from, address to, uint256 amount, bytes32 requestId) internal virtual override {
        super._checkPayment(from, to, amount, requestId);

        if (usedRequestIds[requestId]) revert RequestIdReused(requestId);
        usedRequestIds[requestId] = true;

        uint256 count;
        if (paymentsInWindow[from] == 0 || block.timestamp >= windowStart[from] + windowSeconds) {
            windowStart[from] = block.timestamp;
            count = 1;
        } else {
            count = paymentsInWindow[from] + 1;
        }
        if (count > maxPaymentsPerWindow) revert TooManyPayments(from, count);
        paymentsInWindow[from] = count;
    }
}
