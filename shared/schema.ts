import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, decimal, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums
export const userRoleEnum = pgEnum("user_role", ["owner", "teacher", "superadmin"]);
export const tenantStatusEnum = pgEnum("tenant_status", ["pending", "active", "expired", "suspended"]);
export const paymentStatusEnum = pgEnum("payment_status", ["paid", "overdue", "pending"]);

// 결제 수단 / 거래 종류 (자연어 입력 기능에서 사용)
export const paymentMethodEnum = pgEnum("payment_method", ["계좌이체", "카드", "현금"]);
export const paymentTypeEnum = pgEnum("payment_type", ["원비", "환불", "지출", "기타"]);

// ─── Toss Front 2 통합 관련 enum ────────────────────────────────────────────
// 결제 의도(payment intent)의 상태 머신. 프론트 SDK → 서버 confirm → 웹훅 재검증까지의
// 흐름에서 상태가 잘못 바뀌면 이중 납부 또는 미납 오탐이 생긴다. 그래서 enum으로 강제한다.
// CREATED → PROCESSING → APPROVED (성공 경로)
// CREATED → PROCESSING → CANCELED / TIMEOUT / FAILED (실패 경로)
export const paymentIntentStatusEnum = pgEnum("payment_intent_status", [
  "CREATED",
  "PROCESSING",
  "APPROVED",
  "CANCELED",
  "TIMEOUT",
  "FAILED",
]);

// 웹훅 처리 상태. FAILED는 서명 검증 실패 또는 서버 오류로 처리 못 한 이벤트.
// IGNORED는 우리 시스템에서 다루지 않는 이벤트라 의도적으로 건너뛴 것.
export const webhookStatusEnum = pgEnum("toss_webhook_status", [
  "RECEIVED",
  "PROCESSED",
  "IGNORED",
  "FAILED",
]);

// 결제 방법 (SDK 응답 기반). CARD가 압도적으로 많지만 현금영수증·바코드도 온다.
export const tossPaymentMethodEnum = pgEnum("toss_payment_method", [
  "CARD",
  "CASH",
  "BARCODE",
]);

// 외부 결제 제공자. 지금은 TOSSPLACE 하나지만, 나중에 KIS 등이 추가될 수 있어 enum으로 둔다.
export const externalProviderEnum = pgEnum("external_provider", ["TOSSPLACE"]);

// 결제가 어느 경로로 들어왔는지. TOSS_FRONT는 로비 무인 결제, MANUAL은 원장이 관리자 화면에서 수기 입력.
export const paidViaEnum = pgEnum("paid_via", ["MANUAL", "TOSS_FRONT"]);

// 출석 체크가 어느 경로로 들어왔는지. KIOSK = Toss Front, MANUAL = 원장/강사 수기.
export const attendanceSourceEnum = pgEnum("attendance_source", ["MANUAL", "KIOSK"]);

// ─── Toss "결제 단말기 모드"용 dispatch 상태 ───────────────────────────
// 태블릿(학생용 키오스크 웹)이 서버에 결제요청을 보내면, 서버가 특정 프론트 단말기에
// dispatch 레코드를 만들고 SSE로 밀어낸다. 프론트가 실제 승인까지 성공하면
// 이 dispatch도 APPROVED로 마감된다. payment_intents.status와는 별도 트랙:
//   - payment_intents: paymentKey 관점 (한 결제 시도의 승인 여부)
//   - payment_dispatches: 태블릿-프론트 라우팅 관점 (전달·수신·응답 상태)
// 두 상태가 항상 1:1로 도는 이유는 dispatch 하나가 정확히 하나의 paymentKey에 묶이기 때문.
export const paymentDispatchStatusEnum = pgEnum("payment_dispatch_status", [
  "PENDING",   // 서버가 큐에 담음, 프론트가 아직 수신 안 함
  "DELIVERED", // 프론트가 SSE 또는 폴링으로 받아감
  "APPROVED",  // 결제 승인 완료 (프론트가 결과 업로드)
  "CANCELED",  // 사용자가 태블릿에서 취소 or 프론트에서 취소
  "TIMEOUT",   // 만료(3분)까지 아무 응답 없음
  "FAILED",    // 프론트가 결제 실패 응답을 업로드
]);

