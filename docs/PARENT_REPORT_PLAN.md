# 학부모 학습 리포트 — DB 설계 + 개발 계획

> 2026-11-07 작성. 디자인 확정본은 `design/parent-report/` 에 있다.
> 부모님 화면 `report_v4_flow_english.html`, 선생님 화면 `teacher_input_english.html`.
> 이 문서는 "무엇을 왜 이렇게 만드는가" 를 적는다. 개발 중 판단이 바뀌면 여기를 먼저 고친다.

## 0. 무엇을 만드는가

재원생 부모님이 카톡으로 받은 링크를 눌러 **우리 아이의 이번 주 학습**을 본다.
진도 · 숙제 검사 · 시험 점수(반에서의 위치) · 보강/재시 일정 · 선생님 노트 사진.
선생님은 EduSyncPro 관리 화면에서 **반 단위로 한 번에** 입력하고, "공개" 를 눌러야 부모님께 보인다.

### 확정된 결정 (원장, 2026-11-07)
| 항목 | 결정 |
|---|---|
| 첫 과목 | **영어(페이지원)**. 수학은 나중 (§8) |
| 포인트 색 | 주황 `#F96E00` |
| 채팅·문의 | **만들지 않는다** (선생님 답장 부담. 문의는 카톡·전화) |
| 부모님 접속 | **카톡으로 학생별 링크 + 첫 접속 때 보호자 번호 뒤 4자리 한 번 확인** |
| 영어 범위 | 보강 계획 **O** · 등원 기록 **X** |
| 수학 범위(나중) | 등원 기록 **+** 보강 계획 둘 다 |
| 다른 학원 | 쓸 수 있어야 한다. 로고·학원명은 학원별 설정, 페이지원 흔적 없어야 함 (§8) |
| 절대 금지 | 리포트에 **결제·수납 정보, 연락처, 상담 메모** 노출 |

## 1. 이미 있는 것 — 새로 만들지 않고 쓴다

| 있는 것 | 위치 | 이번에 어떻게 쓰나 |
|---|---|---|
| 학부모 공개 링크 규칙 (12자 토큰, IP 횟수 제한, noindex, 이스케이프) | `server/lib/shareLink.ts` | 토큰 생성·형식 검사·`checkShareRate`·`escapeHtml` 을 그대로 가져다 쓴다. 레벨테스트 결과지 링크와 같은 문지기 |
| 반·수강 | `classes`, `enrollments` | 반 학생 명단 = `enrollments.isActive` |
| 과목 | `classes.subject` ("영어"/"국어") | 시험 영역 기본값을 고른다 (영어 → 어휘·문법·독해) |
| 등원 기록 | `attendance` (현재 0행) | **영어에서는 안 쓴다.** 수학 때 이 테이블을 그대로 읽는다 |
| 수업일지 | `lesson_logs` (5행, 8월 이후 안 씀) | **건드리지 않는다.** 날짜별 자유 텍스트라 주간 공개·학생별 기록을 담을 수 없다 |

## 2. 운영 데이터 규모 (2026-11-07 조회, 읽기만)

- 활성 학생 128명, 활성 반 33개(영어 20 · 국어 13), 학원(tenant) 5개
- 두 반을 듣는 학생 **1명** → 부모님 화면은 "반 하나" 기준으로 만들고, 둘 이상이면 위에 반 고르는 칩을 둔다
- 보호자 번호 없는 학생 **10명** → 이 학생들은 링크 발급 불가 (선생님 화면에 "번호부터 입력" 표시)
- 교사 계정 3개, 원장 계정 6개
- DB 전체 11MB

## 3. 데이터 모델 — 새 테이블 10개, 기존 테이블 변경 0개

**기존 테이블에 칼럼을 하나도 더하지 않는다.** `tenants.share_phone` 사고(railway.toml 주석 5)처럼
기존 테이블에 칸 하나 더하다 로그인이 죽는 위험을 아예 만들지 않으려는 설계다.
학원별 로고·색도 `tenants` 를 고치지 않고 별도 테이블로 둔다(§8).

