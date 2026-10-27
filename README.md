# agent-M2M

AI 구매 에이전트가 벤치마크 표를 보고 모델 하나를 고른 뒤, AEGIS 토큰(ERC-20, 1 AEGIS = 1달러)으로 값을 치르고, 판매창구가 결제를 확인한 뒤에만 결과를 돌려주는 데모입니다. 모델 선택은 LLM 없이 고정된 가중치 계산으로만 해서, 왜 그 모델이 골라졌는지 후보별 점수와 탈락 사유를 그대로 열어볼 수 있습니다. 요청에 우선순위가 없을 때만 로컬 Qwen(Ollama)이 요청 문장을 읽고 우선순위 하나를 정합니다. 모델 출력은 Mock이며 실제 OpenAI·Anthropic·Google API를 부르지 않습니다.

## 흐름

요청 → 감사(요청 직후) → 선택 → 기록(처리 중) → 감사(송금 직전) → 결제 → 확인 → 결과 → 기록(성공·실패) → 감사(결제 후)

1. **요청**: 요청 내용, 예산(AEGIS), 우선순위(싸게·빠르게·똑똑하게), 필요 기능, 요청 번호(`requestId`), 사용자(`userId`). 요청 번호를 비우면 서버가 만들고, 사용자를 비우면 비워 둔 채 기록합니다. 우선순위를 비우면 로컬 Qwen이 요청 문장에 적힌 선호(싸게·빨리·정확하게)를 보고 네 값 중 하나를 고르고, 선호가 없거나 서로 부딪히면 기본을 고릅니다. Qwen이 응답하지 않으면 결제 전에 멈춥니다(503). 화면에서는 기본을 직접 고르지 않고, 우선순위를 비워 둔 "요청 문장으로 판단"이 처음 값입니다.
2. **선택**: 후보마다 금액 계산 → 필요 기능으로 하드 필터 → 살아남은 후보끼리 가격·속도·성능 점수 → 가중치 합산 → 고정 규칙으로 동점 처리. 예산은 선택에서 거르지 않습니다(이상 거래 시나리오를 재현하기 위해).
3. **기록(처리 중)**: 결제 직전에 `PROCESSING` 상태로 MongoDB에 먼저 남김.
4. **감사**: `src/lib/rules/` 에 등록한 규칙을 세 자리에서 돌림. 규칙이 막으면 "차단", 막지 않고 알리면 "경고" 알림이 `alerts` 컬렉션에 남고 대시보드의 이상 거래에 뜸.
   - 요청 직후(`ON_REQUEST_CHECKS`): 모델을 고르기 전. 막으면 기록 없이 409. 이전 기록을 돌려주면 새로 처리하지 않고 그 기록을 응답.
   - 송금 직전(`BEFORE_PAYMENT_CHECKS`): 막으면 송금하지 않고 송금 전 실패로 기록.
   - 결제 후(`AFTER_PAYMENT_CHECKS`): 성공·실패가 기록된 뒤. 예약한 한도 되돌리기 등. 여기서 실패해도 결과는 바뀌지 않고 알림으로 남음.
5. **결제**: 선택된 모델의 수신자 주소로 AEGIS `pay(수신자, 금액, 요청 번호)` (기본은 로컬 체인). 요청 번호는 문자열의 keccak256 으로 넘깁니다.
6. **확인**: 판매창구가 체인의 `Paid` 기록에서 요청 번호·수신자·금액을 대조.
7. **결과**: Mock 응답 문장.
8. **기록(성공·실패)**: 같은 기록의 상태를 `SETTLED` 또는 `FAILED` 로 바꿈. 실패는 송금 전(`before-send`)·송금 후(`after-send`)를 구분하고, 송금 후 실패면 거래번호를 그대로 남김. 후보·점수·탈락 사유 같은 결정 근거는 처음 저장한 뒤 고치지 않음.

## 화면

| 경로 | 내용 |
| --- | --- |
| `/` | 새 구매 요청 |
| `/dashboard` | 요약(구매자 지갑 잔액·정산 거래·결제 합계·이상 거래 수) · 최근 기록 · 최근 이상 거래 |
| `/dashboard/purchases` | 전체 요청·결제 기록 |
| `/dashboard/alerts` | 이상 거래: 감사 규칙이 막은 거래(차단)와 경고 |
| `/dashboard/[id]` | 기록 한 건의 결정 근거와 그 거래의 이상 거래 알림 |

