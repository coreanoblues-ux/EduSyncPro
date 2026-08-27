# EduSyncPro Toss Front 플러그인 — 결제 단말기 모드

토스플레이스 공식 [파트너 시스템 연동 가이드](https://docs.tossplace.com/guide/front-integration/plugin/develop/partner-integration-guide.html)의
**결제 단말기 모드**로 동작한다. 학생 검색·청구서 선택은 EduSyncPro 학생용 태블릿
웹페이지가 담당하고, 이 플러그인은 서버가 밀어주는 결제요청을 받아 승인만 처리한다.

## 개발자센터 등록 상태

이미 등록됨:
- 이름: **EduSyncPro 학원 출결 수납**
- ID: `edusyncpro-front`
- ACL(URL): `https://edusyncpro-production-dcfe.up.railway.app`
- 가맹점: 페이지원영어학원(614624)

새로 생성할 필요 없음. `manifest.json`의 값은 개발자센터의 값과 일치시켜 유지.

## 흐름 (공식 결제 단말기 모드)

```
학생용 태블릿(EduSyncPro 웹) ─결제하기─▶ 서버
                                       │  paymentIntent 생성 (paymentKey 발급)
                                       ▼
                                   payment_dispatches (PENDING)
                                       │  SSE push
                                       ▼
                              Toss Front 플러그인
                                       │  sdk.payment.requestPayment
                                       ▼
                              카드/삼성페이/애플페이 승인
                                       │  결과 업로드
                                       ▼
                                       서버 (payments 삽입, dispatch APPROVED)
                                       ▼
                                       태블릿 폴링으로 완료 확인
```

## 복구·안전장치

- 승인 후 결과 업로드 전에 화면이 재시작되면 `sdk.payment.getBackupPaymentKey()`
  로 이전 paymentKey를 얻고 `sdk.payment.getPayment({ paymentKey })`로 승인 결과를
  복구해 서버로 재업로드한다. 재업로드 성공 시 `sdk.payment.resetBackupPaymentKey()`.
- SSE 연결이 끊기면 `EventSource` 자동 재연결. 30초 이상 실패 시 폴백 폴링
  (`GET /api/toss-front/dispatch/pending`)으로 전환.
- 같은 프론트에 동시 결제 두 건이 잡히지 않도록 서버가 활성 dispatch 중복 시 409 반환.
- 결과 업로드 실패 시 로컬 큐에 저장해 지수 백오프로 재시도.

## 파일

- `manifest.json` — 개발자센터 값과 동기화
- `src/index.ts` — 부팅·SSE 수신·결제 실행·결과 업로드·복구
- `src/api.ts` — 서버 REST 래퍼 (dispatch pull, confirm, cancel)

## 환경변수

플러그인 자체는 하드코딩 시크릿 없음. 첫 부팅 시 원장이 발급한 32바이트 base64url
`deviceKey`를 SDK 저장소에 붙여넣는다. 이후 15분짜리 accessToken을 자동 발급받아 사용.

- `TOSS_FRONT_DEVICE_KEY` — 최초 부팅 시 SDK storage에 저장되는 장기키
- `TOSS_PLUGIN_SERVER_URL` — 로컬 개발 시 서버 주소 오버라이드 (미설정 시 프로덕션)

## 로컬 검증

실 하드웨어 없이 서버 흐름만 확인:

```bash
npm run db:migrate:toss-kiosk
npm run test:toss-front
npm run test:toss-kiosk
```

승인 결과·재시작 복구·SSE 재연결은 하드웨어에서 확인해야 한다.