공통 규칙: 모든 테이블에 `tenant_id`. 날짜는 `YYYY-MM-DD` 문자열(`shared/day.ts`).
상태값은 pgEnum 이 아니라 `text` + zod 검증 (CLAUDE.md).

### 3.1 `report_weeks` — 반 × 주 하나 (진도 + 공개 스위치)
```
id, tenant_id, class_id
week_start      text   그 주 월요일 YYYY-MM-DD. "11월 1주차" 표시는 여기서 계산
textbook        text   예: 중등 영어 Level 2
unit            text   예: Unit 05. Our Daily Life
topic           text   예: 현재완료 표현과 핵심 어휘
progress_pct    int    0~100, null 허용
published_at    timestamp  NULL = 작성 중(부모님께 안 보임). 공개 버튼이 채운다
published_by    varchar → users
created_by, created_at, updated_at
UNIQUE (class_id, week_start)
```
**왜 주 단위 행이 따로 있나:** "공개" 를 숙제·점수·사진 하나하나가 아니라 **반의 한 주 전체**에
한 번 거는 것이 선생님에게 실수가 적다. 숙제·시험·사진은 전부 이 행에 매달린다.

### 3.2 `homework_items` — 반 전체에 낸 숙제
```
id, tenant_id, report_week_id
title        text   예: 워크북 p.32–35
total_count  int    20 (문항/단어/회). NULL 이면 완료·일부·안함만 고르는 숙제
count_unit   text   "문항" | "단어" | "회"
due_date     text   YYYY-MM-DD
sort_order   int
```

### 3.3 `homework_checks` — 학생별 검사 결과
```
id, tenant_id, homework_item_id, student_id
status       text   done | partial | none | pending(마감 전·미검사)
done_count   int    해온 개수. total_count 가 있으면 status 는 서버가 이 값으로 정한다
updated_by, updated_at
UNIQUE (homework_item_id, student_id)
```
"6문항 모자랍니다" 는 저장하지 않고 `total_count − done_count` 로 그때그때 계산한다.

### 3.4 `exams` — 시험 한 번
```
id, tenant_id, class_id, report_week_id
name         text   예: Unit 05 주간평가
kind         text   weekly | monthly | unit | retest
exam_date    text   YYYY-MM-DD
pass_score   int    통과 기준 (예: 70)
areas        jsonb  ["어휘","문법","독해"]  ← 시험마다 저장. 수학이면 ["연산","개념이해","문제해결"]
retest_of    varchar → exams.id  (재시험이면 원래 시험)
created_by, created_at, updated_at
```
**왜 영역 이름을 시험마다 저장하나:** 수학·국어를 붙일 때 테이블을 바꾸지 않아도 된다.
과목별 기본값만 코드에 둔다.

### 3.5 `exam_scores` — 학생별 점수
```
id, tenant_id, exam_id, student_id
area_scores  jsonb  {"어휘":88,"문법":76,"독해":90}
total        int    서버가 영역 평균을 반올림해 저장 (85)
absent       boolean  결시
comment      text   선생님 한마디 (부모님께 보임)
UNIQUE (exam_id, student_id)
```
반 평균 · 상위 % · 통과 여부는 **저장하지 않는다.** 점수를 고치면 저절로 맞아야 하므로 읽을 때 계산한다.
상위 % 는 응시자 5명 미만이면 표시하지 않는다(소수 반에서 순위가 그대로 드러나는 것을 막는다).

### 3.6 `makeup_sessions` — 보강 · 재시 일정
```
id, tenant_id, class_id
date         text   YYYY-MM-DD
start_time   text   "17:00"
minutes      int    60
reason       text   retest | homework | absence | other
content      text   부모님께 보이는 문구 (예: 워크북 문법 보충 p.34–35)
exam_id      varchar → exams.id  (재시면 어느 시험의 재시인가)
created_by, created_at, updated_at
```

