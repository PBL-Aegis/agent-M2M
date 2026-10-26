# agent-M2M

AI 구매 에이전트가 벤치마크 표를 보고 모델 하나를 고른 뒤, AEGIS 토큰(ERC-20)으로 값을 치르고, 판매창구가 결제를 확인한 뒤에만 결과를 돌려주는 데모입니다. 모델 선택은 LLM 없이 고정된 가중치 계산으로만 해서, 왜 그 모델이 골라졌는지 후보별 점수와 탈락 사유를 그대로 열어볼 수 있습니다. 요청에 우선순위가 없을 때만 로컬 Qwen(Ollama)이 요청 문장을 읽고 우선순위 하나를 정합니다. 모델 출력은 Mock이며 실제 OpenAI·Anthropic·Google API를 부르지 않습니다.

## 흐름

요청 → 감사(요청 직후) → 선택 → 기록(처리 중) → 감사(송금 직전) → 결제 → 확인 → 결과 → 기록(성공·실패) → 감사(결제 후)

1. **요청**: 요청 내용, 예산(units), 우선순위(기본·가격·속도·지능), 필요 기능, 요청 번호(`requestId`), 사용자(`userId`). 요청 번호를 비우면 서버가 만들고, 사용자를 비우면 비워 둔 채 기록합니다. 우선순위를 비우면 로컬 Qwen이 요청 문장에 적힌 선호(싸게·빨리·정확하게)를 보고 네 값 중 하나를 고르고, 선호가 없거나 서로 부딪히면 기본을 고릅니다. Qwen이 응답하지 않으면 결제 전에 멈춥니다(503). 화면에서는 기본을 직접 고르지 않고, 우선순위를 비워 둔 "요청 문장으로 판단"이 처음 값입니다.
2. **선택**: 후보마다 금액 계산 → 필요 기능으로 하드 필터 → 살아남은 후보끼리 가격·속도·성능 점수 → 가중치 합산 → 고정 규칙으로 동점 처리. 예산은 선택에서 거르지 않습니다(이상 거래 시나리오를 재현하기 위해).
3. **기록(처리 중)**: 결제 직전에 `PROCESSING` 상태로 MongoDB에 먼저 남김.
4. **감사**: `src/lib/audit.ts` 에 등록한 규칙을 세 번 돌림. 결제를 막지 않는 경고는 `alerts` 컬렉션에 남김.
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
| `/dashboard` | 요약 · 최근 기록 · 구매자 지갑 잔액 |
| `/dashboard/purchases` | 전체 요청·결제 기록 |
| `/dashboard/[id]` | 기록 한 건의 결정 근거 |

## 실행

```bash
npm install
npm run chain      # 로컬 체인(anvil)을 띄우고 토큰 배포·발급. 켜 둔 채로 다른 창에서 다음 명령
npm run dev        # http://localhost:3100
npm test           # vitest
npm run typecheck
npm run build
```

## 스마트 컨트랙트

`contracts/` 는 Foundry 프로젝트입니다. 체인에서는 구매자 지갑 하나를 사용자 한 명으로 봅니다. `AegisToken` 은 소수점 6자리 ERC-20이며 운영자만 새로 발급합니다. 구매 결제는 `pay` 로 하며, `pay` 는 송금 전에 감사 규칙을 돌리고 `Paid(요청 번호, 보낸 쪽, 받는 쪽, 금액)` 이벤트를 남깁니다.

감사 규칙은 `contracts/src/rules/` 에 파일로 따로 둡니다. 규칙은 `PaymentRules` 를 상속해 `_checkPayment` 를 덮어쓰고, 먼저 `super._checkPayment(...)` 를 부른 뒤 막을 때 revert 합니다. `AegisToken` 에는 상속 목록과 `_checkPayment` 의 override 목록에 규칙 이름만 더합니다.

> Base Sepolia 에는 아직 배포하지 않았습니다. 기존 `AEGIS_TOKEN_ADDRESS`(`0xE208…142b`)에는 `pay` 가 없어서, live 결제는 이 컨트랙트를 배포하고 그 주소로 바꾼 뒤에만 동작합니다. local 은 `npm run chain` 이 띄울 때마다 배포합니다.

```bash
git submodule update --init --recursive   # 처음 받았을 때만
cd contracts
forge test
```

## 환경변수

`.env.example`을 `.env.local`로 복사해서 씁니다. 값은 `.env.local`에만 넣습니다.

| 이름 | 기본값 | 뜻 |
| --- | --- | --- |
| `AEGIS_PAYMENT_MODE` | `local` | `local`: 로컬 체인 · `live`: Base Sepolia 전송을 요청 · `mock`: 체인 없이 흐름만(자동 테스트용) |
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
| `mock` | 없음(흐름만) | 자동 테스트(`npm test`)가 씀 |

`local` 은 감사 규칙이 담긴 컨트랙트를 그대로 올려 쓰므로, 체인에서 막히는 것까지 화면에서 확인할 수 있습니다. `npm run chain` 을 끄면 체인과 그 위의 잔액도 사라지고, 다시 켜면 빈 체인에 같은 주소로 새로 배포합니다. 계정은 anvil 의 공개 테스트 계정(0번 운영자, 1번 구매자)이라 실제 자산이 없습니다.

> **경고** — 실제 토큰 전송은 기본적으로 일어나지 않습니다(local). `AEGIS_PAYMENT_MODE=live` **와** `AEGIS_REAL_PAYMENT_APPROVED=yes` 두 변수가 모두 켜져 있고 개인키가 있을 때만 Base Sepolia에서 실제 `transfer`가 실행됩니다. 1건당 금액 상한은 없으므로 live로 켤 때는 예산과 잔액을 직접 확인하세요. 개인키는 절대 커밋하지 마세요.