// 상담 진행 상태
// 흐름: 상담문의 → 레벨테스트예정 → 레벨테스트완료 → 반배정상담 → 최종등록 / 대기등록 / 보류
// 레벨테스트 3단계를 명시적으로 트래킹해서 원장이 "지금 어느 단계에 몇 명 있는지"를
// 대시보드에서 바로 알 수 있게 만든다. 각 단계에서 원생이 사라지지 않게 하는 게 매출과 직결된다.
export const consultationStatusEnum = pgEnum("consultation_status", [
  "상담문의",
  "레벨테스트예정",
  "레벨테스트완료",
  "반배정상담",
  "대기등록",
  "최종등록",
  "보류",
]);

// 할 일을 언제까지 끝내야 하는지. 기본값이자 대부분인 "퇴근전"이 이 기능의 본체다.
export const taskSlotEnum = pgEnum("task_slot", ["퇴근전", "출근전"]);

// Tenant table (학원)
export const tenants = pgTable("tenants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountNumber: varchar("account_number").notNull().unique(),
  name: text("name").notNull(), // 학원명
  ownerName: text("owner_name").notNull(), // 대표자명
  ownerPhone: text("owner_phone").notNull(), // 대표자 연락처
  status: tenantStatusEnum("status").default("pending").notNull(),
  activeUntil: timestamp("active_until"),
  // 학년 자동 진급을 어느 학년도까지 반영했는가. 3월이 지나 이 값보다 학년도가
  // 커지면 한 번 올리고 갱신한다. 이게 없으면 서버가 재시작될 때마다 학년이
  // 계속 올라간다. NULL이면 "아직 한 번도 안 돌았다"는 뜻이고, 이때는 올리지
  // 않고 현재 학년도를 적어 두기만 한다 (기능을 켠 날 전원이 진급해 버리는 사고 방지).
  lastGradePromotionYear: integer("last_grade_promotion_year"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// User table (사용자)
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Teacher table (교사)
export const teachers = pgTable("teachers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(), // 담당 과목
  phone: text("phone"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Class table (반)
export const classes = pgTable("classes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  teacherId: varchar("teacher_id").references(() => teachers.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(), // 반 이름
  subject: text("subject").notNull(), // 과목
  schedule: text("schedule").notNull(), // 수업 일정 (월수금, 화목토, 주말 등)
  defaultTuition: integer("default_tuition").notNull(), // 기본 수강료
  maxStudents: integer("max_students").default(20),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Student table (학생)
export const students = pgTable("students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  school: text("school"),
  grade: text("grade"), // "중1", "고2" 등
  gender: text("gender"), // "남", "여"
  parentPhone: text("parent_phone"),
  siblingGroup: text("sibling_group"), // 형제 그룹 (같은 보호자)
  notes: text("notes"), // 특이사항
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Enrollment table (수강 등록)
export const enrollments = pgTable("enrollments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  tuition: integer("tuition"), // 개별 수강료 (없으면 반의 기본 수강료 사용)
  dueDay: integer("due_day").default(8), // 납입 기준일
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Payment table (수납)
export const payments = pgTable("payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 원비/환불은 수강 등록에 연결되지만, 학원 운영 지출은 연결할 등록이 없으므로 nullable.
  enrollmentId: varchar("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }),
  // ⚠️ 부호 규칙: 원비는 양수, 환불·지출은 음수로 저장한다.
  // Payments 화면이 amount를 단순 SUM 하므로, 이렇게 해야 합계가 자동으로 순액이 된다.
  amount: integer("amount").notNull(),
  type: paymentTypeEnum("type").default("원비").notNull(),
  method: paymentMethodEnum("method"), // 계좌이체/카드/현금 (모르면 null)
  paymentMonth: text("payment_month").notNull(), // YYYY-MM 형식
  paidDate: timestamp("paid_date").notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  notes: text("notes"),
  // 자연어 입력으로 생성된 건지 표시 (원본 문장 보관 → 나중에 오분류 추적용)
  sourceText: text("source_text"),
  // ─── 외부 결제 시스템 연결 (Toss Front 2 등) ──────────────────────────
  // 이 결제가 외부 승인망을 통해 들어온 경우, 어떤 제공자·어떤 결제키로 왔는지 기록한다.
  // manual 수기 입력은 세 컬럼 모두 null이고 paidVia="MANUAL".
  // 웹훅 재수신 시 external_payment_key로 원거래를 되짚어 상태를 되돌린다.
  externalProvider: externalProviderEnum("external_provider"),
  externalPaymentKey: text("external_payment_key"), // Toss paymentKey (unique index로 중복 승인 차단)
  externalTransactionId: varchar("external_transaction_id"), // toss_payment_transactions.id
  paidVia: paidViaEnum("paid_via").default("MANUAL").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Consultation table (상담/문의)
export const consultations = pgTable("consultations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 원장이 학생 앞에서 급히 적은 등록 건은 연락처가 없을 수 있다.
  // NOT NULL이던 시절엔 그런 입력이 저장 단계에서 통째로 막혔다.
  phone: text("phone"),
  guardianName: text("guardian_name"), // 보호자명
  studentName: text("student_name"),
  studentGrade: text("student_grade"), // "중1", "고2" 등
  status: consultationStatusEnum("status").default("상담문의").notNull(),
  subject: text("subject"), // 문의 과목
  followUp: text("follow_up"), // 후속 조치 (예: "다음주 화요일 재통화")
  memo: text("memo"),
  // 최종등록으로 전환되면 아래 두 필드가 채워진다
  classId: varchar("class_id").references(() => classes.id, { onDelete: "set null" }),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "set null" }),
  // 레벨테스트 관련 (상담 흐름: 상담문의 → 레벨테스트예정 → 레벨테스트완료 → 반배정상담 → 최종등록/대기등록/보류)
  levelTestDate: timestamp("level_test_date"), // 레벨테스트 예정/완료 일시
  levelTestScore: text("level_test_score"),    // 점수 또는 등급 문자열 (예: "85점", "B+")
  levelTestNotes: text("level_test_notes"),    // 레벨테스트 결과 메모
  recommendedClassId: varchar("recommended_class_id").references(() => classes.id, { onDelete: "set null" }), // 반배정상담 단계에서 추천된 반
  sourceText: text("source_text"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// LessonLog table (반별 일지)
export const lessonLogs = pgTable("lesson_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  date: timestamp("date").notNull(),
  progress: text("progress"), // 진도
  homework: text("homework"), // 숙제
  notes: text("notes"), // 특이사항
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Waiter table (대기자)
export const waiters = pgTable("waiters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Task table (퇴근전 할 일)
export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  // YYYY-MM-DD. timestamp를 쓰면 UTC로 저장되어 한국 시각 오후 9시에 적은 할 일이
  // 전날 것으로 뜬다. 하루 단위 기능이라 날짜 문자열이 맞다.
  dueDate: text("due_date").notNull(),
  slot: taskSlotEnum("slot").default("퇴근전").notNull(),
  // 완료 시각. null이면 아직 안 끝난 일이다.
  completedAt: timestamp("completed_at"),
  // 며칠 미뤘는지. 미루기 한 번이 하루이므로 이 값이 곧 밀린 날수다.
  // 화면에서 숫자가 커질수록 빨갛게 만들어 경고하는 근거가 된다.
  deferCount: integer("defer_count").default(0).notNull(),
  notes: text("notes"),
  sourceText: text("source_text"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// AI Audit Log table (AI 자연어 처리 감사 로그)
export const aiAuditLogs = pgTable("ai_audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  sourceText: text("source_text").notNull(),
  intent: text("intent"),
  toolsCalled: text("tools_called"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  result: text("result"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Attendance table (출석) ───────────────────────────────────────────
// 학생이 학원 로비 태블릿(Toss Front 또는 자체 키오스크)에서 등원 체크한 기록.
// 원장·강사가 관리자 화면에서 수기 입력한 것도 여기 쌓인다.
// unique(studentId, classId, date)로 같은 수업의 하루 이중 출석을 DB에서 막는다.
export const attendance = pgTable("attendance", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  // 출석 대상 수업의 날짜 (YYYY-MM-DD). timestamp가 아니라 문자열로 두는 이유는
  // "18시 수업에 밤 9시에 체크인해도 그날 출석"으로 계산해야 하는데 UTC로 저장하면
  // 자정 근처 체크인이 다음날 기록으로 넘어간다. 하루 단위 기능이라 날짜 문자열이 맞다.
  attendedDate: text("attended_date").notNull(),
  // 실제 체크인이 일어난 시각. 정각 출석/지각 판정에 쓴다.
  checkedInAt: timestamp("checked_in_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  source: attendanceSourceEnum("source").default("MANUAL").notNull(),
  // 키오스크 체크인이면 어느 기기에서 왔는지. MANUAL은 null.
  deviceId: varchar("device_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Toss Front devices (등록된 로비 단말기) ──────────────────────────
// 학원마다 로비에 한두 대씩 배치되는 Toss Front 2 태블릿을 여기서 관리한다.
// 원장이 관리자 화면에서 페어링 코드로 등록하면 이 테이블에 행이 생기고,
// 이후 기기가 서버에 접근할 때 deviceKeyHash로 인증한다.
export const tossFrontDevices = pgTable("toss_front_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 토스 가맹점 ID. 학원마다 한 개이며 tenants와 1:1이지만 여기 중복 저장해 조회 편의성 확보.
  merchantId: text("merchant_id").notNull(),
  // 기기 인증용 장기키의 해시(bcrypt 또는 sha256). 원본 키는 기기에만 존재.
  // 서버가 원본을 갖지 않아야 DB 유출 시에도 기기 위조가 불가능하다.
  deviceKeyHash: text("device_key_hash").notNull().unique(),
  displayName: text("display_name").notNull(), // "페이지원 로비 프론트" 등
  isActive: boolean("is_active").default(true).notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Payment intents (결제 의도) ───────────────────────────────────────
// 학생이 "결제하기"를 누른 시점에 서버가 미리 만드는 예약 레코드.
// paymentKey를 여기서 생성해 프론트로 넘기고, SDK 승인 후 confirm으로 되돌아온다.
// 같은 청구에 대해 여러 번 시도가 있을 수 있어 unique(paymentKey)만 유지.
export const paymentIntents = pgTable("payment_intents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  paymentKey: text("payment_key").notNull().unique(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  // 어떤 수강 등록에 대한 결제인가. invoice 테이블이 없어서 enrollment + paymentMonth로 대체.
  enrollmentId: varchar("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }).notNull(),
  // 청구월 (YYYY-MM). enrollment + 이 값이 논리적 청구 건을 특정한다.
  paymentMonth: text("payment_month").notNull(),
  deviceId: varchar("device_id").references(() => tossFrontDevices.id, { onDelete: "set null" }),
  // 금액 필드는 확정 시점의 값을 그대로 저장한다. 프론트가 조작한 금액을 신뢰하지 않기 위해
  // confirm 시 이 값과 SDK 응답 금액을 대조한다.
  amount: integer("amount").notNull(),
  tax: integer("tax").default(0).notNull(),
  supplyValue: integer("supply_value").default(0).notNull(),
  taxExemptValue: integer("tax_exempt_value").default(0).notNull(),
  status: paymentIntentStatusEnum("status").default("CREATED").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  approvedAt: timestamp("approved_at"),
  cancelledAt: timestamp("cancelled_at"),
  // 실패·타임아웃 원인 요약 (디버깅용, 개인정보 없음)
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Toss payment transactions (승인 결과 원본) ─────────────────────────
// 실제 카드 승인 결과를 그대로 보관하는 감사 테이블. 세금계산·환불·영수증 재발행에 쓴다.
// 승인번호·TID·van transaction key는 pgcrypto로 암호화 저장하는 것이 이상적이지만
// 1차 버전에서는 text로 두고, 애플리케이션 레이어에서 접근을 최소화한다.
// 카드 원본번호는 절대 저장하지 않으며, 마스킹된 번호만 저장한다.
export const tossPaymentTransactions = pgTable("toss_payment_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  paymentKey: text("payment_key").notNull().unique(),
  intentId: varchar("intent_id").references(() => paymentIntents.id, { onDelete: "cascade" }).notNull().unique(),
  paymentMethod: tossPaymentMethodEnum("payment_method").notNull(),
  van: text("van"),
  tid: text("tid"), // 거래 TID (취소 시 필요). 앱 레이어에서 접근 제한.
  vanTransactionKey: text("van_transaction_key"), // 무카드 취소용
  approvalNumber: text("approval_number").notNull(),
  approvedTimestamp: text("approved_timestamp").notNull(), // SDK가 준 timestamp (밀리초, 정밀도 보존 위해 text)
  maskedCardNumber: text("masked_card_number"),
  issuerName: text("issuer_name"),
  acquirerName: text("acquirer_name"),
  cardType: text("card_type"),
  installment: integer("installment").default(0).notNull(),
  // SDK 원본 응답의 최소 필드만 JSON으로 감사용 저장. 카드 원본번호 필드는 저장 전에 삭제.
  rawResponseJson: text("raw_response_json"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Toss webhook events (수신한 웹훅 감사) ──────────────────────────────
// TossPlace Open API가 보내는 결제 승인/취소 웹훅을 여기 먼저 원문 그대로 저장한다.
// x-toss-webhook-id를 PK로 두어 재전송 시 자동 중복 방지.
// 서명 검증 실패도 status=FAILED로 저장해 공격 시도를 로그로 남긴다.
export const tossWebhookEvents = pgTable("toss_webhook_events", {
  webhookId: text("webhook_id").primaryKey(), // x-toss-webhook-id
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  eventId: text("event_id"),      // x-toss-event-id
  deliveryId: text("delivery_id"), // x-toss-delivery-id (재전송마다 달라짐)
  eventType: text("event_type"),
  signatureValid: boolean("signature_valid").default(false).notNull(),
  status: webhookStatusEnum("status").default("RECEIVED").notNull(),
  // 원문 body 그대로 (JSON 문자열). 사후 대사에 필요.
  payloadJson: text("payload_json"),
  errorMessage: text("error_message"),
  receivedAt: timestamp("received_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  processedAt: timestamp("processed_at"),
});

// ─── Kiosk devices (학생용 태블릿 웹앱 인증) ────────────────────────────
// 이건 Toss Front 하드웨어가 아니다. 학원 로비에 세워두는 일반 태블릿의 브라우저에서
// 여는 EduSyncPro 학생 키오스크 웹페이지 전용 인증 토큰이다.
// 원장이 관리자 화면에서 발급 → 태블릿 setup 페이지에 한 번 붙여넣기 → localStorage 저장.
// 이후 이 태블릿은 로그인 없이 학생 검색·청구서 조회·결제요청 만 할 수 있다.
export const kioskDevices = pgTable("kiosk_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 태블릿이 지닌 장기키의 해시. Toss Front device와 같은 방식.
  kioskKeyHash: text("kiosk_key_hash").notNull().unique(),
  displayName: text("display_name").notNull(), // "로비 태블릿 1" 등
  // 이 태블릿에서 만든 dispatch를 어느 Toss Front로 보낼지. NULL이면 tenant 내 첫 활성 프론트로 자동 라우팅.
  // 실무: 학원에 프론트 1대뿐이면 NULL이 편하고, 여러 대면 명시적으로 매핑.
  pairedFrontDeviceId: varchar("paired_front_device_id").references(() => tossFrontDevices.id, { onDelete: "set null" }),
  isActive: boolean("is_active").default(true).notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Payment dispatches (태블릿 → 프론트 라우팅 큐) ────────────────────
// "결제 단말기 모드"의 핵심 테이블. 태블릿 웹에서 결제하기를 눌렀을 때 서버가 이 행을 만들고
// SSE로 프론트에 밀어낸다. 프론트가 실패해도 재시도할 수 있게 감사기록으로 남긴다.
//
// paymentKey를 UNIQUE로 두는 이유: 같은 결제요청이 두 번 dispatch되면 안 된다.
// 프론트 재시작 후 폴백 폴링으로 다시 받아도 이 UNIQUE가 방어.
export const paymentDispatches = pgTable("payment_dispatches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  paymentKey: text("payment_key").notNull().unique(),
  intentId: varchar("intent_id").references(() => paymentIntents.id, { onDelete: "cascade" }).notNull().unique(),
  // 어느 태블릿에서 시작됐는가 (감사·화면 표시)
  kioskDeviceId: varchar("kiosk_device_id").references(() => kioskDevices.id, { onDelete: "set null" }),
  // 어느 프론트로 보냈는가 (SSE 채널 라우팅 키)
  tossDeviceId: varchar("toss_device_id").references(() => tossFrontDevices.id, { onDelete: "set null" }).notNull(),
  amount: integer("amount").notNull(),
  // sdk.payment.requestPayment 에 그대로 넘길 두 값. 프론트 폴링 응답에도 포함되어야 하므로 여기에 저장한다.
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  status: paymentDispatchStatusEnum("status").default("PENDING").notNull(),
  // 프론트가 실제로 받아간 시각. NULL이면 아직 전달 안 됨.
  deliveredAt: timestamp("delivered_at"),
  // 프론트가 결과를 업로드한 시각.
  respondedAt: timestamp("responded_at"),
  // 만료 시각 (기본 3분). intent expiresAt과 정렬.
  expiresAt: timestamp("expires_at").notNull(),
  // 실패·취소 원인 요약 (개인정보 없음)
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Relations
export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  teachers: many(teachers),
  classes: many(classes),
  students: many(students),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  teacher: one(teachers),
  payments: many(payments),
  lessonLogs: many(lessonLogs),
}));

export const teachersRelations = relations(teachers, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [teachers.tenantId],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [teachers.userId],
    references: [users.id],
  }),
  classes: many(classes),
}));

export const classesRelations = relations(classes, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [classes.tenantId],
    references: [tenants.id],
  }),
  teacher: one(teachers, {
    fields: [classes.teacherId],
    references: [teachers.id],
  }),
  enrollments: many(enrollments),
  lessonLogs: many(lessonLogs),
  waiters: many(waiters),
}));

export const studentsRelations = relations(students, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [students.tenantId],
    references: [tenants.id],
  }),
  enrollments: many(enrollments),
}));

export const enrollmentsRelations = relations(enrollments, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [enrollments.tenantId],
    references: [tenants.id],
  }),
  student: one(students, {
    fields: [enrollments.studentId],
    references: [students.id],
  }),
  class: one(classes, {
    fields: [enrollments.classId],
    references: [classes.id],
  }),
  payments: many(payments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [payments.tenantId],
    references: [tenants.id],
  }),
  enrollment: one(enrollments, {
    fields: [payments.enrollmentId],
    references: [enrollments.id],
  }),
  createdBy: one(users, {
    fields: [payments.createdBy],
    references: [users.id],
  }),
}));

export const lessonLogsRelations = relations(lessonLogs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [lessonLogs.tenantId],
    references: [tenants.id],
  }),
  class: one(classes, {
    fields: [lessonLogs.classId],
    references: [classes.id],
  }),
  createdBy: one(users, {
    fields: [lessonLogs.createdBy],
    references: [users.id],
  }),
}));

export const consultationsRelations = relations(consultations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [consultations.tenantId],
    references: [tenants.id],
  }),
  class: one(classes, {
    fields: [consultations.classId],
    references: [classes.id],
  }),
  student: one(students, {
    fields: [consultations.studentId],
    references: [students.id],
  }),
  createdBy: one(users, {
    fields: [consultations.createdBy],
    references: [users.id],
  }),
}));

