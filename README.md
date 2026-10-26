# agent-M2M

AI 구매 에이전트가 벤치마크 표를 보고 모델 하나를 고른 뒤, AEGIS 토큰(ERC-20)으로 값을 치르고, 판매창구가 결제를 확인한 뒤에만 결과를 돌려주는 데모입니다. 모델 선택은 LLM 없이 고정된 가중치 계산으로만 해서, 왜 그 모델이 골라졌는지 후보별 점수와 탈락 사유를 그대로 열어볼 수 있습니다. 요청에 우선순위가 없을 때만 로컬 Qwen(Ollama)이 요청 문장을 읽고 우선순위 하나를 정합니다. 모델 출력은 Mock이며 실제 OpenAI·Anthropic·Google API를 부르지 않습니다.

## 흐름

요청 → 선택 → 기록(처리 중) → 감사 → 결제 → 확인 → 결과 → 기록(성공·실패)

1. **요청**: 요청 내용, 예산(units), 우선순위(기본·가격·속도·지능), 필요 기능, 요청 번호(`requestId`), 사용자(`userId`). 요청 번호를 비우면 서버가 만들고, 사용자를 비우면 비워 둔 채 기록합니다. 우선순위를 비우면 로컬 Qwen이 요청 문장에 적힌 선호(싸게·빨리·정확하게)를 보고 네 값 중 하나를 고르고, 선호가 없거나 서로 부딪히면 기본을 고릅니다. Qwen이 응답하지 않으면 결제 전에 멈춥니다(503).
2. **선택**: 후보마다 금액 계산 → 필요 기능으로 하드 필터 → 살아남은 후보끼리 가격·시간·지능 점수 → 가중치 합산 → 고정 규칙으로 동점 처리. 예산은 선택에서 거르지 않습니다(이상 거래 시나리오를 재현하기 위해).
3. **기록(처리 중)**: 결제 직전에 `PROCESSING` 상태로 MongoDB에 먼저 남김.
4. **감사**: `src/lib/audit.ts` 의 `BEFORE_PAYMENT_CHECKS` 에 등록한 규칙을 차례로 돌림. 하나라도 막으면 송금하지 않음. 결제를 막지 않는 경고는 `alerts` 컬렉션에 남김.
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

`contracts/` 는 Foundry 프로젝트입니다. `AegisToken` 은 소수점 6자리 ERC-20이며 운영자만 새로 발급합니다. 구매 결제는 `pay` 로 하며, `pay` 는 송금 전에 감사 규칙을 돌리고 `Paid(요청 번호, 보낸 쪽, 받는 쪽, 금액)` 이벤트를 남깁니다.

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
| `AA_API_KEY` | (비움) | Artificial Analysis API 키. 벤치마크 자동 갱신·수동 캡처에 필요 |
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

## 벤치마크 값 갱신

`data/benchmark.json` 은 두 출처에서 떠온 실제 값입니다.

| 출처 | 쓰는 값 |
|---|---|
| Artificial Analysis 공개 API | 가격 · 응답시간 · 지능 지수 |
| LMArena 공식 데이터셋 (Hugging Face) | 사람 선호 Elo |

가격과 응답시간은 AA에만 있어서 AA 값을 씁니다. **성능 점수만 두 출처를 합칩니다.**

- AA 점수 = 내 지능 지수 ÷ 후보 중 최고 × 100
- Arena 점수 = 1등 후보와 붙었을 때 이길 확률 × 200 (1등 = 100점)
- 성능 점수 = 두 점수의 평균

두 사이트는 같은 모델을 노력 수준(생각을 얼마나 오래 하는지)별로 따로 잽니다. 서로 다른 단계를
섞지 않도록 `data/catalog.json` 에 모델마다 `aaSlug` 와 `arenaModel` 을 사람이 직접 적고,
어느 단계끼리 짝지었는지 `effortPairing` 에 남깁니다. 이름으로 추측해서 찾지 않고, 한 출처라도
값이 없으면 기본값으로 메우지 않고 멈춥니다.

### 자동 갱신

구매 요청이 들어왔을 때 가장 최근 값이 **1시간보다 오래됐으면** 두 출처에서 새로 받습니다.

- 새로 받은 값은 MongoDB `snapshots` 컬렉션에 해시를 키로 쌓습니다. 결정 기록에 남은 해시로 그때 본 숫자를 찾을 수 있습니다.
- 받다가 실패하면(사이트 장애, 모델 이름 불일치 등) **마지막으로 받은 값으로 계속**하고, 실패 사유를 결정 기록에 남깁니다.
- 한 번도 받지 않았으면 `data/benchmark.json` 을 시작값으로 씁니다.
- 새로 받는 구매는 약 10초 더 걸립니다(Arena 데이터셋을 여러 쪽 나눠 받기 때문).

### 손으로 다시 뜨기

시작값을 새로 만들거나 이름을 검색할 때:

```bash
node scripts/capture-benchmark.mjs
node scripts/capture-benchmark.mjs --list gemini   # AA 슬러그 검색
node scripts/capture-benchmark.mjs --arena opus    # Arena 모델 이름 검색
```

AA 키는 `.env.local` 의 `AA_API_KEY` 에서만 읽습니다(자동 갱신도 같은 키를 씁니다). 떠온 시각과 Arena 발행일이
스냅샷에 함께 저장되고, 결정 기록에는 그 스냅샷의 해시와 받아 온 시각이 남습니다. 테스트는 `tests/fixtures/` 의 고정 숫자만 봅니다.

## 기록 저장소

구매 기록은 로컬 MongoDB의 `agent_m2m` 데이터베이스에 저장한다. 실행 전에 MongoDB가 떠 있어야 한다.

```bash
brew services start mongodb-community   # 꺼져 있을 때만
```

접속 주소는 `MONGODB_URI`, 데이터베이스 이름은 `MONGODB_DB` 로 바꿀 수 있다.
테스트는 `agent_m2m_test_...` 이름의 임시 데이터베이스를 만들고 끝나면 지운다.
