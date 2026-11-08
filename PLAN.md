# 설명회·광고 프로젝트 + 구글캘린더 연동

## 0. 배경 — 왜 새 앱을 만들지 않는가

2026-11-06, "비즈니스 스케줄러를 시놀로지 NAS에 새로 만들자"는 요청에서 출발했다.
저장소를 조사한 결과 요청한 4개 모듈 중 **두 개가 이미 EduSyncPro에 구현돼 있었다.**

| 요청 모듈 | 상태 |
|---|---|
| ① 신규 개설반 (대기 학생 풀, 반 추천, 정원) | **있음** — `classes`, `waiters`, `classRecommend`, `classLabel`, `timetable` |
| ② 상담 → 등록 → 반배정 | **있음** — `consultations`, `levelTests`, `call-intake`, `levelTestMatch`, `funnelWatch` |
| ③ 설명회·광고 프로젝트 (D-day 역산) | **없음** ← 이번에 만든다 |
| ④ 구글캘린더 연동 | **없음** (`googleapis` 참조 0건) ← 이번에 만든다 |

새로 만들었다면 학생 데이터가 두 군데로 갈라졌을 것이다. 그래서 **기존 앱에 ③·④만 추가한다.**

NAS 이전도 하지 않는다. 이 앱은 실제 학생·결제 데이터를 가지고 Railway에서 운영 중이고,
집 NAS로 옮기면 "집 인터넷이 끊기면 학원에서 앱을 못 쓴다"는 새 위험이 생긴다. 얻는 건 서버비뿐이다.

## 1. 운영 환경 (조사로 확인된 사실)

- 호스팅: **Railway** (Nixpacks, `railway.toml`), GitHub `coreanoblues-ux/EduSyncPro` main 푸시 시 자동 배포
- DB: **Neon** Postgres (Railway 내장 Postgres 아님 — `DATABASE_URL`이 Neon 주소여야 한다)
- 운영 주소: `https://edusyncpro-production-dcfe.up.railway.app`
- 스택: React + Vite + Wouter + TanStack Query + shadcn/ui / Express + Drizzle ORM
- 멀티테넌트: 모든 테이블에 `tenantId`, 라우트는 `authGuard → tenantGuard → roleGuard` 순
- 원장은 집 PC·학원 PC 양쪽에서 작업한다 → **작업 시작 전 항상 `git fetch` 후 `origin/main`과 비교**

## 2. 반드시 지킬 것

### 2.1 DB 변경은 전용 스크립트로만
`drizzle-kit push`에 칼럼 추가를 맡기지 않는다. `railway.toml` 주석 5)번에 적힌 실제 사고가 근거다 —
스키마에만 있고 DB에 없는 칼럼이 하나 생기자 **로그인이 통째로 죽었다.** Drizzle이 SELECT에
칼럼명을 하나하나 적기 때문에, 그 테이블을 읽는 모든 경로가 같이 죽는다.

→ `scripts/migrate-add-*.ts` 형태로 만들고 `railway.toml`의 `preDeployCommand` **끝에 이어 붙인다.**
→ 여러 번 돌아도 안전해야 한다 (`IF NOT EXISTS`). 기존 데이터를 지우거나 바꾸지 않는다.
→ 템플릿: `scripts/migrate-add-call-intake.ts`

### 2.2 pgEnum을 새로 만들지 않는다
`railway.toml` 주석 1)번: pgEnum 값 추가는 push가 데이터 손실 우려로 **대화형 확인을 요구해 배포가 멈춘다.**
프로젝트 종류·연락 상태 같은 건 `text` 칼럼으로 두고 **zod로만 검증**한다. 나중에 종류를 늘릴 때
마이그레이션이 아예 필요 없어지는 이득도 있다.

