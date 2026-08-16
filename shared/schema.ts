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

// 상담 진행 상태
export const consultationStatusEnum = pgEnum("consultation_status", ["상담문의", "대기등록", "최종등록", "보류"]);

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
  .omit({ id: true, createdAt: true, updatedAt: true });

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
