# Toss Front 2 연동 — 설정·운영 가이드

내일 [developers.tossplace.com/plugins](https://developers.tossplace.com/plugins)에 등록하기 위한 준비 절차와, 운영 중 원장이 알아야 할 흐름을 담는다.

## 1. 서버 환경변수

Railway → 프로젝트 → Variables에 아래를 추가한다.

| 이름 | 용도 | 없으면 |
|---|---|---|
| `TOSS_MERCHANT_ID` | 토스플레이스 개발자센터에서 발급받은 가맹점 ID | `/toss-front` 화면에서 단말기 등록 시 500 에러 |
| `TOSS_FRONT_DEVICE_SECRET` | 단말기 접근 토큰 서명용 32바이트 무작위 값 | 부팅마다 임시 키가 만들어져 재배포 시 단말기 재등록 필요 |
| `TOSS_FRONT_INVOICE_SECRET` | 가상 청구서 토큰 서명용 | 위와 동일. 청구서 토큰이 재배포 후 무효화 |
| `TOSS_WEBHOOK_SECRET` | 웹훅 서명 검증용. **현재 구조에서는 설정할 수 없다** — 아래 §1.2 | 아무 일도 일어나지 않는다 (웹훅이 애초에 오지 않으므로) |

시크릿을 갈래별로 다르게 두는 이유: 하나가 유출돼도 나머지 갈래는 영향받지 않는다.

`TOSS_FRONT_DEVICE_SECRET` 과 `TOSS_FRONT_INVOICE_SECRET` **두 개만** 우리가 만든다.
빈 문자열이 안전한 기본값이 아니므로 32바이트 이상의 무작위 값을 넣는다:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 1.2 웹훅은 프론트 플러그인 기능이 아니다 (2026-08-31 확인)

이 문서는 오랫동안 "앱 등록할 때 웹훅 URL 을 넣고 시크릿을 발급받으라" 고 적어 두었다.
**그런 화면은 존재하지 않는다.** 개발자센터에서 프론트 앱을 열어도 웹훅 메뉴가 없다.
없는 메뉴를 찾게 만드는 안내였다.

사실관계:

- 웹훅은 **Open API** 제품의 기능이다. 문서 경로부터 `/reference/open-api/webhook.html` 이다.
- 애플리케이션 타입이 다르다. 프론트 플러그인은 **`프론트`**, 웹훅을 쓰려면 **`API`** 타입
  애플리케이션을 **따로** 만들어야 한다 (개발자센터: 내 애플리케이션 → 애플리케이션 등록 →
  애플리케이션 타입 `API`). 인증도 다르다 — 웹훅/Open API 는 `x-access-key` + `x-secret-key`
  키페어를 쓰고, 프론트 플러그인에는 그런 게 없다.
- 프론트 플러그인 FAQ 가 이 경계를 명시한다:
  > "Open API 앱이 설치된 매장의 프론트 플러그인 결제는 Payment API와 웹훅의 제공 범위에서
  > 확인할 수 있어요."

  즉 **Open API 앱을 실제 매장에 설치해야** 프론트 결제가 웹훅 범위에 들어온다.
  프론트 플러그인 단독으로는 불가능하다.
- 그래서 프론트 플러그인은 **자기가 일으키지 않은 결제/취소를 알 방법이 없다.**

**결론:** `TOSS_WEBHOOK_SECRET` 은 지금 비워 두는 것이 맞다. 넣을 값이 없다.
`server/toss-front/webhooks.ts` 는 그대로 둔다 — 코드는 공식 서명 규격대로 맞게 짜여
있고, 나중에 Open API 앱을 붙이면 그날 바로 동작한다. 지우면 그때 다시 만들어야 한다.

**그 대신 지켜야 할 운영 규칙은 §5.1 에 있다.**

(출처: <https://docs.tossplace.com/reference/open-api/webhook.html> ·
<https://docs.tossplace.com/guide/front-integration/faq.html> ·
<https://docs.tossplace.com/guide/pos-integration/open-api/develop-tutorial.html>)

## 2. 개발자센터 앱 등록 (내일 오전)

1. [developers.tossplace.com/plugins](https://developers.tossplace.com/plugins) 로그인
2. **내 애플리케이션 → 생성하기 → 프론트 플러그인** 선택
3. `plugins/toss-front/manifest.json`의 값을 폼에 옮겨 넣는다:
   - 이름: `EduSyncPro Kiosk`
   - ACL(URL): `https://edusyncpro-production-dcfe.up.railway.app` (Railway 접미어 `-dcfe` 반드시 포함)
   - 필요 권한: `template.render`, `payment.card`, `payment.cancel`, `network.https`
4. 가맹점 ID를 `TOSS_MERCHANT_ID`에 넣기

> **웹훅 URL 입력란은 없다.** 프론트 앱 등록 화면에 그런 칸이 존재하지 않는다. 이유는 §1.2.
> 찾다가 시간 버리지 말 것.

## 3. 단말기 등록 절차

원장 화면에서:

1. `/toss-front` 진입 → "새 단말기 등록"
2. 이름 입력(예: "로비 프론트 1") → 발급
3. 화면에 `deviceKey`가 한 번 노출됨. **이 화면을 닫으면 다시 볼 수 없다.** 복사해서 태블릿에 옮겨 붙이기
4. 태블릿 첫 부팅 화면에서 그 키를 붙여넣고 저장
5. 이후 태블릿은 그 키로 15분짜리 접근 토큰을 자동 발급받아 돈다

## 4. 결제 흐름 요약

```
학부모 → 태블릿에서 부모 번호 뒤 4자리
     → 학생 선택
     → 미납 청구서 목록에서 하나 선택
     → 서버가 payment_intent 생성 (paymentKey 발급)
     → Toss SDK requestPayment (카드 승인창)
     → 승인 성공 → 서버 confirm (payments 행 삽입, intent APPROVED)
```

confirm 이 네트워크 문제로 실패하면 **confirm 아웃박스**가 재시도해서 채운다.
(예전 이 자리에 "몇 초 후 웹훅이 도착한다" 고 적혀 있었으나 사실이 아니다 — §1.2.
프론트 플러그인에는 웹훅이 오지 않는다. 유실 보완은 아웃박스가 전담한다.)

## 5. 원장이 알아야 할 이상 신호

`/toss-front` 화면에서 다음이 보이면 조치가 필요하다:

| 신호 | 의미 | 조치 |
|---|---|---|
| **웹훅 24h — 실패 N** (숫자 > 0) | 프론트 플러그인만 쓰는 동안에는 웹훅 자체가 오지 않으므로 이 숫자는 계속 0 이어야 한다. 0 이 아니면 외부에서 우리 엔드포인트를 찔러 본 것이다 (서명이 없으므로 거절됨 — 돈에는 영향 없음) | 계속 늘어나면 로그 확인 |
| **진행중 intent** 가 계속 남아 있음 | 결제창이 닫혔는데 confirm이 안 옴 (네트워크·SDK 실패) | 15분 후 자동으로 TIMEOUT 처리됨. 반복되면 태블릿 재부팅 |
| **활성 단말기 0** | 관리자 화면에서 단말기를 폐기했거나 아직 등록 안 됨 | 위 3번 절차로 새 단말기 발급 |
| **payment intent FAILED — "amount mismatch"** | 결제 금액이 서버가 알던 값과 다름 (스키마 오류 or 조작 시도) | 로그 확인. 원장이 직접 청구서를 수정한 뒤 다시 시도 |

### 5.1 취소는 반드시 키오스크에서 한다 — 장부가 어긋나는 유일한 경로

웹훅이 없으므로(§1.2) **우리 서버는 자기가 일으키지 않은 취소를 알 수 없다.**
구멍은 정확히 하나, 여기뿐이다:

| 어디서 취소했나 | 카드 취소 | 장부 반영 |
|---|---|---|
| **키오스크 / 관리자 화면** | ✅ | ✅ 자동 |
| **토스 사장님 앱에서 직접** | ✅ | ❌ **안 됨** — 돈은 나갔는데 장부는 모른다 |

**규칙: 취소는 키오스크에서 한다.** 사장님 앱에서는 취소하지 않는다.

부득이 사장님 앱에서 취소했다면, 수납 화면에서 **같은 금액의 음수 행을 수기로 추가**해야
장부가 맞는다. 잊으면 매출이 실제보다 높게 잡힌 채로 남는다.

> 참고: 키오스크에서 취소가 거절되는 경우가 있다 — 승인번호가 제대로 기록되지 않은 옛
> 결제다. 이때는 화면이 "사장님 앱에서 취소한 뒤 장부에만 반영해 주세요" 라고 알려 준다.
> 그 안내가 뜬 건은 위 수기 조정이 **반드시** 필요하다.

## 6. 회계 화면과의 관계

- 결제가 성공하면 자동으로 `payments` 테이블에 행이 들어가서 기존 **수납** 화면에 그대로 나타난다.
- `paidVia="TOSS_FRONT"` 필드로 수기 입력과 구분됨. 수납 화면의 필터·집계는 그대로 작동.
- 키오스크·관리자 화면에서 취소하면 음수 `payments` 행이 자동 추가되어 순액이 맞게 유지된다.
  **사장님 앱에서 직접 취소한 건은 자동으로 들어오지 않는다** — §5.1.
- 잘못된 결제는 수납 화면에서 수기 조정으로 처리한다. Toss Front 화면에서는 손대지 않는다.

## 7. 롤백

문제가 생겨 Toss 연동을 완전히 꺼야 할 때:

1. Railway의 `TOSS_MERCHANT_ID` 삭제 → 새 단말기 등록이 500으로 거절됨
2. 관리자 화면에서 기존 단말기 전부 폐기 → 세션 발급이 401로 거절됨
3. 새 스키마·컬럼은 그대로 두어도 기존 EduSyncPro 기능에는 영향 없음 (전부 additive)

DB 롤백은 마이그레이션이 `IF NOT EXISTS`라 재실행 안전. 되돌리려면 새 테이블·컬럼·enum을 손으로 DROP.

## 8. 로컬 개발 환경에서 확인

실제 하드웨어 없이 서버 흐름만 검증:

```bash
npm run test:toss-front       # 서명·해시·토큰 단위 검증
npm run db:migrate:toss-front  # 스키마 적용 (idempotent)
```

curl 예:

```bash
# 단말기 등록 (원장 세션 필요)
curl -X POST -H "Cookie: token=..." -H "Content-Type: application/json" \
  -d '{"displayName":"테스트"}' \
  http://localhost:3000/api/toss-front/devices/enroll

# 접근 토큰 발급
curl -X POST -H "Content-Type: application/json" \
  -d '{"deviceKey":"<위 응답의 deviceKey>"}' \
  http://localhost:3000/api/toss-front/session

# 학생 검색
curl -X POST -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{"phoneSuffix":"1234"}' \
  http://localhost:3000/api/toss-front/students/search
```

## 9. 파일 지도

| 파일 | 역할 |
|---|---|
| `shared/schema.ts` | 스키마 (enum·테이블·타입) — 337~488행 |
| `scripts/migrate-add-toss-front.ts` | 멱등 마이그레이션 |
| `server/toss-front/deviceAuth.ts` | 장치 키·접근 토큰·미들웨어 |
| `server/toss-front/virtualInvoice.ts` | 가상 청구서 JWT |
| `server/toss-front/routes.ts` | 장치 CRUD, 학생·청구서 조회 |
| `server/toss-front/payments.ts` | intent 생성·confirm·cancel |
| `server/toss-front/attendance.ts` | 출석 체크인 |
| `server/toss-front/webhooks.ts` | Toss 웹훅 수신·서명검증·재조정 |
| `server/toss-front/admin.ts` | 원장 모니터링 API |
| `client/src/pages/TossFront.tsx` | 원장 모니터링 화면 |
| `plugins/toss-front/` | 태블릿 플러그인 소스 (Toss 개발자센터 등록용) |
| `scripts/test-toss-front.ts` | 서버 로직 단위 테스트 |