## 처음 시작하기

### 1. 설치할 것

| 도구 | 쓰는 곳 | 꼭 필요한가 |
| --- | --- | --- |
| Node.js 22 | 앱 실행·테스트 | 필요 |
| MongoDB | 구매 기록 저장. 자동 테스트도 임시 DB를 만들어 씀 | 필요 |
| [Foundry](https://getfoundry.sh) (`forge`, `anvil`) | 컨트랙트 빌드·테스트, 로컬 체인(`npm test` 도 씀) | 필요 |
| [Ollama](https://ollama.com) + `qwen3.5:4b` | 우선순위를 비운 요청에서 요청 문장을 읽고 우선순위를 정함 | 선택 |

### 2. 받고 준비하기

```bash
git clone git@github.com:PBL-Aegis/agent-M2M.git
cd agent-M2M
git submodule update --init --recursive   # 컨트랙트 라이브러리(OpenZeppelin, forge-std)
npm install
cp .env.example .env.local                # 값은 .env.local 에만 넣는다
```

`.env.local` 은 그대로 두어도 로컬 체인으로 돌아갑니다. `AA_API_KEY` 는 판매 목록을 다시 만들 때 필요하고, 없으면 1시간마다 하는 숫자 갱신만 건너뛰고 저장된 숫자로 계속 돕니다.

### 3. 실행하기

```bash
npm run chain      # 창 1: 로컬 체인(anvil)을 띄우고 토큰 배포·구매자에게 1000 AEGIS 발급. 켜 둔다
npm run dev        # 창 2: http://localhost:3100
```

MongoDB 가 꺼져 있으면 먼저 켭니다(아래 "기록 저장소").

### 4. Ollama 는 언제 필요한가

요청에 우선순위(`price`·`speed`·`intelligence`)가 **없을 때만** 씁니다. 이때 Qwen 이 요청 문장을 읽고 우선순위를 스스로 정하고, 문장에 선호가 없거나 서로 부딪히면 **기본 비중(34·33·33)** 을 씁니다(아래 "벤치마크와 판매 모델"의 비중표). 채팅 화면의 처음 값 "요청 문장으로 판단"이 이 경우입니다.

```bash
ollama pull qwen3.5:4b    # 한 번만. 약 3.3GB
```

우선순위를 넣어 보내면 Ollama 없이도 모든 기능이 돌아갑니다. Ollama 가 꺼진 채 우선순위를 비워 보내면 결제 전에 멈춥니다(503).

### 5. 확인 명령

```bash
npm test                    # 서버 자동 테스트 (vitest). 테스트용 로컬 체인을 스스로 켜고 끈다
npm run typecheck
npm run build
cd contracts && forge test  # 컨트랙트 테스트
```

## 요청 보내기

화면 대신 에이전트처럼 API 로 보낼 수 있습니다. 사람이 적는 금액(API 의 `budget`, 설정값)은 AEGIS 로 적습니다(1 AEGIS = 1달러).

**units 는 코드와 체인 안에서만 씁니다**: 블록체인은 소수점을 저장할 수 없어서, 토큰 금액을 정수로만 셉니다. AEGIS 는 소수점 6자리라 0.16 AEGIS 를 160000 이라는 정수로 저장하는데, 이 정수 단위를 units 라고 부릅니다(1 AEGIS = 1,000,000 units). 은행이 1,000.50달러를 내부에서 100,050센트로 다루는 것과 같고, USDC 도 같은 방식입니다. 서버는 받은 AEGIS 금액을 units 로 바꿔 계산하고, 기록의 `amountUnits`·`budgetUnits` 도 units 입니다.

```bash
# 우선순위를 직접 정해 보냄. Ollama 필요 없음
curl -s -X POST localhost:3100/api/purchase -H 'content-type: application/json' \
  -d '{"prompt":"이 글 요약해 줘","budget":"0.5","priority":"price","requestId":"req-001","userId":"user-a"}'

# 우선순위를 비움. Qwen 이 문장("급해")을 읽고 speed 로 정함
curl -s -X POST localhost:3100/api/purchase -H 'content-type: application/json' \
  -d '{"prompt":"급해, 빨리 이 글 요약해 줘","budget":"0.5"}'
```

| 필드 | 필수 | 뜻 |
| --- | --- | --- |
| `prompt` | 예 | 요청 문장 |
| `budget` | 예 | 예산(AEGIS, 예: `"0.5"`. 소수점 6자리까지). 선택에서 거르지는 않고 기록에 남김. 예전 이름 `budgetUnits` 는 받지 않음 |
| `priority` | 아니오 | `price`·`speed`·`intelligence`. 비우면 Qwen 이 문장을 읽고 정함(`default` 를 직접 보낼 수도 있음) |
| `requestId` | 아니오 | 요청 번호. 같은 요청을 다시 보낼 때 같은 값. 비우면 서버가 만듦 |
| `userId` | 아니오 | 요청한 사용자 |
| `maxOutputTokens` | 아니오 | 최대 출력 토큰(기본 8000). 금액 계산에 씀 |
| `requiredCapabilities` | 아니오 | `reasoning`·`tools`·`vision` 중 필요한 것 |

| 응답 | 언제 | 기록 |
| --- | --- | --- |
| 200 + 기록(`status: SETTLED`) | 결제와 확인까지 성공 | 남음 |
| 200 + 기록(`status: FAILED`) | 송금 직전 감사 규칙이 막음, 결제·확인 실패. `failureStage` 로 송금 전·후 구분 | 남음 |
| 400 | 입력 형식이 틀림, 조건을 통과한 후보가 없음 | 없음 |
| 409 | 요청 직후 감사 규칙이 막음(예: 같은 요청이 처리 중). 본문에 `rule` | 없음 |
| 503 | 우선순위를 비웠는데 Ollama 가 응답하지 않음 | 없음 |

## 감사 규칙 추가하기

같은 이상행위를 서버와 체인 두 곳에서 막습니다. 서버는 빨리 거르고 알림을 남기고, 체인은 서버가 뚫려도 마지막에 막습니다. 각자 **새 파일**을 만들고, 함께 쓰는 파일에는 등록 한 줄만 더합니다.

### 서버 규칙

1. `src/lib/rules/<규칙이름>.ts` 를 만들고, 맞는 자리에 함수를 push 합니다.

```ts
// src/lib/rules/max-amount.ts — 예시: 한 건 0.5 AEGIS 를 넘으면 막고, 80% 이상이면 알림만 남긴다
import { AuditBlockedError, BEFORE_PAYMENT_CHECKS } from "../audit";
import { parseAegis } from "../format";

// 숫자는 코드에 박지 않고 설정값으로 둔다. 사람이 적는 값은 AEGIS, 비교는 units 로.
const MAX_UNITS = parseAegis(process.env.AUDIT_MAX_AMOUNT ?? "0.5");
if (MAX_UNITS === null) throw new Error("AUDIT_MAX_AMOUNT 는 AEGIS 금액이어야 합니다 (예: 0.5)");
const WARN_RATIO = Number(process.env.AUDIT_MAX_AMOUNT_WARN_RATIO ?? "0.8");

BEFORE_PAYMENT_CHECKS.push(async (ctx) => {
  const amount = ctx.decision.winner.amountUnits;
  if (amount > MAX_UNITS) throw new AuditBlockedError("max-amount", `한 건 상한 초과: ${amount} units`);
  if (amount >= MAX_UNITS * WARN_RATIO) await ctx.alert("max-amount", `한 건 상한의 ${WARN_RATIO * 100}% 이상: ${amount} units`);
});
```

2. `src/lib/rules/index.ts` 에 `import "./max-amount";` 한 줄을 더합니다. 적은 순서대로 돕니다.

| 자리 | 언제 | 쓸 수 있는 값 | 막으면 |
| --- | --- | --- | --- |
| `ON_REQUEST_CHECKS` | 요청 직후, 모델을 고르기 전 | `ctx.request`(요청 번호·사용자·문장) | 기록 없이 409. 이전 기록을 `return` 하면 새로 처리하지 않고 그 기록을 응답 |
| `BEFORE_PAYMENT_CHECKS` | 모델을 고르고 처리 중 기록을 남긴 뒤, 송금 직전 | `ctx.request`, `ctx.decision`(고른 모델·금액·점수) | 송금하지 않고 `FAILED`·`before-send` 로 기록 |
| `AFTER_PAYMENT_CHECKS` | 결과가 기록된 뒤 | 위 값 + 두 번째 인자 `record`(최종 상태) | 막을 수 없음. 오류는 알림으로 남고 결과는 그대로 |

알림(`ctx.alert`)은 MongoDB `alerts` 컬렉션에 "경고"로 쌓입니다. 규칙이 막으면(`AuditBlockedError`) "차단" 알림이 자동으로 남으므로, 막을 때 따로 알림을 남기지 않아도 대시보드의 이상 거래에 뜹니다. 요청 직후에 막혀 구매 기록이 없는 경우도 요청 번호와 함께 남습니다. 요청 두 개가 거의 동시에 오면 둘 다 "아직 한도 안 넘었네"라고 보고 둘 다 통과할 수 있습니다. 그래서 "확인"과 "기록"을 MongoDB 명령 하나로 같이 합니다. 예: `findOneAndUpdate`(조건이 맞을 때만 바꾸기), unique index(같은 값 두 번 저장 금지). 변수에 잠금을 거는 방식은 서버가 여러 대면 통하지 않습니다.

### 체인 규칙 (Solidity)

1. `contracts/src/rules/<규칙이름>.sol` 에 `PaymentRules` 를 상속한 abstract contract 를 만듭니다. 먼저 `super._checkPayment(...)` 를 불러 다른 규칙도 돌게 하고, 막을 때 revert 합니다. 체인에서는 구매자 지갑 하나(`from`)를 사용자 한 명으로 봅니다.

```solidity
// contracts/src/rules/MaxAmountRule.sol — 예시
pragma solidity ^0.8.24;

import {PaymentRules} from "./PaymentRules.sol";

abstract contract MaxAmountRule is PaymentRules {
    uint256 public constant MAX_AMOUNT = 500_000; // 0.5 AEGIS
    error OverMaxAmount(uint256 amount);

    function _checkPayment(address from, address to, uint256 amount, bytes32 requestId) internal virtual override {
        super._checkPayment(from, to, amount, requestId);
        if (amount > MAX_AMOUNT) revert OverMaxAmount(amount);
    }
}
```

2. `contracts/src/AegisToken.sol` 에서 상속 목록과 `_checkPayment` 의 override 목록에 이름을 더합니다.

```solidity
contract AegisToken is ERC20, Ownable, PaymentRules, MaxAmountRule {
    // ...
    function _checkPayment(address from, address to, uint256 amount, bytes32 requestId)
        internal virtual override(PaymentRules, MaxAmountRule)
    {
        super._checkPayment(from, to, amount, requestId);
    }
}
```

`npm run chain` 을 다시 켜면 규칙이 담긴 토큰이 로컬 체인에 올라가고, 화면에서 막힌 결제는 송금 전 실패로 보입니다.

### 등록된 규칙

- **replay** (재전송·연타, `src/lib/rules/replay.ts`, `contracts/src/rules/ReplayRule.sol`): 같은 요청 번호는 한 번만 결제합니다. 다시 오면 요청 직후 기록 없이 409(`rule: "replay"`), 체인에서는 `RequestIdReused` 로 revert.
  한 사용자(체인에서는 구매자 지갑)가 `AUDIT_REPLAY_WINDOW_SECONDS`(기본 60)초 안에 `AUDIT_REPLAY_MAX_PAYMENTS`(기본 5)건을 넘겨 결제하면 송금 전에 막혀 `FAILED`·`before-send`(`rule: "replay-rate"`), 체인에서는 `TooManyPayments` 로 revert. 체인 값은 운영자가 `setReplayLimit` 로 바꿉니다.

### 테스트로 증명하기

공격을 재현하는 테스트가 통과하면 "막힌다"가 증명됩니다. 서버는 `tests/`, 체인은 `contracts/test/` 에 둡니다.

**서버 테스트(`npm test`)**
- `tests/purchase.test.ts` 처럼 `runPurchase` 를 불러 기록의 `status`·`failureStage`·알림을 확인합니다. 결제는 테스트용 로컬 체인에 진짜로 나가고, 세 사람의 체인 규칙이 모두 들어간 진짜 토큰을 거칩니다.
- **테스트마다 체인이 처음 상태로 돌아갑니다**(배포 직후, 구매자 1000 AEGIS, 한도·요청 번호 기록 없음). 한 테스트 안에서는 결제가 정상적으로 쌓입니다. 직접 할 일은 없고 `tests/setup/chain-snapshot.ts` 가 자동으로 합니다.
- 체인 시계를 앞으로 돌려야 하면(60초 뒤, 하루 뒤) `tests/helpers/chain.ts` 의 `increaseChainTime(초)` 를 씁니다.
- 서버 쪽 기록(MongoDB)은 테스트 파일마다 새 임시 DB 를 쓰지만, 한 파일 안의 테스트끼리는 이어집니다. 테스트마다 다른 `userId`·`requestId` 를 쓰면 서로 섞이지 않습니다.
- 다른 사람의 규칙이 합쳐져도 깨지지 않게, "몇 건이 성공했나"보다 **"내 규칙 이름으로 막혔나"**(차단 알림의 `rule`, 실패 이유)를 확인합니다. 예를 들어 한 테스트 안에서 결제를 6건 넘게 보내면 다른 사람의 "60초에 5건" 체인 규칙에 먼저 걸릴 수 있습니다.

**Solidity 테스트(`forge test`)**: 테스트 파일 안에 "AEGIS + 내 규칙만" 붙인 작은 토큰을 정의해서 시험합니다(`contracts/test/AegisToken.t.sol` 의 `RuledToken` 예시). 시간은 `vm.warp` 로 돌립니다.

## 테스트가 확인하는 것

| 명령 | 진짜로 도는 것 | 가짜로 바꾼 것 | 확인하지 않는 것 |
| --- | --- | --- | --- |
| `npm test` | 선택·점수 계산, 감사 규칙 자리와 알림, 기록(임시 MongoDB), 짝짓기 규칙, **로컬 체인 결제·체인 규칙·판매창구 확인**(테스트마다 체인을 처음 상태로 되돌림) | Qwen 응답, 세 벤치마크 사이트 응답, 벤치마크 숫자(`tests/fixtures/`) | Qwen 이 문장을 맞게 읽는지, 실제 사이트 값 |
| `forge test` | 컨트랙트(발급, `pay`, 규칙이 `pay` 를 막는지) | 없음(메모리 안의 체인) | 서버와 이어진 흐름 |
| `npm run chain` + `npm run dev` 후 요청 | 전체 흐름: 서버 규칙, 로컬 체인 결제·체인 규칙, 판매창구 확인 | 모델 응답(Mock 문장) | Base Sepolia 결제 |
| 위 + Ollama 켜고 우선순위 비워 요청 | Qwen 의 우선순위 판단까지 | 모델 응답(Mock 문장) | Base Sepolia 결제 |


## 스마트 컨트랙트

`contracts/` 는 Foundry 프로젝트입니다. 체인에서는 구매자 지갑 하나를 사용자 한 명으로 봅니다. `AegisToken` 은 소수점 6자리 ERC-20이며(1 AEGIS = 1달러 = 1,000,000 units, 위 "요청 보내기"의 설명) 운영자만 새로 발급합니다. 구매 결제는 `pay` 로 하며, `pay` 는 송금 전에 감사 규칙을 돌리고 `Paid(요청 번호, 보낸 쪽, 받는 쪽, 금액)` 이벤트를 남깁니다.

감사 규칙은 `contracts/src/rules/` 에 파일로 따로 둡니다. 규칙은 `PaymentRules` 를 상속해 `_checkPayment` 를 덮어쓰고, 먼저 `super._checkPayment(...)` 를 부른 뒤 막을 때 revert 합니다. `AegisToken` 에는 상속 목록과 `_checkPayment` 의 override 목록에 규칙 이름만 더합니다.

> Base Sepolia 에는 아직 배포하지 않았습니다. 기존 `AEGIS_TOKEN_ADDRESS`(`0xE208…142b`)에는 `pay` 가 없어서, live 결제는 이 컨트랙트를 배포하고 그 주소로 바꾼 뒤에만 동작합니다. local 은 `npm run chain` 이 띄울 때마다 배포합니다.

## 환경변수

`.env.example`을 `.env.local`로 복사해서 씁니다. 값은 `.env.local`에만 넣습니다.

| 이름 | 기본값 | 뜻 |
| --- | --- | --- |
| `AEGIS_PAYMENT_MODE` | `local` | `local`: 로컬 체인 · `live`: Base Sepolia 전송을 요청 |
| `AEGIS_LOCAL_RPC_URL` | `http://127.0.0.1:8545` | 로컬 체인 주소. 이 컴퓨터 주소만 받음. 자동 테스트는 `8546` 을 씀 |
| `AEGIS_REAL_PAYMENT_APPROVED` | `no` | `yes`여야 live가 실제로 켜짐 |
| `AEGIS_TOKEN_ADDRESS` | `0xE208…142b` | live 에서 쓰는 Base Sepolia AEGIS 토큰(소수점 6자리). 지금 값은 `pay` 가 없는 이전 토큰 |
| `AEGIS_CHAIN_ID` | `84532` | Base Sepolia |
| `AEGIS_RPC_URL` | `https://sepolia.base.org` | RPC |
| `AEGIS_BUYER_PRIVATE_KEY` | (비움) | 구매자 지갑 개인키. live에서만 필요 |
| `AA_API_KEY` | (비움) | Artificial Analysis API 키. 속도 값의 자동 갱신·판매 목록 생성에 필요 |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB 접속 주소 |
| `MONGODB_DB` | `agent_m2m` | 기록을 담을 데이터베이스 이름 |
| `AEGIS_OLLAMA_URL` | `http://127.0.0.1:11434` | 우선순위 추론용 Ollama. 루프백 주소만 받음 |
| `AEGIS_OLLAMA_MODEL` | `qwen3.5:4b` | 우선순위 추론 모델 |
| `AEGIS_OLLAMA_TIMEOUT_SECONDS` | `30` | 추론 대기 시간(초, 최대 60) |

## 결제 모드

| 모드 | 어디로 | 필요한 것 |
| --- | --- | --- |
| `local` (기본) | 이 컴퓨터의 anvil | `npm run chain` 을 켜 둠 |
| `live` | Base Sepolia | 아래 두 변수, 개인키, `pay` 가 있는 토큰 주소 |

자동 테스트(`npm test`)도 `local` 로 결제합니다. 시작할 때 테스트 전용 로컬 체인(8546)을 스스로 켜고 끝나면 끄므로, 개발용 `npm run chain`(8545)을 켜 둔 채로 돌려도 됩니다. 같은 구매자 지갑을 쓰므로 테스트 파일은 하나씩 돌고, 테스트마다 체인을 처음 상태로 되돌립니다.

`local` 은 감사 규칙이 담긴 컨트랙트를 그대로 올려 쓰므로, 체인에서 막히는 것까지 화면에서 확인할 수 있습니다. `npm run chain` 을 끄면 체인과 그 위의 잔액도 사라지고, 다시 켜면 빈 체인에 같은 주소로 새로 배포합니다. 계정은 anvil 의 공개 테스트 계정(0번 운영자, 1번 구매자)이라 실제 자산이 없습니다.

> **경고** — 실제 토큰 전송은 기본적으로 일어나지 않습니다(local). `AEGIS_PAYMENT_MODE=live` **와** `AEGIS_REAL_PAYMENT_APPROVED=yes` 두 변수가 모두 켜져 있고 개인키가 있을 때만 Base Sepolia에서 실제 `pay`가 실행됩니다. 1건당 금액 상한은 없으므로 live로 켤 때는 예산과 잔액을 직접 확인하세요. 개인키는 절대 커밋하지 마세요.

## 기술 스택

Next.js 15 (App Router) · React 19 · TypeScript · viem · MongoDB · Ollama(Qwen) · vitest · Solidity(Foundry·anvil, OpenZeppelin)

## 벤치마크와 판매 모델

판매 모델(`data/catalog.json`)과 점수의 시작값(`data/benchmark.json`)은 세 출처에서 떠온 실제 값입니다.

| 출처 | 쓰는 값 | 키 |
|---|---|---|
| [Epoch AI](https://epoch.ai/benchmarks) | 성능: Epoch Capabilities Index(ECI)와 95% 신뢰구간 | 필요 없음 |
| [OpenRouter](https://openrouter.ai/api/v1/models) | 가격: 1M 토큰당 입력·출력 판매 단가 | 필요 없음 |
| [Artificial Analysis](https://artificialanalysis.ai/methodology/performance-benchmarking) | 속도: 출력 속도(1초에 내보내는 토큰 수), 하루 여러 번 잰 값의 최근 72시간 중앙값 | `AA_API_KEY` |

점수는 출처 하나씩에서 나옵니다.

- 가격 점수 = (log 최고 금액 − log 내 금액) ÷ (log 최고 − log 최저) × 100
- 속도 점수 = (log 내 출력 속도 − log 최저) ÷ (log 최고 − log 최저) × 100
- 성능 점수 = (내 ECI − 최저 ECI) ÷ (최고 − 최저) × 100

세 점수 모두 후보 중 가장 나쁜 값 0점·가장 좋은 값 100점입니다. 가격과 속도는 후보끼리 몇 배~수십 배 차이 나서 로그로 폅니다. 2배 싼 것은 어느 가격대에서든 같은 만큼 점수가 오르고, 아주 싼 모델 하나가 나머지를 0점 가까이로 누르거나(비율 방식) 아주 비싼 모델 하나에 나머지가 끌려가는(직선 방식) 일이 줄어듭니다. ECI 는 여러 벤치마크를 문제 난이도까지 고려해 통계적으로 합친 지수라 서로 다른 시험을 치른 모델끼리도 비교할 수 있고, 차이 자체가 의미를 가지므로 그대로 폅니다. 결정 근거 화면에 ECI 와 신뢰구간, 속도를 잰 AA 항목 이름이 함께 나옵니다.

총점은 우선순위별 비중으로 합칩니다(`PRIORITY_WEIGHTS`, `src/lib/types.ts`).

| 우선순위 | 가격 | 속도 | 성능 | 언제 |
|---|---|---|---|---|
| 싸게 (`price`) | 80 | 10 | 10 | 요청이 정했거나 문장에 싸게·저렴하게 등이 있을 때 |
| 빠르게 (`speed`) | 10 | 80 | 10 | 요청이 정했거나 문장에 빨리·급해 등이 있을 때 |
| 똑똑하게 (`intelligence`) | 10 | 10 | 80 | 요청이 정했거나 문장에 정확하게·꼼꼼히 등이 있을 때 |
| 기본 (`default`) | 34 | 33 | 33 | 문장에 선호가 없거나 서로 부딪힐 때 |

우선순위는 이 순서로 정해집니다.

1. 요청에 우선순위(`price`·`speed`·`intelligence`)가 있으면 그대로 씁니다.
2. 없으면 LLM(지금은 로컬 Qwen)이 요청 문장에 적힌 선호를 읽고 정합니다.
3. 문장에 선호가 없거나(예: "이 글 요약해 줘") 서로 부딪히면(예: "싸고 정확하게") **기본**을 씁니다.

**기본은 사용자가 고르는 값이 아니라, 선호를 알 수 없을 때 쓰는 값**입니다. 그래서 채팅 화면에는 기본이 선택지로 없고 "요청 문장으로 판단"이 처음 값입니다. 선호를 모를 때 어느 한쪽으로 기울면 안 되므로 세 항목을 3분의 1씩(34·33·33) 나눴습니다. 나머지 셋은 원하는 항목에 80을 주고 나머지는 10씩 남겨서, 선호가 같은 후보끼리는 다른 항목으로 갈리게 했습니다. 예를 들어 "싸게"인데 금액이 비슷하면 더 빠르고 똑똑한 쪽이 이깁니다.

### 판매 모델을 고르는 규칙

`scripts/capture-benchmark.mjs` 가 세 출처를 짝지어 판매 목록을 만듭니다. 추측하지 않습니다.

- 세 출처의 모델 이름에서 기호를 빼고 소문자로 바꾼 값이 **정확히 같을 때만** 짝짓습니다.
- 판매 단위는 기본 모델 하나입니다. 생각 단계(effort)는 고르지 않습니다(아래 "속도를 출력 속도로 재는 이유").
- 값이 비거나 0 인 모델도 뺍니다. 빈칸을 기본값으로 채우지 않습니다.
- **판매 최소 품질 기준**: ECI 140 미만은 팔지 않습니다(`MIN_ECI`, `src/lib/benchmark-sources.mjs`). 운영 판단으로 정한 값이며, 새 모델에도 같은 규칙이 적용됩니다.
- 뺀 모델과 이유는 `data/catalog.json` 의 `excluded` 에 남습니다.
- 필요 기능(`requiredCapabilities`)은 OpenRouter 가 알려 준 `reasoning`, `tools`, `vision` 입니다.
- 판매자 주소는 회사별로 하나이며 `data/sellers.json` 에 있습니다. anvil 공개 테스트 계정이라 실제 자산이 없고, 처음 보는 회사에만 새 주소를 붙입니다.

### 속도를 출력 속도로 재는 이유 (생각 단계와 무관)

요즘 모델은 같은 모델이라도 생각을 얼마나 깊게 할지(effort: `minimal`·`low`·`medium`·`high`·`xhigh`·`max`)를 고를 수 있고, AA 는 같은 모델을 이 단계별로 따로 잽니다. 그런데 AA 가 재는 단계는 모델마다 달라서(어떤 모델은 Low·High, 어떤 모델은 Medium·Max) 모든 모델을 같은 단계로 맞출 수 없습니다.

- **끝까지 걸린 시간**은 생각하는 시간이 포함돼 단계에 따라 크게 달라집니다. 같은 모델의 단계별 값 19쌍에서 가장 느린 단계가 가장 빠른 단계의 약 4배(중앙값)였습니다. 예를 들어 Claude Sonnet 5 는 Low 9초, Max 205초입니다.
- **출력 속도**(1초에 내보내는 토큰 수)는 그 모델을 돌리는 서버의 빠르기라 단계와 거의 상관이 없습니다. 같은 19쌍에서 차이는 약 8%(중앙값)였습니다.

그래서 속도는 출력 속도로 재고, AA 가 잰 단계들의 값을 평균내 씁니다. 단계를 고르지 않아도 되므로 단계가 여러 개인 모델도 모두 팔 수 있습니다. 따라서 "빠르게"는 "같은 양을 더 빨리 내보내는 모델"을 뜻합니다. 실제로 답이 끝나는 시간은 호출할 때 고르는 생각 단계에 따라 달라집니다.

### 자동 갱신

구매 요청이 들어왔을 때 가장 최근 값이 **1시간보다 오래됐으면** 세 출처에서 판매 목록에 있는 모델의 숫자만 새로 받습니다. 판매 목록 자체는 바뀌지 않습니다.

1시간인 이유: 세 출처 중 가장 자주 바뀌는 값이 AA 속도(하루 8번 측정)라 약 3시간마다 바뀝니다. OpenRouter 가격은 가격이 바뀔 때만, Epoch ECI 는 새 평가가 나올 때만 바뀝니다. 1시간이면 가장 빠른 변화도 놓치지 않으면서, 매 구매마다 세 사이트에 요청해 구매가 몇 초씩 늦어지는 일은 1시간에 한 번으로 줄어듭니다. 주기는 `src/lib/benchmark.ts` 의 `MAX_AGE_MS` 입니다.

- 새로 받은 값은 MongoDB `snapshots` 컬렉션에 해시를 키로 쌓습니다. 결정 기록에 남은 해시로 그때 본 숫자를 찾을 수 있습니다.
- 받다가 실패하면(사이트 장애, 목록의 모델이 출처에서 사라짐 등) **마지막으로 받은 값으로 계속**하고, 실패 사유를 결정 기록에 남깁니다.
- 한 번도 받지 않았으면 `data/benchmark.json` 을 시작값으로 씁니다.

### 판매 목록 다시 만들기

```bash
node scripts/capture-benchmark.mjs --list   # 저장하지 않고 짝지어진 모델과 뺀 모델만 보기
node scripts/capture-benchmark.mjs          # data/catalog.json · benchmark.json · sellers.json 갱신
```

판매 목록이 바뀌는 곳은 이 스크립트뿐입니다. 결과를 확인하고 커밋합니다. AA 키는 `.env.local` 의 `AA_API_KEY` 에서만 읽습니다(자동 갱신도 같은 키를 씁니다). 테스트는 `tests/fixtures/` 의 고정 숫자만 봅니다.

## 기록 저장소

기록은 로컬 MongoDB 의 `agent_m2m` 데이터베이스에 저장합니다. 실행 전에 MongoDB 가 켜져 있어야 합니다.

| 컬렉션 | 담는 것 |
| --- | --- |
| `purchases` | 구매 기록(요청, 결정 근거, 결제, 결과, 상태) |
| `alerts` | 이상 거래 알림(차단·경고) |
| `snapshots` | 1시간마다 받아 온 벤치마크 숫자 |

MongoDB 를 켜는 방법은 설치 방식에 따라 다릅니다.

```bash
brew services start mongodb-community   # macOS (Homebrew)
```

```bash
sudo systemctl start mongod             # Linux (공식 패키지)
```

접속 주소는 `MONGODB_URI`, 데이터베이스 이름은 `MONGODB_DB` 로 바꿀 수 있습니다. 테스트는 `agent_m2m_test_...` 이름의 임시 데이터베이스를 만들고 끝나면 지웁니다.
