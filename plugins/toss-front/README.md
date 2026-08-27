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
학생용 태블릿(EduSyncPro 웹, /student-kiosk) ─결제하기─▶ 서버
                                                       │  paymentIntent 생성 (paymentKey 발급)
                                                       ▼
                                                 payment_dispatches (PENDING)
                                                       │  1초 폴링
                                                       ▼
                                              Toss Front 플러그인
                                                       │  ackDispatch → sdk.payment.requestPayment
                                                       ▼
                                            카드/삼성페이/애플페이 승인
                                                       │  reportDispatchResult + confirmPayment
                                                       ▼
                                                     서버 (payments 삽입, dispatch APPROVED)
                                                       ▼
                                                     태블릿 폴링으로 완료 확인
```

플러그인 화면은 오직 `sdk.template.renderIdlePage()` 로 렌더되는 표준 유휴 화면과
Toss 표준 결제창(sdk.payment.requestPayment)뿐이다. 커스텀 HTML/CSS 없음, 확인 버튼 없음.

## 폴링 방식 (1초 API 폴링)

- 매 1초마다 `GET /api/toss-front/dispatch/pending` 호출.
- PENDING 이 잡히면 즉시 `POST /dispatch/:id/ack` → `sdk.payment.requestPayment(...)`.
- 결제창이 열려 있는 동안은 폴링 잠금(`busy = true`)으로 재진입 방지.
- SSE 대비 장점: EventSource 재연결·프록시 유휴 종료 대응 코드가 필요 없고
  단말당 1 req/s 는 서버 부하 무시 가능한 수준. 지연은 최대 1초.

## 복구·안전장치

- 승인 후 결과 업로드 전에 화면이 재시작되면 부팅 시퀀스에서
  `sdk.payment.getBackupPaymentKey()` → `sdk.payment.getPayment({ paymentKey })`
  로 승인 결과를 복구해 서버로 재업로드한 뒤 `sdk.payment.resetBackupPaymentKey()`.
- 같은 프론트에 동시 결제 두 건이 잡히지 않도록 서버가 활성 dispatch 중복 시 409 반환.
- 서버 dispatch 는 3분 무응답 시 만료(TIMEOUT) 로 자동 정리.

## 파일

- `manifest.json` — 개발자센터 값과 동기화 (id `edusyncpro-front`)
- `src/index.ts` — 부팅·폴링·결제 실행·결과 업로드·backup 복구
- `src/api.ts` — 서버 REST 래퍼 (dispatch pull/ack/result, confirm, cancel)

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