### 2.3 토스 결제와 기존 도메인은 건드리지 않는다
수납 태블릿이 `edusyncpro-production-dcfe.up.railway.app`에 물려 있다.
토스 개발자센터에 **ACL(URL)로 이 주소가 등록**돼 있고(`docs/TOSS_FRONT_SETUP.md` §2),
프론트 플러그인은 웹훅을 받지 못하는 구조라(§1.2) 이 주소가 토스가 아는 유일한 주소다.
→ 이 도메인을 **떼어내지 않는다.** 커스텀 도메인은 "추가"만 한다.

### 2.4 `.env`는 커밋하지 않는다
`.env.example`만 갱신한다.

## 3. 범위

### 이번에 만든다
- ③ 설명회·광고 프로젝트 (D-day 역산 할일 자동 생성)
- ④ 구글캘린더 단방향 연동 (앱 → 구글)

### 이번에 만들지 않는다 (의도적 제외)
- **구글 → 앱 역방향 동기화(syncToken).** 혼자 쓰는 앱이고 수정은 앱에서만 한다.
  증분 동기화·충돌 해결·삭제 복원 처리가 ④ 전체 작업량의 절반인데 돌아오는 값이 없다.
  구글 캘린더에서 직접 일정을 끌어 옮기는 습관이 생기면 그때 2차로 붙인다.
- ①② 재구현 — 이미 있다.

### 나중에 (우선순위 낮음)
- `app.sidae-edu.com` → Railway 커스텀 도메인 **추가** (기존 주소 유지, §2.3)
- 아침 텔레그램 브리핑 — "오늘 연락할 학생 / D-3 문자 발송". 캘린더 알림은 넘기기 쉽다.

## 4. 데이터 모델

### 새 테이블 3개

**`projects`** — 설명회·광고 한 건
```
id, tenantId
name          text        예: "2026 예비 고1 입시설명회"
kind          text        설명회 | 합동모의고사 | 전단 | 온라인광고 | 기타  (pgEnum 아님, §2.2)
dDay          text        YYYY-MM-DD. timestamp를 쓰면 UTC로 저장돼 한국 밤 시간에 하루가 어긋난다
                          (tasks.dueDate가 같은 이유로 text다)
place         text        null 허용
partner       text        파트너 학원. null 허용
budget        integer     null 허용
notes         text        null 허용
createdBy, createdAt, updatedAt
```

**`project_templates`** — 종류별 역산 묶음
```
id, tenantId
kind          text        어떤 종류에 쓰는 템플릿인가
name          text        예: "설명회 기본"
items         jsonb       [{ offsetDays: -21, title: "장소 확정", slot: "퇴근전" }, ...]
                          offsetDays는 음수(D-21 = -21). 당일은 0.
createdAt, updatedAt
```
기본값(설명회): D-21 장소 확정 / D-14 홍보물 제작 / D-10 학부모 문자 1차 / D-3 문자 2차 / D-1 자료 인쇄.
설정 화면에서 편집 가능.

**`project_attendees`** — 참석 신청자
```
id, tenantId, projectId
name          text
phone         text        null 허용
notes         text        null 허용
consultationId varchar    상담으로 넘긴 뒤 연결된다. null이면 아직 안 넘김 → 버튼이 보인다
createdAt
```

### 기존 테이블 변경 1개
**`tasks`에 `project_id varchar NULL` 한 칸 추가.**
할일 테이블을 새로 만들지 않는다. 설명회 준비도 결국 "퇴근 전에 할 일"이고,
따로 두면 원장이 화면 두 개를 봐야 한다. 기존 `Todos.tsx`의 밀림 표시·미루기·완료가 그대로 적용된다.

## 5. 단계별 진행

각 단계가 끝나면 **멈추고** 확인 방법을 알린 뒤 승인을 받는다. 로컬 `npm run dev`로 먼저 확인하고,
승인 후에만 배포한다.

### 1단계 — 스키마 + 마이그레이션
- `shared/schema.ts`에 테이블 3개 + `tasks.projectId` 추가, insert/body zod 스키마
- `scripts/migrate-add-projects.ts` (CREATE TABLE IF NOT EXISTS ×3, ALTER tasks ADD COLUMN IF NOT EXISTS)
- `package.json`에 `db:migrate:projects`, `railway.toml` preDeployCommand 끝에 추가
- **확인**: `npm run db:migrate:projects` 두 번 연속 실행 → 두 번째도 에러 없이 끝나야 한다 (멱등)