export const waitersRelations = relations(waiters, ({ one }) => ({
  tenant: one(tenants, {
    fields: [waiters.tenantId],
    references: [tenants.id],
  }),
  class: one(classes, {
    fields: [waiters.classId],
    references: [classes.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tasks.tenantId],
    references: [tenants.id],
  }),
  createdBy: one(users, {
    fields: [tasks.createdBy],
    references: [users.id],
  }),
}));

export const aiAuditLogsRelations = relations(aiAuditLogs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [aiAuditLogs.tenantId],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [aiAuditLogs.userId],
    references: [users.id],
  }),
}));

// Insert schemas
export const insertTenantSchema = createInsertSchema(tenants).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTeacherSchema = createInsertSchema(teachers).omit({ id: true, createdAt: true, updatedAt: true });
export const insertClassSchema = createInsertSchema(classes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertStudentSchema = createInsertSchema(students).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEnrollmentSchema = createInsertSchema(enrollments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPaymentSchema = createInsertSchema(payments).omit({ id: true, createdAt: true });
export const insertLessonLogSchema = createInsertSchema(lessonLogs).omit({ id: true, createdAt: true, updatedAt: true }).extend({
  date: z.coerce.date(), // 문자열을 자동으로 Date 객체로 변환
});
export const insertWaiterSchema = createInsertSchema(waiters).omit({ id: true, createdAt: true });
export const insertConsultationSchema = createInsertSchema(consultations)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    // JSON으로 들어오는 ISO 문자열/Date 모두 허용
    levelTestDate: z.coerce.date().optional().nullable(),
  });

