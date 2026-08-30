# Toss Front 2 연동 — 설정·운영 가이드

내일 [developers.tossplace.com/plugins](https://developers.tossplace.com/plugins)에 등록하기 위한 준비 절차와, 운영 중 원장이 알아야 할 흐름을 담는다.

## 1. 서버 환경변수

Railway → 프로젝트 → Variables에 아래를 추가한다.

| 이름 | 용도 | 없으면 |
|---|---|---|
| `TOSS_MERCHANT_ID` | 토스플레이스 개발자센터에서 발급받은 가맹점 ID | `/toss-front` 화면에서 단말기 등록 시 500 에러 |
| `TOSS_FRONT_DEVICE_SECRET` | 단말기 접근 토큰 서명용 32바이트 무작위 값 | 부팅마다 임시 키가 만들어져 재배포 시 단말기 재등록 필요 |
| `TOSS_FRONT_INVOICE_SECRET` | 가상 청구서 토큰 서명용 | 위와 동일. 청구서 토큰이 재배포 후 무효화 |
| `TOSS_WEBHOOK_SECRET` | 웹훅 서명 검증용 — **토스가 발급해 주는 값** (직접 만들지 않는다) | 모든 웹훅이 `signatureValid=false`로 저장되고 401로 거절됨 |

시크릿을 갈래별로 다르게 두는 이유: 하나가 유출돼도 나머지 갈래는 영향받지 않는다.

### 우리가 만드는 값 vs 토스가 주는 값 — 헷갈리면 웹훅이 통째로 죽는다

`TOSS_FRONT_DEVICE_SECRET` 과 `TOSS_FRONT_INVOICE_SECRET` **두 개만** 우리가 만든다.
빈 문자열이 안전한 기본값이 아니므로 32바이트 이상의 무작위 값을 넣는다:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`TOSS_WEBHOOK_SECRET` 은 **여기서 만들면 안 된다.** 토스플레이스 개발자센터에서 웹훅을
생성할 때 토스가 "서명 정보(Secret Key)" 를 발급해 주고, 서명은 그 키로 계산되어 온다.
우리가 만든 무작위 값을 넣으면 HMAC 이 영원히 어긋나서 **모든 웹훅이 401** 이 된다 —
증상이 "미설정" 과 똑같아서 원인을 찾기 매우 어렵다. 반드시 화면에 표시된 값을 그대로 복사한다.

(공식 문서: <https://docs.tossplace.com/reference/open-api/webhook.html>)

## 2. 개발자센터 앱 등록 (내일 오전)

1. [developers.tossplace.com/plugins](https://developers.tossplace.com/plugins) 로그인
2. **내 애플리케이션 → 생성하기 → 프론트 플러그인** 선택
3. `plugins/toss-front/manifest.json`의 값을 폼에 옮겨 넣는다:
   - 이름: `EduSyncPro Kiosk`
   - 서버 URL: `https://edusyncpro-production-dcfe.up.railway.app` (Railway 접미어 `-dcfe` 반드시 포함)
   - 웹훅 URL: `https://edusyncpro-production-dcfe.up.railway.app/api/toss-front/webhooks`
   - 필요 권한: `template.render`, `payment.card`, `payment.cancel`, `network.https`
4. 웹훅 시크릿 발급받아 Railway `TOSS_WEBHOOK_SECRET`에 넣기
5. 가맹점 ID를 `TOSS_MERCHANT_ID`에 넣기

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
     → 몇 초 후 Toss 웹훅 도착 → 서버가 이미 APPROVED인 것 확인 → 조용히 통과
```

confirm이 네트워크 문제로 실패하면 웹훅이 나중에 payments를 대신 채운다. `idempotent=true`인 두 경로가 같은 결과를 만든다.

## 5. 원장이 알아야 할 이상 신호

`/toss-front` 화면에서 다음이 보이면 조치가 필요하다:

| 신호 | 의미 | 조치 |
|---|---|---|
| **웹훅 24h — 실패 N** (숫자 > 0) | 서명 검증 실패. 시크릿이 어긋났거나 위조 시도 | Railway의 `TOSS_WEBHOOK_SECRET`이 토스 개발자센터의 값과 같은지 확인 |
| **진행중 intent** 가 계속 남아 있음 | 결제창이 닫혔는데 confirm이 안 옴 (네트워크·SDK 실패) | 15분 후 자동으로 TIMEOUT 처리됨. 반복되면 태블릿 재부팅 |
| **활성 단말기 0** | 관리자 화면에서 단말기를 폐기했거나 아직 등록 안 됨 | 위 3번 절차로 새 단말기 발급 |
| **payment intent FAILED — "amount mismatch"** | 결제 금액이 서버가 알던 값과 다름 (스키마 오류 or 조작 시도) | 로그 확인. 원장이 직접 청구서를 수정한 뒤 다시 시도 |

## 6. 회계 화면과의 관계

- 결제가 성공하면 자동으로 `payments` 테이블에 행이 들어가서 기존 **수납** 화면에 그대로 나타난다.
- `paidVia="TOSS_FRONT"` 필드로 수기 입력과 구분됨. 수납 화면의 필터·집계는 그대로 작동.
- Toss 취소 웹훅이 오면 음수 `payments` 행이 자동 추가되어 순액이 맞게 유지된다.
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
