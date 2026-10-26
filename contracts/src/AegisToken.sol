// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AEGIS 토큰
/// @notice 구매 에이전트가 모델 값을 치르는 ERC-20. 소수점 6자리.
/// 감사 규칙(1건·하루 한도, 요청 번호 1회 처리 등)은 이 컨트랙트에 덧붙인다.
contract AegisToken is ERC20, Ownable {
    constructor(address initialOwner) ERC20("AEGIS", "AEGIS") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice 운영자만 새로 발급한다.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