// POST /api/payments 본문 검증용.
// enrollmentId가 nullable이 되었으므로, 원비/환불일 때만 필수라는 규칙을 코드로 강제한다.
// (insertPaymentSchema 자체는 .omit()을 쓰는 기존 코드가 있어 ZodObject로 남겨둔다)
export const createPaymentBodySchema = insertPaymentSchema
  .omit({ tenantId: true, createdBy: true })
  .refine(
    (d) => d.type === "지출" || d.type === "기타" || !!d.enrollmentId,
    { message: "원비/환불은 수강 등록(enrollmentId)이 필요합니다.", path: ["enrollmentId"] }
  )
  .refine(
    (d) => (d.type === "환불" || d.type === "지출" ? d.amount < 0 : d.amount > 0),
    { message: "환불·지출은 음수, 원비는 양수로 입력해야 합니다.", path: ["amount"] }
  );

export const createConsultationBodySchema = insertConsultationSchema
  .omit({ tenantId: true, createdBy: true });

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertAiAuditLogSchema = createInsertSchema(aiAuditLogs).omit({ id: true, createdAt: true });

// ─── Toss Front 통합 insert 스키마 ───────────────────────────────────────
export const insertAttendanceSchema = createInsertSchema(attendance).omit({ id: true, createdAt: true });
export const insertTossFrontDeviceSchema = createInsertSchema(tossFrontDevices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPaymentIntentSchema = createInsertSchema(paymentIntents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  expiresAt: z.coerce.date(),
});
export const insertTossPaymentTransactionSchema = createInsertSchema(tossPaymentTransactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTossWebhookEventSchema = createInsertSchema(tossWebhookEvents).omit({
  receivedAt: true,
});

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

export const createTaskBodySchema = insertTaskSchema
  .omit({ tenantId: true, createdBy: true, completedAt: true, deferCount: true })
  .extend({
    title: z.string().trim().min(1, "할 일 내용이 필요합니다.").max(200),
    dueDate: ymd,
  });

/**
 * 할 일 갱신. 완료 토글과 미루기 두 가지에만 쓴다.
 *
 * deferCount를 클라이언트가 정하지 않는다. 미루기를 누른 횟수는 서버가 세야
 * "3일 밀림"이라는 경고가 화면 조작으로 지워지지 않는다.
 */
export const updateTaskBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().nullable().optional(),
  completed: z.boolean().optional(),
  /** "하루 미루기"(퇴근전) 또는 "출근전 하기" — 둘 다 하루 뒤로 넘긴다 */
  defer: z.enum(["퇴근전", "출근전"]).optional(),
});