## 기술 스택

Next.js 15 (App Router) · React 19 · TypeScript · viem · MongoDB · Ollama(Qwen) · vitest · Solidity(Foundry·anvil, OpenZeppelin)

## 벤치마크와 판매 모델

판매 모델(`data/catalog.json`)과 점수의 시작값(`data/benchmark.json`)은 세 출처에서 떠온 실제 값입니다.

| 출처 | 쓰는 값 | 키 |
|---|---|---|
| [Epoch AI](https://epoch.ai/benchmarks) | 성능: Epoch Capabilities Index(ECI)와 95% 신뢰구간 | 필요 없음 |
| [OpenRouter](https://openrouter.ai/api/v1/models) | 가격: 1M 토큰당 입력·출력 판매 단가 | 필요 없음 |
| [Artificial Analysis](https://artificialanalysis.ai/methodology/performance-benchmarking) | 속도: 끝까지 걸린 시간, 하루 여러 번 잰 값의 최근 72시간 중앙값 | `AA_API_KEY` |

점수는 출처 하나씩에서 나옵니다.

- 가격 점수 = (log 최고 금액 − log 내 금액) ÷ (log 최고 − log 최저) × 100
- 속도 점수 = (log 최장 시간 − log 내 시간) ÷ (log 최장 − log 최단) × 100
- 성능 점수 = (내 ECI − 최저 ECI) ÷ (최고 − 최저) × 100

세 점수 모두 후보 중 가장 나쁜 값 0점·가장 좋은 값 100점입니다. 가격과 시간은 후보끼리 수십~수백 배 차이 나서 로그로 폅니다. 2배 싼 것은 어느 가격대에서든 같은 만큼 점수가 오르고, 아주 싼 모델 하나가 나머지를 0점 가까이로 누르거나(비율 방식) 아주 비싼 모델 하나에 나머지가 끌려가는(직선 방식) 일이 줄어듭니다. ECI 는 여러 벤치마크를 문제 난이도까지 고려해 통계적으로 합친 지수라 서로 다른 시험을 치른 모델끼리도 비교할 수 있고, 차이 자체가 의미를 가지므로 그대로 폅니다. 결정 근거 화면에 ECI 와 신뢰구간, 속도를 잰 조건(AA 항목 이름)이 함께 나옵니다.

총점은 우선순위별 비중으로 합칩니다(`PRIORITY_WEIGHTS`, `src/lib/types.ts`).

| 우선순위 | 가격 | 속도 | 성능 | 언제 |
|---|---|---|---|---|
| 싸게 (`price`) | 80 | 10 | 10 | 요청이 정했거나 문장에 싸게·저렴하게 등이 있을 때 |
| 빠르게 (`speed`) | 10 | 80 | 10 | 요청이 정했거나 문장에 빨리·급해 등이 있을 때 |
| 똑똑하게 (`intelligence`) | 10 | 10 | 80 | 요청이 정했거나 문장에 정확하게·꼼꼼히 등이 있을 때 |
| 기본 (`default`) | 34 | 33 | 33 | 문장에 선호가 없거나 서로 부딪힐 때 |

### 판매 모델을 고르는 규칙

`scripts/capture-benchmark.mjs` 가 세 출처를 짝지어 판매 목록을 만듭니다. 추측하지 않습니다.

- 세 출처의 모델 이름에서 기호를 빼고 소문자로 바꾼 값이 **정확히 같을 때만** 짝짓습니다.
- 판매 단위는 기본 모델 하나입니다. AA 는 같은 모델을 생각 단계별로 따로 재므로, 단계가 하나뿐이거나 Default 로 표시된 단계가 하나일 때만 그 값을 씁니다. 단계가 여러 개라 무엇을 팔지 정해지지 않은 모델은 뺍니다.
- 값이 비거나 0 인 모델도 뺍니다. 빈칸을 기본값으로 채우지 않습니다.
- **판매 최소 품질 기준**: ECI 140 미만은 팔지 않습니다(`MIN_ECI`, `src/lib/benchmark-sources.mjs`). 운영 판단으로 정한 값이며, 새 모델에도 같은 규칙이 적용됩니다.
- 뺀 모델과 이유는 `data/catalog.json` 의 `excluded` 에 남습니다.
- 필요 기능(`requiredCapabilities`)은 OpenRouter 가 알려 준 `reasoning`, `tools`, `vision` 입니다.
- 판매자 주소는 회사별로 하나이며 `data/sellers.json` 에 있습니다. anvil 공개 테스트 계정이라 실제 자산이 없고, 처음 보는 회사에만 새 주소를 붙입니다.

### 자동 갱신

구매 요청이 들어왔을 때 가장 최근 값이 **1시간보다 오래됐으면** 세 출처에서 판매 목록에 있는 모델의 숫자만 새로 받습니다. 판매 목록 자체는 바뀌지 않습니다.

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

구매 기록은 로컬 MongoDB의 `agent_m2m` 데이터베이스에 저장한다. 실행 전에 MongoDB가 떠 있어야 한다.

```bash
brew services start mongodb-community   # 꺼져 있을 때만
```

접속 주소는 `MONGODB_URI`, 데이터베이스 이름은 `MONGODB_DB` 로 바꿀 수 있다.
테스트는 `agent_m2m_test_...` 이름의 임시 데이터베이스를 만들고 끝나면 지운다.
