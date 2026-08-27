# EduSyncPro Toss Front 2 플러그인

학원 로비의 Toss Front 2 태블릿에서 실행되는 프론트 플러그인.

## 흐름

1. 학부모/학생이 태블릿에서 **부모님 번호 뒤 4자리** 입력
2. 학생 후보 목록에서 본인 선택 (동명이인 대비 학년·학교 표시)
3. 다음 두 갈래 중 선택:
   - **출석 체크** — 오늘 예정된 반을 골라 체크인
   - **학원비 결제** — 이번 달·지난 달 미납 청구서 중 선택 → 카드 결제

## 파일

- `manifest.json` — 토스 개발자센터에 등록할 플러그인 매니페스트
- `src/index.ts` — 진입점(부팅·메인 루프·화면 흐름)
- `src/api.ts` — EduSyncPro 서버 API 클라이언트(세션 재발급 자동 처리)

## 등록 절차 (내일 아침 진행)

1. [developers.tossplace.com/plugins](https://developers.tossplace.com/plugins) 로그인
2. **내 애플리케이션 → 생성하기** → **프론트 플러그인** 선택
3. `manifest.json`의 내용을 개발자센터의 입력 폼에 맞춰 붙여넣기
4. 서버 URL은 `https://edusync-pro-production-dcfe.up.railway.app` (Railway 접미어 `-dcfe` 필수)
5. 관리자 화면 `/admin/toss-front/devices`에서 단말기 등록 → 발급된 `deviceKey`를 태블릿 첫 부팅 화면에 입력

## 환경변수

- `TOSS_FRONT_DEVICE_KEY` — 관리자에서 발급받은 32바이트 base64url 키. 태블릿 SDK 저장소에 보관.

## 서버측 요구 환경변수

Railway → Variables에 아래를 추가한다.

- `TOSS_MERCHANT_ID` — 토스플레이스 개발자센터에서 발급받은 가맹점 ID
- `TOSS_FRONT_DEVICE_SECRET` — 단말기 접근 토큰 서명용(없으면 `JWT_SECRET` 재사용)
- `TOSS_FRONT_INVOICE_SECRET` — 가상 청구서 토큰 서명용(없으면 `JWT_SECRET` 재사용)
- `TOSS_WEBHOOK_SECRET` — 웹훅 서명 검증용(다음 커밋에서 사용)

## 테스트 흐름

실제 하드웨어 없이 검증하는 순서:

1. `npm run db:migrate:toss-front` 실행 → 스키마 반영
2. 로컬 서버 실행 후 `POST /api/toss-front/devices/enroll`로 단말기 하나 발급
3. `POST /api/toss-front/session`으로 accessToken 획득
4. `POST /api/toss-front/students/search`로 학생 검색
5. 이후 결제·출석 API도 순서대로 호출 (`scripts/test-toss-front-*.ts` 참고)