### 2단계 — 서버 API
- `GET/POST/PATCH/DELETE /api/projects`
- `POST /api/projects/:id/generate-tasks` — 템플릿 + D-day로 할일 일괄 생성
- `GET/POST/PATCH/DELETE /api/project-templates`
- `GET/POST/DELETE /api/projects/:id/attendees`
- `POST /api/projects/:id/attendees/:attendeeId/to-consultation` — 상담 "문의 접수"로 전환
- `GET /api/tasks`에 projectId 포함
- **확인**: 로컬에서 curl로 프로젝트 생성 → 할일 5개 자동 생성 확인

### 3단계 — 프로젝트 화면
- `client/src/pages/Projects.tsx`, `App.tsx` 라우트 `/projects`, `AcademySidebar.tsx` 메뉴
- 프로젝트 카드: D-day 남은 일수, 준비 진행률(완료/전체), 기한 지난 할일 빨간색
- `Todos.tsx`에 프로젝트 배지 (어느 설명회 건인지)
- **확인**: `/projects`에서 "2026-11-19 예비 고1 설명회" 생성 → `/todos`에 역산 할일이 날짜별로 뜬다

### 4단계 — 템플릿 편집
- `Settings.tsx`에 역산 템플릿 편집 (항목 추가·삭제, D-n과 제목 수정)
- **확인**: 템플릿에 "D-7 현수막 신청" 추가 → 새 프로젝트 생성 시 그 할일이 같이 생긴다

### 5단계 — 참석자 명단 → 상담 연결
- 명단 입력(이름·전화), 원터치 전화·문자(`tel:`, `sms:`)
- "상담으로 넘기기" → `consultations`에 문의 접수로 생성, `consultationId` 연결
- **확인**: 명단에서 한 명 넘기기 → `/consultations`에 뜨고, 명단에서는 버튼이 "상담 보기"로 바뀐다

### 6단계 — 배포
- `git push` → Railway 자동 배포. preDeployCommand에서 마이그레이션이 먼저 돈다
- **확인**: 운영 주소에서 `/projects` 접속, 수납 태블릿 결제 1건 정상 동작 확인

### 7단계 — ④ 구글캘린더 (여기서부터 별도 승인)
- 캘린더 4개 자동 생성: 수업(알림 없음) / 신규반(3일 전) / 상담(1시간 전) / 프로젝트(하루 전 + 당일 아침)
- OAuth 범위는 `calendar` 하나. `/auth/google`, `/auth/callback`. refresh token DB 저장 + 자동 갱신
- 이벤트 `extendedProperties.private`에 앱 쪽 종류와 id 저장 → 나중에 역방향을 붙일 때 짝을 찾을 수 있다
- **⚠️ 일반 Gmail 함정**: Google Cloud 동의 화면을 "테스트"로 두면 **refresh token이 7일 만에 만료**된다.
  "프로덕션"으로 전환해야 한다. 전환 시 "확인되지 않은 앱" 경고가 한 번 뜨지만 본인 계정 하나만
  쓰므로 통과하면 된다.
- **확인**: 폰 구글캘린더 앱에 "페이지원 · 프로젝트" 캘린더가 생기고 D-day가 뜬다

---

## 진행 기록

작업을 마칠 때마다 아래에 한 줄씩 남긴다. (날짜 · 한 일 · 다음 할 일)

- **2026-11-06** — 저장소 조사 완료. ①②가 이미 구현돼 있음을 확인하고 새 앱 제작 계획을 폐기,
  기존 앱에 ③④를 추가하는 것으로 방향 전환. PLAN.md·CLAUDE.md 작성. 다음: 1단계 스키마 + 마이그레이션.