// Update schemas
export const updateEnrollmentSchema = z.object({
  studentId: z.string().optional(),
  classId: z.string().optional(),
  startDate: z.string().optional(), // YYYY-MM-DD 문자열로 받기
  tuition: z.number().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  endDate: z.string().optional(), // YYYY-MM-DD 문자열로 받기
  isActive: z.boolean().optional(),
});

// Types
export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Teacher = typeof teachers.$inferSelect;
export type Class = typeof classes.$inferSelect;
export type Student = typeof students.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type LessonLog = typeof lessonLogs.$inferSelect;
export type Waiter = typeof waiters.$inferSelect;
export type Consultation = typeof consultations.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskSlot = Task["slot"];
export type AiAuditLog = typeof aiAuditLogs.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type TossFrontDevice = typeof tossFrontDevices.$inferSelect;
export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type PaymentIntentStatus = PaymentIntent["status"];
export type TossPaymentTransaction = typeof tossPaymentTransactions.$inferSelect;
export type TossWebhookEvent = typeof tossWebhookEvents.$inferSelect;
export type KioskDevice = typeof kioskDevices.$inferSelect;
export type PaymentDispatch = typeof paymentDispatches.$inferSelect;
export type PaymentDispatchStatus = PaymentDispatch["status"];

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertTeacher = z.infer<typeof insertTeacherSchema>;
export type InsertClass = z.infer<typeof insertClassSchema>;
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type InsertEnrollment = z.infer<typeof insertEnrollmentSchema>;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type InsertLessonLog = z.infer<typeof insertLessonLogSchema>;
export type InsertWaiter = z.infer<typeof insertWaiterSchema>;
export type InsertConsultation = z.infer<typeof insertConsultationSchema>;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertAiAuditLog = z.infer<typeof insertAiAuditLogSchema>;