### 3.7 `makeup_students` — 보강에 잡힌 학생
```
id, tenant_id, makeup_id, student_id
status       text   scheduled | done | noshow
UNIQUE (makeup_id, student_id)
```
보강 하나에 여러 학생(재시 3명 한꺼번에)이 붙으므로 따로 둔다.

### 3.8 `note_photos` + `note_photo_files` — 노트 사진
```
note_photos:      id, tenant_id, report_week_id, student_id(NULL = 반 전체), title, taken_date,
                  width, height, bytes, created_by, created_at
note_photo_files: photo_id(PK) → note_photos, mime, data bytea
```
**왜 둘로 나누나:** 목록·리포트 화면은 사진 정보만 읽고 실제 이미지는 `<img>` 가 따로 부른다.
한 테이블에 두면 목록 한 번에 사진 수십 장이 딸려 와 느려진다. 저장 위치 결정은 §5.

### 3.9 `parent_links` — 부모님 링크
```
id, tenant_id, student_id
token            text   12자 (shareLink.generateShareToken). UNIQUE (token IS NOT NULL 부분 인덱스)
revoked_at       timestamp  재발급하면 기존 행에 찍히고 새 행이 생긴다
failed_attempts  int    뒤 4자리 틀린 횟수
locked_until     timestamp
last_viewed_at   timestamp
view_count       int
created_by, created_at
```
학생당 살아 있는 링크는 하나. 확인 번호(뒤 4자리)는 **저장하지 않고** 그때그때 `students.parent_phone` 끝 4자리와 비교한다 —
보호자 번호를 바꾸면 확인 번호도 저절로 따라간다.

## 4. 부모님 접속 — 보안 흐름

```
카톡 링크  /p/<12자 토큰>      ← /r/ 은 레벨테스트 결과지가 이미 쓴다 (2단계에서 발견, /p/ 로 바꿈)
  ├─ 토큰 형식 틀림 / 없음 / 재발급으로 닫힘  → 안내 화면 (shareLink.renderShareError 재사용)
  ├─ 학생이 퇴원(isActive=false)                → "닫힌 링크" (퇴원하면 저절로 닫힌다)
  ├─ 이 폰에 확인 쿠키 있음                     → 바로 리포트
  └─ 없음 → "보호자 번호 뒤 4자리" 입력
        ├─ 맞음  → 확인 쿠키(HttpOnly, 180일, 이 토큰 전용 서명) 심고 리포트
        └─ 틀림  → 5번 틀리면 그 링크 30분 잠금
```
- 4자리는 1만 가지라 **링크별 잠금**이 핵심 방어선이다. IP 제한(`checkShareRate`)은 그 위에 한 겹 더.
- 레벨테스트 링크와 달리 **기한(5일)이 없다.** 재원 중 계속 보는 화면이라서다. 대신 퇴원·재발급으로 닫힌다.
- 화면은 **서버가 HTML 을 직접 그린다** (`shareReport.ts` 와 같은 방식). React 앱 묶음을 로그인 없이 내려보내지 않고,
  화면 전환은 링크 이동(`/p/<토큰>`, `/p/<토큰>/homework`, `/p/<토큰>/exam`)이라 구형 폰에서도 깨질 곳이 없다.
- 보여 주는 칸은 **고른 것만(allowlist)**: 학생 이름·학년·반 이름, 공개된 주의 진도·숙제·점수·한마디·사진, 보강 일정.
  연락처·학교·수납·상담 메모는 쿼리 단계에서 아예 꺼내지 않는다.
- 공개 경로의 쓰기는 "열어 본 시각·횟수" 와 "틀린 횟수" 뿐이다.

## 5. 노트 사진 저장 위치 — **DB 로 확정 (원장, 2026-11-07)**

규모 추정: 영어 20반 × 주 2장 × 압축 후 약 250KB ≈ **주 10MB, 1년 약 500MB.** (지금 DB 전체가 11MB)