- **2026-11-06** — **1단계 완료.** 스키마 3개 테이블 + `tasks.projectId`, `scripts/migrate-add-projects.ts`,
  `package.json`·`railway.toml` 연결. 운영 DB에 2회 실행해 멱등 확인, 기존 데이터 변동 없음
  (결제 882행·결제인텐트 190행·학생 153명·상담 47건·할일 31개 그대로).
  작업 중 확인된 사실 두 가지를 아래 §6에 적어 둔다. 다음: 2단계 서버 API.
- **2026-11-06** — **2단계 완료.** `server/storage.ts` 에 프로젝트·템플릿·참석자 CRUD 20개,
  `server/projects/routes.ts` 신설(`/api/projects`, `/api/project-templates`),
  `server/routes.ts` 에 마운트. 검증은 `npm run test:projects` 로 자동화했다 —
  운영 DB 에 실제로 쓰고 **finally 에서 스스로 지운다**. 15개 전부 통과,
  tasks 31개 → 31개로 원복, projects·project_attendees 0행.
  템플릿은 "설명회 기본"(5항목) 1개가 깔렸다(의도된 시드).
  참석자→상담 전환 경로(`/to-consultation`)는 실제 `consultations` 에 쓰는 유일한 기능이라
  UI 와 함께 5단계로 미뤘다. 다음: 3단계 화면(`client/src/pages/Projects.tsx`).
- **2026-11-07** — **3단계 완료(확인 대기).** `client/src/pages/Projects.tsx` 신설,
  `App.tsx` 라우트 `/projects`, `AcademySidebar.tsx` 에 "설명회·광고" 메뉴,
  `Todos.tsx` 에 프로젝트 배지(어느 설명회 건인지) 추가.
  `GET /api/tasks` 는 전체 행을 그대로 주므로 `projectId` 가 이미 포함돼 손댈 것이 없었다.
  화면 결정 두 가지: ① 프로젝트를 만들면 역산 할 일을 **자동으로** 깐다(두 번 누를 이유가 없다).
  ② 준비 할 일 목록은 이 화면에 펼치지 않고 `/todos` 로 보낸다 — 체크박스가 두 곳에 있으면
  어디서 체크했는지 헷갈려 둘 다 못 믿게 된다. 진행률과 밀린 개수까지만 보여 준다.
  타입체크 통과, Vite 가 세 모듈 모두 변환 성공, `/api/projects` 가 401(마운트 확인).
  다음: 원장 확인 후 4단계 템플릿 편집.
- **2026-11-07** — **3단계 구조 변경 (원장 요청).** 화면을 단일 "설명회·광고"에서
  **「프로젝트 스케쥴러」 허브**로 바꿨다. `Projects.tsx` → `Scheduler.tsx`, `/projects` → `/scheduler`.
  탭 넷: 설명회 & 광고 / 신규반 형성 프로젝트 / 타학원 교차수업 / 대기 학생.
  · `PROJECT_KINDS` 에 신규반·신규학생모집·교차수업 추가(text 라 마이그레이션 불필요),
    셋의 기본 역산 템플릿도 함께. 신규학생모집은 **탭을 따로 두지 않고** 설명회 탭의 종류로 넣었다 —
    원장에게 광고가 곧 모집이라 나누면 같은 달 일정이 두 화면으로 갈라진다.
  · 탭 구성은 `shared/schema.ts` 의 `SCHEDULER_TABS` 한 곳에만 있다(화면이 아니라 데이터 옆).
  · 템플릿 시딩 규칙을 "하나라도 있으면 안 깐다" → **"종류별로 없으면 깐다"** 로 고쳤다.
    안 고치면 설명회 템플릿이 이미 있다는 이유로 새 탭 셋이 영영 빈 채로 남는다.
    생성 경로(`generate-tasks`)와 목록 조회가 같은 `loadTemplatesSeeded()` 를 쓴다 —
    목록에서만 깔면 설정을 안 열어 본 원장이 신규반을 만들 때 "템플릿 없음"으로 튕긴다.
  · 대기 학생 탭은 명단이 아니라 **"지금 반을 더 열 수 있나"**에 답하게 만들었다:
    인원 많은 반이 위로, 4명 이상이면 "반 하나 더 열 수 있음", 30일 넘게 기다린 학생은 빨간색,
    전화·문자 바로가기, 그리고 **「이 대기자들로 신규반 프로젝트 시작」** 버튼이 이름·명단을
    채운 채 신규반 탭으로 넘긴다. (`waiters.classId` 가 NOT NULL 이라 "반 없는 관심 학생"은
    아직 못 받는다 — DB 수정이 필요해 원장 확인 대기 중.)
  타입체크 통과, `npm run test:projects` 15개 통과, tasks 31 → 31 무변동.
- **2026-11-07** — **학부모 리포트 디자인 확정 (코드 변경 없음).** `design/parent-report/` 에
  부모님 화면 `report_v4_flow_english.html`(영어, 지금 만들 것)·`report_v4_flow_math.html`(수학, 나중),
  선생님 입력 화면 `teacher_input_english.html`(진도·숙제 / 시험 점수 / 보강 계획 / 노트 사진·부모님 링크).
  결정: 포인트 주황, 채팅 기능 없음, 접속은 카톡 학생별 링크 + 보호자 번호 뒤 4자리 한 번 확인,
  리포트에 결제·수납·연락처 노출 금지, 로고·학원명은 학원별 설정(화이트라벨).
  영어(페이지원)는 보강 계획 O · 등원 기록 X. 수학은 나중에 등원 기록 + 보강 둘 다.
  선생님 화면은 반 단위 입력, 자동 저장, "이번 주 리포트 공개하기"를 눌러야 부모님께 보인다.
  다음: 원장 확인 후 DB 설계(진도·숙제·시험·보강·노트·링크 테이블) → 단계별 개발 계획.
- **2026-11-07** — **학부모 리포트 DB 설계·개발 계획 작성** → [docs/PARENT_REPORT_PLAN.md](docs/PARENT_REPORT_PLAN.md).
  새 테이블 9개, **기존 테이블 변경 0개**(share_phone 사고 재발 방지). 링크 문지기는 `server/lib/shareLink.ts` 재사용,
  부모님 화면은 서버가 HTML 을 직접 그린다. 운영 DB 읽기 조회: 활성 학생 128 · 영어반 20 · 보호자 번호 없음 10 · DB 11MB.
  원장 결정 대기 3가지(사진 저장 위치·보관 기간·강사 권한). 스케줄러 미커밋 작업이 먼저 배포돼야 1단계 시작 가능.
- **2026-11-07** — **스케줄러 3단계까지 배포** (8d9c5cd, 리포트 설계 c8a2628). 배포 전 운영 DB 칼럼 대조·tsc·build·
  test:projects 15/15. 14:16 새 번들 확인, 로그인·태블릿 세션·/api/projects·/api/tasks 모두 401(정상, 500 없음),
  /scheduler 200. 리포트 결정 3가지도 확정(DB 저장·6개월·강사/원장 모두 입력+공개).
  다음: 원장 실제 로그인·태블릿 결제 확인 → 학부모 리포트 1단계. 스케줄러 4·5단계는 별도.
- **2026-11-07** — **학부모 리포트 1단계 완료 (스키마 + 마이그레이션, 미푸시).** `shared/schema.ts` 에 10개 테이블
  (report_weeks · homework_items · homework_checks · exams · exam_scores · makeup_sessions · makeup_students ·
  note_photos · note_photo_files · parent_links) + 상수(숙제 상태·시험 종류·보강 사유·과목별 영역·사진 보관 183일).
  `scripts/migrate-add-learning-report.ts`, `db:migrate:learning-report`, railway.toml 주석 7) + preDeployCommand 맨 끝.
  복합·부분 유니크 6개는 스크립트 소유(스키마에 .unique() 안 씀). 운영 DB 에 2회 실행 → 둘 다 성공(멱등).
  적용 전 "DB 에만 있는 테이블" 0개 확인 — push 가 '이름 바뀜?' 을 물으며 배포를 멈출 여지 없음.
  전후 비교: 결제 893·합계 236,069,100·학생 153·상담 47·할 일 31 그대로. payment_intents 만 201→202 인데
  15:31 태블릿 실결제(APPROVED)였다 — 배포 후 태블릿 결제 정상의 증거이기도 하다. tsc 통과.
  다음: 원장 확인 → 2단계 선생님용 서버 API.