**비용 (Railway 요금표 2026-11-07 확인):** 볼륨 $0.15/GB·월, 송신 $0.05/GB, Hobby 볼륨 한도 5GB,
Hobby 는 월 $5 사용량 포함.
- 저장(6개월 보관 ≈ 0.26GB) ≈ $0.04/월, 부모님 열람 송신(월 ≈ 0.8GB) ≈ $0.04/월 → **합계 월 약 110원.**
- 지금 사용량이 $5 안쪽이면 추가 청구는 사실상 0원. 지우지 않고 쌓아도 5GB 까지 약 9년.

**제외한 안:**
- **원장 NAS 직접 저장** — NAS 를 인터넷에 열어야 하는데 그 NAS 에 교재·시험지 전체가 있다(시놀로지 대상
  랜섬웨어 전례). 그리고 NAS 가 꺼지면 부모님 화면 사진이 전부 깨진다. 원장이 듣고 철회.
- **외부 저장소(R2 등)** — 가입·키 관리가 늘어나는데 비용 차이가 월 100원 수준이라 얻는 게 없다.

구현: 올리기 전에 브라우저에서 긴 변 1600px · JPEG 로 줄여서(장당 200~300KB) 저장.
저장·읽기를 함수 하나(`photoStore`)로 감싸 둔다 — 사진이 크게 늘면 Railway 자체 Object Storage
($0.015/GB·월, 같은 Railway 계정이라 새 가입 불필요)로 그 함수만 바꿔 옮길 수 있다.
**보관 기간: 6개월 (원장 확정, 2026-11-07).** 찍은 날(`taken_date`)로부터 6개월 지난 사진은 서버가 하루 한 번
`note_photo_files` 를 지운다. `note_photos` 행(제목·날짜)은 남기고, 그 주 리포트에는 "보관 기간이 지난 사진" 으로 표시한다.

## 6. 공개 규칙 (선생님이 헷갈리지 않게 하나로)

- **기록**(진도·숙제·점수·한마디·사진): 그 주를 **공개해야** 부모님께 보인다. 입력 중에는 자동 저장만 된다.
- 공개한 뒤 고친 내용은 **바로** 반영된다 (다시 공개 누를 필요 없음, 화면에 "공개됨 · 고치면 바로 반영" 표시).
- **일정**(보강·재시): 등록하는 순간 보인다. 날짜가 급한 정보라 공개를 기다리면 의미가 없다.
- 공개 취소 버튼을 둔다 (잘못 공개했을 때 되돌리기).
- **누가 하나: 강사·원장 둘 다** 입력하고 공개한다 (원장 확정, 2026-11-07 — "실제로 입력하는 건 강사다").
  강사는 자기 학원 반이면 모두 가능하다. 누가 공개했는지는 `published_by` 에 남는다.

**왜 공개 버튼이 있나 (원장에게 설명한 내용):** 점수를 10명 중 5명만 넣은 상태가 바로 보이면 나머지 부모님은
"우리 애 점수가 없다" 가 되고 반 평균·상위 % 도 틀리게 나간다. 오타 점수가 그대로 나가는 것도 막는다.
원장이 번거롭다고 하면 "입력 즉시 공개" 로 바꿀 수 있게 `published_at` 을 반 생성 시 채우는 설정 하나로 해결된다.

## 7. 단계별 진행

각 단계가 끝나면 **멈추고** 확인 방법을 알린 뒤 승인을 받는다. 로컬 `npm run dev` 로 먼저 확인하고, 승인 후에만 푸시.
⚠️ 시작 전에 **진행 중인 스케줄러 작업(미커밋)이 먼저 커밋·배포**돼야 한다. `shared/schema.ts`·`railway.toml` 을 같이 고치기 때문.

### 1단계 — 스키마 + 마이그레이션
- `shared/schema.ts` 에 테이블 10개 + zod 검증 스키마
- `scripts/migrate-add-learning-report.ts` (CREATE TABLE IF NOT EXISTS ×10, 부분 유니크 인덱스)
- `package.json` `db:migrate:learning-report`, `railway.toml` preDeployCommand **맨 끝**에 추가
- **확인**: 두 번 연속 실행해도 에러 없음(멱등). 기존 테이블 행 수 변동 없음(결제·학생·상담 개수 전후 비교)