- **2026-11-07** — 1단계 푸시(d229ff9), 15:47 배포 확인(로그인·스케줄러·태블릿 경로 401 정상).
- **2026-11-07** — **학부모 리포트 2단계 완료 (선생님용 서버 API, 미푸시).**
  `shared/learningReport.ts`(계산 규칙: 주 월요일·숙제 상태·총점·상위 %·번호 뒤 4자리 — 서버·화면·부모님 화면 공용),
  `server/learning-report/routes.ts`(/api/learning-report/* — 주간 묶음 조회, 진도·공개/취소, 숙제 CRUD·검사 일괄·
  전원 완료(검사한 학생은 안 덮음), 시험 CRUD·점수 일괄(영역 병합·총점 서버 계산)·재시 일괄, 보강 CRUD·학생 상태,
  사진 올리기·보기·삭제(앞머리로 이미지 판정), 링크 목록·발급(두 번 눌러도 같은 주소)·재발급),
  `server/learning-report/photoStore.ts`(사진 저장 + 6개월 지난 원본 정리, 6시간마다 — index.ts 에 등록).
  **부모님 링크 주소를 /r/ → /p/ 로 바꿨다** — /r/ 은 레벨테스트 결과지가 이미 쓰고 있었다.
  `npm run test:learning-report` 31/31 (실제 반 하나의 2000-01-03 주에만 쓰고 지운다). tsc·build 통과.
  첫 실행 때 "결제 수 무변동" 단정이 15:51 태블릿 실결제 때문에 거짓 실패 → 결제·할 일·상담은 전후 숫자만 찍게 고침.
  다음: 원장 확인 → 3단계 선생님 화면(진도·숙제, 시험).
- **2026-11-07** — 2단계 푸시(a12bf0c), 16:13 배포 확인(/api/learning-report 401 = 연결됨).
- **2026-11-07** — **학부모 리포트 3단계 (선생님 화면 ①진도·숙제 ②시험 점수, 미푸시).**
  `client/src/pages/LearningReport.tsx`(/learning-report, 사이드바 "학습 기록 입력"), `components/learning-report/`
  (shared.ts 자동 저장 장치 · ProgressHomeworkTab · ExamTab). 저장 버튼 없음 — 칸을 고치면 0.7초 뒤 저장,
  화면을 떠나면 기다리던 저장을 즉시 보냄. 화면 계산은 shared/learningReport.ts 와 같은 함수(서버와 어긋나지 않게).
  서버 보완: 점수 칸을 비우면(null) 그 영역만 지움 — 테스트 32/32. tsc·build 통과.
  로컬 확인: 아침 09:51 부터 다른 창이 띄운 dev 서버가 3000 을 잡고 있어(구 코드) 3001 로 잠깐 띄워
  /api/learning-report 401·/learning-report 200·새 모듈 변환 확인 후 바로 종료. 실제 화면은 로그인이 필요해
  원장 확인 대기. 보강·노트 사진 탭은 4단계.
- **2026-11-07** — 3단계 푸시(193e97c) 16:35 배포. 원장 실사용 제보 "한마디 칸에 글씨가 두 번씩 눌림" →
  원인: 칸 값을 react-query 캐시에서 읽어 한 박자 늦게 돌아오는 사이 한글 조합이 깨짐. `LocalInput`(입력 중 값은
  칸이 직접 보유)으로 캐시에 묶인 칸 전부 교체 + 숙제 Enter 추가 시 조합 중 무시. 5d3e369, 17:33 배포.
  **이 화면에 칸을 새로 더할 때 캐시 값을 Input 에 바로 물리지 말 것 — LocalInput 을 쓴다.**
  (원장 "껐다 켜니 된다" — 옛 화면 파일이 남아 있었다. 재현 실험: 옛 방식 되덮어쓰기 15회, LocalInput 0회.)
- **2026-11-07** — **학부모 리포트 4단계 (보강 · 노트 사진 · 부모님 링크 탭, 미푸시).**
  MakeupTab(잡힌 보강, 학생 이름 눌러 예정→완료→불참, 보강 추천에서 바로 선택, 부모님께 보이는 문구 따로),
  PhotoTab(브라우저에서 긴 변 1600px JPEG 로 줄여 올림, 반 전체/학생별, 제목·대상 나중에 수정),
  LinksTab(링크 만들기·모두 만들기·재발급, 열람 여부·잠김 표시, "복사" 는 카톡 안내 문구+주소).
  **복사 버튼은 `PARENT_PAGE_READY=false` 로 잠가 둠** — 부모님 화면(5단계) 전에 링크를 보내면 빈 화면을 본다.
  5단계에서 true 로 바꿀 것. 서버: PATCH /api/learning-report/photos/:id (제목·대상). 테스트 33/33, tsc·build 통과.
- **2026-11-07** — 4단계 푸시(f6a4837) 19:09 배포.
- **2026-11-07** — **학부모 리포트 5단계 (부모님 화면 /p/:token, 미푸시).** ⚠️ 두 번째 로그인 없는 경로.
  `server/parent-report/` — data.ts(보여 줄 값만 골라 담음: 보호자 번호·학교·수납·다른 학생 이름/점수/한마디 없음,
  기록은 공개된 주만·일정은 즉시), render.ts(시안 v4 주황 그대로, 스크립트 0줄, 하단 탭은 홈·숙제·시험·노트 —
  시안의 알림·마이는 기능이 없어 뺌), routes.ts(토큰 → 횟수 제한 → 닫힘/퇴원 → 번호 뒤 4자리 → 쿠키).
  잠금: 틀린 횟수 누적, 5번째마다 잠금(30분, 10번 넘으면 24시간), 맞히면 0. 쿠키는 링크 주소 전용·180일,
  값은 링크id·토큰·뒤4자리 HMAC(재발급·번호 변경 시 자동 무효). 번호 입력 화면에는 학생 이름도 안 보임.
  선생님 미리보기 GET /api/learning-report/students/:id/preview (같은 그리기 함수, 공개 전 주도 보임).
  robots.txt 에 /p/ 추가. LinksTab 복사 잠금 해제(PARENT_PAGE_READY=true), 미리보기 버튼 2곳.
  원장 지시: 학습 기록 입력 반 목록은 **영어만**, 선생님 순서 정우석 → 고은채 → 김명근 → 나머지(이민준·임채영).
  `npm run test:parent-report` 14/14, test:learning-report 33/33, test:share 102/102, tsc·build 통과.
  로컬 3001 에서 /p/ 404 안내·CSP, robots, 미리보기 401 확인 후 종료. 가짜 데이터 렌더 캡처로 시안과 대조.
- **2026-11-07** — 5단계 푸시(bad87e3) 19:35 배포. 운영에서 robots /p/ 차단, /p/ 404+CSP, 미리보기 401,
  로그인·태블릿·레벨테스트 /r/ 정상. 다음: 6단계 — 원장이 한 반으로 2주 시범.
- **2026-11-07** — 원장이 수업 구조 설명: 월·수(화·목) 본수업 + **매 수업 단어시험**, 금(토) **클리닉**(듣기 / 브릿지 모의 /
  고등 모의 — 문제 풀고 오답 정리), 매주 시험. DB 상 클리닉은 별도 반이 아니다. 추천만 드리고 **만들지 않음**(원장 "내일 하자"):
  ① 단어시험 빠른 입력(학생 × 수업 요일, 맞은 개수만, 재시 추천) ② 클리닉 기록(종류·문항/정답·오답 정리 여부)
  ③ 부모님 홈 타일 = 진도/숙제/단어시험/주간시험 ④ 숙제 마감 기본값·지난주 불러오기.
  만들기 전 물을 것: 단어시험 문항 수·통과 기준·재시 시점 / 클리닉 학생 구성·종류 고정 여부 / 주간시험 요일·영역, 주말반 구조.
- **2026-11-08** — 원장 답: 클리닉 = 단계별 주간시험(듣기 17문항 / 브릿지 100점 / 고1 / 고2·3 모의고사), 선택 수강
  (중학생 약 15% 안 들음), 듣기반은 다른 교실, 브릿지·모의는 **여러 반이 섞여** 단계별로 푼다. 본수업 주 2회 시험 거의 없음.
  단어시험은 올 때마다, 문항 수가 학생마다 다름, **10% 이하 통과 / 15% 이하 반복쓰기 / 초과 재시험**.
  고등부는 클리닉 없음, 단어 매번, **내신 대비(시험 6~5주 전)가 핵심** → 별도 설계 예정.
  순서 합의: A 단어시험 → B 주간 클리닉(학생 단위, 반 섞임) → C 부모님 홈·PWA → D 고등 내신 대비(논의 후).
- **2026-11-08** — **A. 단어시험 (미푸시).** 새 테이블 `vocab_scores`(반×학생×날짜, total·wrong·retest_passed,
  migrate-add-learning-report.ts 에 추가 — 운영 DB 2회 실행, 기존 데이터 무변동). 판정 `vocabResult`(정수 비교, 경계 포함).
  PUT /api/learning-report/classes/:id/weeks/:w/vocab (일괄, wrong=null 은 지우기, 그 주 날짜만, 재시 통과는 재시험일 때만).
  선생님 "단어시험" 탭: 날짜 칸 = 반 시간표 요일(parseDays) + 기록 있는 날 + "날짜 추가"(클리닉 날), 틀린 개수만 입력,
  총 문항은 학생별 지난번 값 기본·칸 떠날 때만 반영(치는 중 "4" 로 틀린 개수가 깎이는 것 방지), 날짜별 전원 총 문항,
  재시험 칸에 "재시 통과" 체크, 재시험 미통과는 보강 추천에. 부모님 홈 타일 = 진도/숙제/**단어시험**/최근 시험,
  노트는 아래 카드, 숙제 화면에 날짜별 단어시험 카드. test:learning-report 38/38, test:parent-report 15/15, tsc·build 통과.
- **2026-11-08** — A 푸시(d0e4bfc) 14:31 배포. 원장 결정: **재시 통과도 부모님 화면의 "N회 통과" 에 센다**
  (render.ts vocabCounts, 카드에는 "재시 통과" 로 따로 표시). test:parent-report 15/15.

## 6. 작업 중 확인된 운영 환경 사실 (문서가 낡아 있었다)

- **운영 DB는 Neon 이 아니라 Railway Postgres 다.** `ARCHITECTURE.md`와 `DEPLOY_RAILWAY.md`는
  Neon 이라고 적고 있으나 실제 `DATABASE_URL` 은 Railway 의 Postgres 서비스를 가리킨다.
  코드는 `@neondatabase/serverless` 가 아니라 평범한 `pg` 드라이버를 쓰므로(`server/db.ts`) 동작에는 문제가 없다.
- **DB 이름은 `edusync` 다. 공개 주소의 기본값 `railway` 가 아니다.**
  Railway Postgres 서비스의 `DATABASE_PUBLIC_URL` 은 경로가 `/railway` 로 끝나는데,
  그 DB 에는 테이블이 9개뿐인 **낡은 껍데기**가 들어 있다(classes, enrollments, lesson_logs,
  payments, students, teachers, tenants, users, waiters). 실제 운영 데이터는 `/edusync` 에 있다(21개 테이블).
  → 로컬에서 운영 DB 에 붙을 때는 공개 주소의 경로를 `/edusync` 로 바꿔야 한다.