### 2단계 — 선생님용 서버 API
- 반·주 열기(없으면 생성) / 진도 저장 / 공개·공개취소
- 숙제 출제 CRUD, 검사 일괄 저장("전원 완료로 채우기" 포함)
- 시험·점수 저장(총점 서버 계산), 재시 일괄 등록
- 보강 CRUD + 학생 상태 변경, 보강 필요 학생 추천(숙제 0/3·일부, 재시 대상)
- 사진 올리기(크기·형식 검사) / 삭제
- 링크 발급·복사·재발급, 열람 현황
- 라우트는 `authGuard → tenantGuard → roleGuard("owner","teacher","superadmin") → validateBody`
- **확인**: `npm run test:learning-report` — 운영 DB 에 쓰고 finally 에서 스스로 지우는 방식(test:projects 와 같음)

### 3단계 — 선생님 화면 ① 진도·숙제 ② 시험 점수
- `client/src/pages/LearningReport.tsx`, 사이드바 "학부모 리포트" 묶음
- 칸을 고치면 0.8초 뒤 자동 저장, 하단 "자동 저장됨 · 시각"
- **확인**: 중2 정규반 한 주 입력 → 새로고침해도 그대로, 총점·평균·재시 대상 자동 계산 맞음

### 4단계 — 선생님 화면 ③ 보강 ④ 노트 사진 · 부모님 링크
- **확인**: 보강 등록 → 목록·추천에 반영 / 사진 올리면 줄어든 크기로 저장 / 링크 복사·재발급

### 5단계 — 부모님 화면 (공개 링크)
- `server/parent-report/` — 토큰 확인, 뒤 4자리 확인·쿠키·잠금, 3개 화면 HTML
- 선생님 화면의 "부모님 화면 미리보기" 도 같은 그리기 함수를 쓴다 (미리보기와 실제가 어긋나지 않게)
- **확인**: 원장 폰으로 링크 열기 → 4자리 확인 → 홈·숙제·시험 이동 / 5번 틀리면 잠김 / 재발급하면 옛 링크 막힘 /
  공개 전 주는 안 보임 / 퇴원 처리하면 닫힘

### 6단계 — 배포 + 시범 운영
- 푸시 → 배포 후 운영 주소에서 위 확인 반복 + **수납 태블릿 결제 1건 정상 확인**
- **한 반(중2 정규반)으로 2주 시범** → 원장·선생님 의견 반영 → 전체 반

## 8. 나중에 (이번 범위 아님, 설계는 막지 않게 해 둠)

- **수학 버전**: `report_v4_flow_math.html` 디자인. 시험 영역 프리셋만 다르고 테이블은 같다.
  **등원 기록**은 기존 `attendance` 테이블을 부모님 화면에 붙이고, 보강은 이번 것을 그대로 쓴다.
- **다른 학원(화이트라벨)**: `tenant_branding` 테이블(학원 표시 이름, 색, 로고 이미지)을 따로 만든다.
  `tenants` 는 건드리지 않는다. 그 전까지 부모님 화면 상단은 `tenants.name` 을 그대로 쓴다 —
  다른 학원 데이터에는 애초에 페이지원 글자가 들어갈 경로가 없다.
  다른 학원에 실제로 열기 전에 **모든 쿼리에 tenantId 필터가 있는지 전수 점검**을 한 번 한다.
- **카톡 자동 발송(알림톡)**: 카카오 비즈니스 채널 심사가 필요하다. 지금은 "링크 복사 → 카톡 붙여넣기" 로 간다.

## 9. 원장에게 물어볼 것

1. ~~노트 사진 저장~~ → **DB 로 확정** (§5)
2. ~~사진 보관 기간~~ → **6개월 자동 삭제로 확정** (§5)
3. ~~강사 권한~~ → **강사·원장 둘 다 입력 + 공개** (§6)

남은 질문 없음. 스케줄러 작업이 배포되면 1단계 시작.
