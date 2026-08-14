var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/index.ts
import express2 from "express";

// server/routes.ts
import { createServer } from "http";
import cookieParser from "cookie-parser";

// shared/schema.ts
var schema_exports = {};
__export(schema_exports, {
  classes: () => classes,
  classesRelations: () => classesRelations,
  consultationStatusEnum: () => consultationStatusEnum,
  consultations: () => consultations,
  consultationsRelations: () => consultationsRelations,
  createConsultationBodySchema: () => createConsultationBodySchema,
  createPaymentBodySchema: () => createPaymentBodySchema,
  enrollments: () => enrollments,
  enrollmentsRelations: () => enrollmentsRelations,
  insertClassSchema: () => insertClassSchema,
  insertConsultationSchema: () => insertConsultationSchema,
  insertEnrollmentSchema: () => insertEnrollmentSchema,
  insertLessonLogSchema: () => insertLessonLogSchema,
  insertPaymentSchema: () => insertPaymentSchema,
  insertStudentSchema: () => insertStudentSchema,
  insertTeacherSchema: () => insertTeacherSchema,
  insertTenantSchema: () => insertTenantSchema,
  insertUserSchema: () => insertUserSchema,
  insertWaiterSchema: () => insertWaiterSchema,
  lessonLogs: () => lessonLogs,
  lessonLogsRelations: () => lessonLogsRelations,
  paymentMethodEnum: () => paymentMethodEnum,
  paymentStatusEnum: () => paymentStatusEnum,
  paymentTypeEnum: () => paymentTypeEnum,
  payments: () => payments,
  paymentsRelations: () => paymentsRelations,
  students: () => students,
  studentsRelations: () => studentsRelations,
  teachers: () => teachers,
  teachersRelations: () => teachersRelations,
  tenantStatusEnum: () => tenantStatusEnum,
  tenants: () => tenants,
  tenantsRelations: () => tenantsRelations,
  updateEnrollmentSchema: () => updateEnrollmentSchema,
  userRoleEnum: () => userRoleEnum,
  users: () => users,
  usersRelations: () => usersRelations,
  waiters: () => waiters,
  waitersRelations: () => waitersRelations
});
import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
var userRoleEnum = pgEnum("user_role", ["owner", "teacher", "superadmin"]);
var tenantStatusEnum = pgEnum("tenant_status", ["pending", "active", "expired", "suspended"]);
var paymentStatusEnum = pgEnum("payment_status", ["paid", "overdue", "pending"]);
var paymentMethodEnum = pgEnum("payment_method", ["\uACC4\uC88C\uC774\uCCB4", "\uCE74\uB4DC", "\uD604\uAE08"]);
var paymentTypeEnum = pgEnum("payment_type", ["\uC6D0\uBE44", "\uD658\uBD88", "\uC9C0\uCD9C", "\uAE30\uD0C0"]);
var consultationStatusEnum = pgEnum("consultation_status", ["\uC0C1\uB2F4\uBB38\uC758", "\uB300\uAE30\uB4F1\uB85D", "\uCD5C\uC885\uB4F1\uB85D", "\uBCF4\uB958"]);
var tenants = pgTable("tenants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountNumber: varchar("account_number").notNull().unique(),
  name: text("name").notNull(),
  // 학원명
  ownerName: text("owner_name").notNull(),
  // 대표자명
  ownerPhone: text("owner_phone").notNull(),
  // 대표자 연락처
  status: tenantStatusEnum("status").default("pending").notNull(),
  activeUntil: timestamp("active_until"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var teachers = pgTable("teachers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  // 담당 과목
  phone: text("phone"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var classes = pgTable("classes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  teacherId: varchar("teacher_id").references(() => teachers.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  // 반 이름
  subject: text("subject").notNull(),
  // 과목
  schedule: text("schedule").notNull(),
  // 수업 일정 (월수금, 화목토, 주말 등)
  defaultTuition: integer("default_tuition").notNull(),
  // 기본 수강료
  maxStudents: integer("max_students").default(20),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var students = pgTable("students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  school: text("school"),
  grade: text("grade"),
  // "중1", "고2" 등
  gender: text("gender"),
  // "남", "여"
  parentPhone: text("parent_phone"),
  siblingGroup: text("sibling_group"),
  // 형제 그룹 (같은 보호자)
  notes: text("notes"),
  // 특이사항
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var enrollments = pgTable("enrollments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  tuition: integer("tuition"),
  // 개별 수강료 (없으면 반의 기본 수강료 사용)
  dueDay: integer("due_day").default(8),
  // 납입 기준일
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var payments = pgTable("payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 원비/환불은 수강 등록에 연결되지만, 학원 운영 지출은 연결할 등록이 없으므로 nullable.
  enrollmentId: varchar("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }),
  // ⚠️ 부호 규칙: 원비는 양수, 환불·지출은 음수로 저장한다.
  // Payments 화면이 amount를 단순 SUM 하므로, 이렇게 해야 합계가 자동으로 순액이 된다.
  amount: integer("amount").notNull(),
  type: paymentTypeEnum("type").default("\uC6D0\uBE44").notNull(),
  method: paymentMethodEnum("method"),
  // 계좌이체/카드/현금 (모르면 null)
  paymentMonth: text("payment_month").notNull(),
  // YYYY-MM 형식
  paidDate: timestamp("paid_date").notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  notes: text("notes"),
  // 자연어 입력으로 생성된 건지 표시 (원본 문장 보관 → 나중에 오분류 추적용)
  sourceText: text("source_text"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var consultations = pgTable("consultations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  phone: text("phone").notNull(),
  guardianName: text("guardian_name"),
  // 보호자명
  studentName: text("student_name"),
  studentGrade: text("student_grade"),
  // "중1", "고2" 등
  status: consultationStatusEnum("status").default("\uC0C1\uB2F4\uBB38\uC758").notNull(),
  subject: text("subject"),
  // 문의 과목
  followUp: text("follow_up"),
  // 후속 조치 (예: "다음주 화요일 재통화")
  memo: text("memo"),
  // 최종등록으로 전환되면 아래 두 필드가 채워진다
  classId: varchar("class_id").references(() => classes.id, { onDelete: "set null" }),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "set null" }),
  sourceText: text("source_text"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var lessonLogs = pgTable("lesson_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  date: timestamp("date").notNull(),
  progress: text("progress"),
  // 진도
  homework: text("homework"),
  // 숙제
  notes: text("notes"),
  // 특이사항
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var waiters = pgTable("waiters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull()
});
var tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  teachers: many(teachers),
  classes: many(classes),
  students: many(students)
}));
var usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id]
  }),
  teacher: one(teachers),
  payments: many(payments),
  lessonLogs: many(lessonLogs)
}));
var teachersRelations = relations(teachers, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [teachers.tenantId],
    references: [tenants.id]
  }),
  user: one(users, {
    fields: [teachers.userId],
    references: [users.id]
  }),
  classes: many(classes)
}));
var classesRelations = relations(classes, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [classes.tenantId],
    references: [tenants.id]
  }),
  teacher: one(teachers, {
    fields: [classes.teacherId],
    references: [teachers.id]
  }),
  enrollments: many(enrollments),
  lessonLogs: many(lessonLogs),
  waiters: many(waiters)
}));
var studentsRelations = relations(students, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [students.tenantId],
    references: [tenants.id]
  }),
  enrollments: many(enrollments)
}));
var enrollmentsRelations = relations(enrollments, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [enrollments.tenantId],
    references: [tenants.id]
  }),
  student: one(students, {
    fields: [enrollments.studentId],
    references: [students.id]
  }),
  class: one(classes, {
    fields: [enrollments.classId],
    references: [classes.id]
  }),
  payments: many(payments)
}));
var paymentsRelations = relations(payments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [payments.tenantId],
    references: [tenants.id]
  }),
  enrollment: one(enrollments, {
    fields: [payments.enrollmentId],
    references: [enrollments.id]
  }),
  createdBy: one(users, {
    fields: [payments.createdBy],
    references: [users.id]
  })
}));
var lessonLogsRelations = relations(lessonLogs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [lessonLogs.tenantId],
    references: [tenants.id]
  }),
  class: one(classes, {
    fields: [lessonLogs.classId],
    references: [classes.id]
  }),
  createdBy: one(users, {
    fields: [lessonLogs.createdBy],
    references: [users.id]
  })
}));
var consultationsRelations = relations(consultations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [consultations.tenantId],
    references: [tenants.id]
  }),
  class: one(classes, {
    fields: [consultations.classId],
    references: [classes.id]
  }),
  student: one(students, {
    fields: [consultations.studentId],
    references: [students.id]
  }),
  createdBy: one(users, {
    fields: [consultations.createdBy],
    references: [users.id]
  })
}));
var waitersRelations = relations(waiters, ({ one }) => ({
  tenant: one(tenants, {
    fields: [waiters.tenantId],
    references: [tenants.id]
  }),
  class: one(classes, {
    fields: [waiters.classId],
    references: [classes.id]
  })
}));
var insertTenantSchema = createInsertSchema(tenants).omit({ id: true, createdAt: true, updatedAt: true });
var insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
var insertTeacherSchema = createInsertSchema(teachers).omit({ id: true, createdAt: true, updatedAt: true });
var insertClassSchema = createInsertSchema(classes).omit({ id: true, createdAt: true, updatedAt: true });
var insertStudentSchema = createInsertSchema(students).omit({ id: true, createdAt: true, updatedAt: true });
var insertEnrollmentSchema = createInsertSchema(enrollments).omit({ id: true, createdAt: true, updatedAt: true });
var insertPaymentSchema = createInsertSchema(payments).omit({ id: true, createdAt: true });
var insertLessonLogSchema = createInsertSchema(lessonLogs).omit({ id: true, createdAt: true, updatedAt: true }).extend({
  date: z.coerce.date()
  // 문자열을 자동으로 Date 객체로 변환
});
var insertWaiterSchema = createInsertSchema(waiters).omit({ id: true, createdAt: true });
var insertConsultationSchema = createInsertSchema(consultations).omit({ id: true, createdAt: true, updatedAt: true });
var createPaymentBodySchema = insertPaymentSchema.omit({ tenantId: true, createdBy: true }).refine(
  (d) => d.type === "\uC9C0\uCD9C" || d.type === "\uAE30\uD0C0" || !!d.enrollmentId,
  { message: "\uC6D0\uBE44/\uD658\uBD88\uC740 \uC218\uAC15 \uB4F1\uB85D(enrollmentId)\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.", path: ["enrollmentId"] }
).refine(
  (d) => d.type === "\uD658\uBD88" || d.type === "\uC9C0\uCD9C" ? d.amount < 0 : d.amount > 0,
  { message: "\uD658\uBD88\xB7\uC9C0\uCD9C\uC740 \uC74C\uC218, \uC6D0\uBE44\uB294 \uC591\uC218\uB85C \uC785\uB825\uD574\uC57C \uD569\uB2C8\uB2E4.", path: ["amount"] }
);
var createConsultationBodySchema = insertConsultationSchema.omit({ tenantId: true, createdBy: true });
var updateEnrollmentSchema = z.object({
  studentId: z.string().optional(),
  classId: z.string().optional(),
  startDate: z.string().optional(),
  // YYYY-MM-DD 문자열로 받기
  tuition: z.number().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  endDate: z.string().optional(),
  // YYYY-MM-DD 문자열로 받기
  isActive: z.boolean().optional()
});

// server/storage.ts
import { eq, and, sql as sql2, desc, gt } from "drizzle-orm";
import { randomUUID } from "crypto";

// server/db.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
if (!process.env.DATABASE_URL) {
  console.error(
    "\u274C DATABASE_URL is not set! DB queries will fail. Set DATABASE_URL in Railway \u2192 Variables."
  );
}
var { Pool } = pg;
var pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://localhost/placeholder_will_fail",
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  // 연결 안정성 설정
  max: 10,
  // 최대 연결 수
  idleTimeoutMillis: 3e4,
  // 30초 idle 후 연결 종료
  connectionTimeoutMillis: 1e4
  // 10초 연결 타임아웃
});
pool.on("error", (err) => {
  console.error("\u274C DB pool unexpected error (connection will be retried):", err.message);
});
var db = drizzle(pool, { schema: schema_exports });
if (process.env.DATABASE_URL) {
  pool.query("SELECT 1").then(() => console.log("\u2705 Database connection verified")).catch((err) => {
    console.error("\u274C Database connection test FAILED:", err.message);
    console.error("   \u2192 Check DATABASE_URL in Railway Variables and ensure the DB allows Railway connections.");
  });
}

// server/storage.ts
var DbStorage = class {
  // User methods
  async getUser(id) {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }
  async getUserByEmail(email) {
    const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return result[0];
  }
  async createUser(insertUser) {
    const result = await db.insert(users).values({
      ...insertUser,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  // Tenant methods
  async getTenant(id) {
    const result = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return result[0];
  }
  async createTenant(insertTenant) {
    const accountNumber = `AC${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    const result = await db.insert(tenants).values({
      ...insertTenant,
      id: randomUUID(),
      accountNumber,
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async getAllTenants() {
    const result = await db.select().from(tenants);
    return result;
  }
  async updateTenantStatus(id, status) {
    const result = await db.update(tenants).set({
      status,
      updatedAt: /* @__PURE__ */ new Date(),
      activeUntil: status === "active" ? sql2`NOW() + INTERVAL '1 year'` : null
    }).where(eq(tenants.id, id)).returning();
    return result[0];
  }
  async deleteTenant(id) {
    await db.delete(lessonLogs).where(eq(lessonLogs.tenantId, id));
    await db.delete(payments).where(eq(payments.tenantId, id));
    await db.delete(enrollments).where(eq(enrollments.tenantId, id));
    await db.delete(waiters).where(eq(waiters.tenantId, id));
    await db.delete(classes).where(eq(classes.tenantId, id));
    await db.delete(students).where(eq(students.tenantId, id));
    await db.delete(teachers).where(eq(teachers.tenantId, id));
    await db.delete(users).where(eq(users.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
  // Student methods
  async getStudentsByTenant(tenantId) {
    return await db.select().from(students).where(eq(students.tenantId, tenantId));
  }
  async getDashboardStudents(tenantId) {
    const currentMonth = (/* @__PURE__ */ new Date()).toISOString().slice(0, 7);
    const result = await db.select({
      id: students.id,
      tenantId: students.tenantId,
      name: students.name,
      school: students.school,
      grade: students.grade,
      gender: students.gender,
      parentPhone: students.parentPhone,
      siblingGroup: students.siblingGroup,
      notes: students.notes,
      isActive: students.isActive,
      createdAt: students.createdAt,
      updatedAt: students.updatedAt,
      // enrollment 정보
      enrollmentId: enrollments.id,
      classId: enrollments.classId,
      tuition: enrollments.tuition,
      dueDay: enrollments.dueDay,
      startDate: enrollments.startDate,
      enrollmentIsActive: enrollments.isActive,
      // class 정보
      className: classes.name,
      classSubject: classes.subject,
      defaultTuition: classes.defaultTuition,
      // 이번 달 납부 여부
      hasCurrentPayment: payments.id
    }).from(students).leftJoin(enrollments, and(
      eq(enrollments.studentId, students.id),
      eq(enrollments.isActive, true)
    )).leftJoin(classes, eq(classes.id, enrollments.classId)).leftJoin(payments, and(
      eq(payments.enrollmentId, enrollments.id),
      eq(payments.paymentMonth, currentMonth),
      // 환불(음수)·지출은 납부 실적이 아니므로 제외한다
      gt(payments.amount, 0)
    )).where(and(
      eq(students.tenantId, tenantId),
      eq(students.isActive, true)
    )).orderBy(
      // 미납자를 우선으로 (hasCurrentPayment가 null인 경우가 먼저)
      sql2`CASE WHEN ${payments.id} IS NULL THEN 0 ELSE 1 END`,
      // 그 다음은 최신 등록순
      desc(students.createdAt)
    ).limit(6);
    const studentMap = /* @__PURE__ */ new Map();
    for (const row of result) {
      if (!studentMap.has(row.id)) {
        studentMap.set(row.id, {
          // 기본 학생 정보
          id: row.id,
          name: row.name,
          school: row.school || "\uBBF8\uC124\uC815",
          grade: row.grade || "\uBBF8\uC124\uC815",
          parentPhone: row.parentPhone || "\uBBF8\uC124\uC815",
          // 반 정보 (수강시작일 없어도 수업배정되면 배정으로 표시)
          className: row.enrollmentId ? row.className || "\uBC30\uC815" : "\uBBF8\uBC30\uC815",
          // 등록/납부 정보
          dueDay: row.dueDay || 8,
          tuition: row.tuition || row.defaultTuition || 0,
          paymentStatus: row.hasCurrentPayment ? "paid" : row.enrollmentId ? "overdue" : "pending",
          // 디버깅 정보
          enrollmentId: row.enrollmentId,
          hasCurrentPayment: !!row.hasCurrentPayment
        });
      }
    }
    return Array.from(studentMap.values());
  }
  async getStudent(id) {
    const result = await db.select().from(students).where(eq(students.id, id)).limit(1);
    return result[0];
  }
  async createStudent(insertStudent) {
    const result = await db.insert(students).values({
      ...insertStudent,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async updateStudent(id, updateData) {
    const result = await db.update(students).set({ ...updateData, updatedAt: /* @__PURE__ */ new Date() }).where(eq(students.id, id)).returning();
    return result[0];
  }
  async deleteStudent(id) {
    try {
      const studentEnrollments = await db.select({ id: enrollments.id }).from(enrollments).where(eq(enrollments.studentId, id));
      for (const enrollment of studentEnrollments) {
        await db.delete(payments).where(eq(payments.enrollmentId, enrollment.id));
      }
      await db.delete(enrollments).where(eq(enrollments.studentId, id));
      await db.delete(students).where(eq(students.id, id));
    } catch (error) {
      console.error("Error deleting student:", error);
      throw new Error("\uD559\uC0DD \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.");
    }
  }
  async deactivateStudent(id) {
    await db.update(students).set({ isActive: false, updatedAt: /* @__PURE__ */ new Date() }).where(eq(students.id, id));
  }
  async activateStudent(id) {
    await db.update(students).set({ isActive: true, updatedAt: /* @__PURE__ */ new Date() }).where(eq(students.id, id));
  }
  // Teacher methods
  async getTeachersByTenant(tenantId) {
    return await db.select().from(teachers).where(eq(teachers.tenantId, tenantId));
  }
  async getTeacher(id) {
    const result = await db.select().from(teachers).where(eq(teachers.id, id)).limit(1);
    return result[0];
  }
  async getTeacherByUserId(userId) {
    const result = await db.select().from(teachers).where(eq(teachers.userId, userId)).limit(1);
    return result[0];
  }
  async deleteUser(id) {
    await db.delete(users).where(eq(users.id, id));
  }
  async createTeacher(insertTeacher) {
    const result = await db.insert(teachers).values({
      ...insertTeacher,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async updateTeacher(id, updateData) {
    const result = await db.update(teachers).set({ ...updateData, updatedAt: /* @__PURE__ */ new Date() }).where(eq(teachers.id, id)).returning();
    return result[0];
  }
  async deleteTeacher(id) {
    const teacher = await this.getTeacher(id);
    if (teacher && !teacher.isActive) {
      await db.delete(teachers).where(eq(teachers.id, id));
    } else {
      await db.update(teachers).set({ isActive: false, updatedAt: /* @__PURE__ */ new Date() }).where(eq(teachers.id, id));
    }
  }
  // Class methods
  async getClassesByTenant(tenantId) {
    return await db.select().from(classes).where(eq(classes.tenantId, tenantId));
  }
  async getClass(id) {
    const result = await db.select().from(classes).where(eq(classes.id, id)).limit(1);
    return result[0];
  }
  async createClass(insertClass) {
    const result = await db.insert(classes).values({
      ...insertClass,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async updateClass(id, updateData) {
    const result = await db.update(classes).set({ ...updateData, updatedAt: /* @__PURE__ */ new Date() }).where(eq(classes.id, id)).returning();
    return result[0];
  }
  async deleteClass(id) {
    const classItem = await this.getClass(id);
    if (classItem && !classItem.isActive) {
      await db.delete(classes).where(eq(classes.id, id));
    } else {
      await db.update(classes).set({ isActive: false, updatedAt: /* @__PURE__ */ new Date() }).where(eq(classes.id, id));
    }
  }
  // Enrollment methods
  async getEnrollmentsByStudent(studentId) {
    return await db.select().from(enrollments).where(eq(enrollments.studentId, studentId));
  }
  async getEnrollmentsByTenant(tenantId) {
    return await db.select().from(enrollments).where(eq(enrollments.tenantId, tenantId));
  }
  async createEnrollment(insertEnrollment) {
    const result = await db.insert(enrollments).values({
      ...insertEnrollment,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async updateEnrollment(id, updateData) {
    const result = await db.update(enrollments).set({ ...updateData, updatedAt: /* @__PURE__ */ new Date() }).where(eq(enrollments.id, id)).returning();
    return result[0];
  }
  async deleteEnrollment(id) {
    await db.update(enrollments).set({ isActive: false, updatedAt: /* @__PURE__ */ new Date() }).where(eq(enrollments.id, id));
  }
  // Enrollment methods (additional)
  async getEnrollment(id) {
    const result = await db.select().from(enrollments).where(eq(enrollments.id, id)).limit(1);
    return result[0];
  }
  // Payment methods
  async getPaymentsByEnrollment(enrollmentId) {
    return await db.select().from(payments).where(eq(payments.enrollmentId, enrollmentId));
  }
  async getPaymentsByTenant(tenantId) {
    return await db.select().from(payments).where(eq(payments.tenantId, tenantId));
  }
  async createPayment(insertPayment) {
    const result = await db.insert(payments).values({
      ...insertPayment,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  // Lesson Log methods
  async getLessonLogsByTenant(tenantId) {
    return await db.select().from(lessonLogs).where(eq(lessonLogs.tenantId, tenantId));
  }
  async getLessonLogsByClass(classId) {
    return await db.select().from(lessonLogs).where(eq(lessonLogs.classId, classId));
  }
  async createLessonLog(insertLessonLog) {
    const result = await db.insert(lessonLogs).values({
      ...insertLessonLog,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async deleteLessonLog(id) {
    await db.delete(lessonLogs).where(eq(lessonLogs.id, id));
  }
  // Waiter methods
  async getWaitersByTenant(tenantId) {
    return await db.select().from(waiters).where(eq(waiters.tenantId, tenantId));
  }
  async getWaitersByClass(classId) {
    return await db.select().from(waiters).where(eq(waiters.classId, classId));
  }
  async getWaiter(id) {
    const result = await db.select().from(waiters).where(eq(waiters.id, id)).limit(1);
    return result[0];
  }
  async createWaiter(insertWaiter) {
    const result = await db.insert(waiters).values({
      ...insertWaiter,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async deleteWaiter(id) {
    await db.delete(waiters).where(eq(waiters.id, id));
  }
  // Consultation methods
  async getConsultationsByTenant(tenantId) {
    return await db.select().from(consultations).where(eq(consultations.tenantId, tenantId)).orderBy(desc(consultations.createdAt));
  }
  async getConsultation(id) {
    const result = await db.select().from(consultations).where(eq(consultations.id, id)).limit(1);
    return result[0];
  }
  async createConsultation(insert) {
    const result = await db.insert(consultations).values({
      ...insert,
      id: randomUUID(),
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    }).returning();
    return result[0];
  }
  async updateConsultation(id, patch) {
    const result = await db.update(consultations).set({ ...patch, updatedAt: /* @__PURE__ */ new Date() }).where(eq(consultations.id, id)).returning();
    return result[0];
  }
  async deleteConsultation(id) {
    await db.delete(consultations).where(eq(consultations.id, id));
  }
  // 자연어 입력 지원 — 이름으로 학생 찾기
  /**
   * 이름이 정확히 일치하는 활성 학생을 찾는다.
   * 동명이인이 있을 수 있으므로 배열을 반환하고, 판단은 호출자(=원장 확인 UI)에 맡긴다.
   */
  async findStudentsByName(tenantId, name) {
    return await db.select().from(students).where(and(
      eq(students.tenantId, tenantId),
      eq(students.name, name),
      eq(students.isActive, true)
    ));
  }
  /**
   * 학생의 활성 수강 등록 목록을 반 정보와 함께 반환한다.
   * 자연어 수납 입력에서 enrollmentId를 확정하기 위해 쓰인다.
   * 학생이 두 반을 들으면 결과가 2건이 되고, 그때는 원장이 직접 골라야 한다.
   */
  async getActiveEnrollmentsWithClass(tenantId, studentId) {
    const rows = await db.select({
      enrollment: enrollments,
      className: classes.name,
      classSubject: classes.subject,
      defaultTuition: classes.defaultTuition
    }).from(enrollments).innerJoin(classes, eq(enrollments.classId, classes.id)).where(and(
      eq(enrollments.tenantId, tenantId),
      eq(enrollments.studentId, studentId),
      eq(enrollments.isActive, true)
    ));
    return rows.map((r) => ({
      ...r.enrollment,
      className: r.className,
      classSubject: r.classSubject,
      defaultTuition: r.defaultTuition
    }));
  }
};
var storage = new DbStorage();

// server/middleware/auth.ts
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
var JWT_SECRET = process.env.JWT_SECRET || "INSECURE_DEFAULT_CHANGE_IN_RAILWAY_VARIABLES";
if (!process.env.JWT_SECRET) {
  console.warn("\u26A0\uFE0F  JWT_SECRET not set! Using insecure default \u2014 set JWT_SECRET in Railway Variables NOW!");
}
var generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
};
var hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};
var verifyPassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};
var authGuard = async (req, res, next) => {
  try {
    const token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      console.log("\u{1F512} AuthGuard: no token found (cookies:", Object.keys(req.cookies || {}), ")");
      return res.status(401).json({ error: "\uC778\uC99D \uD1A0\uD070\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
    }
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtErr) {
      console.warn("\u{1F512} AuthGuard: JWT verify failed:", jwtErr.message);
      return res.status(401).json({ error: "\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uD1A0\uD070\uC785\uB2C8\uB2E4." });
    }
    console.log("\u{1F512} AuthGuard: user", { id: decoded.id, role: decoded.role, email: decoded.email });
    if (decoded.role === "superadmin" && decoded.id === "admin") {
      console.log("\u{1F512} AuthGuard: Superadmin \u2014 bypassing DB check");
      req.user = {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name,
        role: decoded.role,
        tenantId: decoded.tenantId
      };
      return next();
    }
    const user = await storage.getUser(decoded.id);
    if (!user) {
      console.warn(`\u{1F512} AuthGuard: user ${decoded.id} not found in DB`);
      return res.status(401).json({ error: "\uC0AC\uC6A9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
    }
    if (!user.isActive) {
      console.warn(`\u{1F512} AuthGuard: user ${decoded.id} is inactive`);
      return res.status(401).json({ error: "\uBE44\uD65C\uC131\uD654\uB41C \uACC4\uC815\uC785\uB2C8\uB2E4." });
    }
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId
    };
    next();
  } catch (error) {
    console.error("\u{1F512} AuthGuard unexpected error:", error);
    return res.status(500).json({ error: "\uC778\uC99D \uCC98\uB9AC \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
  }
};
var tenantGuard = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "\uC778\uC99D\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
  }
  if (req.user.role === "superadmin") {
    return next();
  }
  if (!req.user.tenantId) {
    return res.status(403).json({ error: "\uD14C\uB10C\uD2B8\uAC00 \uD560\uB2F9\uB418\uC9C0 \uC54A\uC740 \uC0AC\uC6A9\uC790\uC785\uB2C8\uB2E4." });
  }
  next();
};
var roleGuard = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "\uC778\uC99D\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "\uAD8C\uD55C\uC774 \uBD80\uC871\uD569\uB2C8\uB2E4." });
    }
    next();
  };
};

// server/lib/nlpNormalize.ts
var PHONE_RE = /(?<!\d)(0\d{1,2})[-.\s]?(\d{3,4})[-.\s]?(\d{4})(?!\d)/g;
function extractPhones(text2) {
  const out = [];
  const re = new RegExp(PHONE_RE.source, "g");
  let m;
  while ((m = re.exec(text2)) !== null) {
    const normalized = `${m[1]}-${m[2]}-${m[3]}`;
    if (out.indexOf(normalized) === -1) out.push(normalized);
  }
  return out;
}
function normalizePhone(raw) {
  if (!raw) return null;
  const found = extractPhones(raw);
  return found[0] ?? raw.trim() ?? null;
}
var UNIT_VALUE = {
  \uC5B5: 1e8,
  \uCC9C\uB9CC: 1e7,
  \uBC31\uB9CC: 1e6,
  \uC2ED\uB9CC: 1e5,
  \uB9CC: 1e4,
  \uCC9C: 1e3,
  \uBC31: 100,
  \uC2ED: 10
};
var UNIT_PATTERN = "\uC5B5|\uCC9C\uB9CC|\uBC31\uB9CC|\uC2ED\uB9CC|\uB9CC|\uCC9C|\uBC31|\uC2ED";
function extractAmounts(text2) {
  const amounts = [];
  const TOKEN_RE = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})?\\s*(\uC6D0)?`, "g");
  let running = 0;
  let sawUnit = false;
  let lastUnitValue = Infinity;
  let lastEnd = -1;
  const flush = () => {
    if (running > 0) amounts.push(Math.round(running));
    running = 0;
    sawUnit = false;
    lastUnitValue = Infinity;
  };
  let m;
  while ((m = TOKEN_RE.exec(text2)) !== null) {
    const full = m[0];
    const numRaw = m[1];
    const unit = m[2];
    const won = m[3];
    const start = m.index;
    if (full === "") {
      TOKEN_RE.lastIndex++;
      continue;
    }
    const contiguous = lastEnd >= 0 && /^[\s]*$/.test(text2.slice(lastEnd, start));
    if (!contiguous) flush();
    const value = parseFloat(numRaw.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      lastEnd = start + full.length;
      continue;
    }
    if (unit) {
      const unitValue = UNIT_VALUE[unit];
      if (sawUnit && unitValue >= lastUnitValue) flush();
      running += value * unitValue;
      sawUnit = true;
      lastUnitValue = unitValue;
    } else if (sawUnit) {
      running += value;
    } else {
      running += value;
    }
    lastEnd = start + full.length;
    if (won) flush();
  }
  flush();
  return amounts.filter((a) => a > 0);
}
var AMOUNT_MIN = 1e3;
var AMOUNT_MAX = 1e7;
function isPlausibleAmount(amount) {
  return Number.isInteger(amount) && Math.abs(amount) >= AMOUNT_MIN && Math.abs(amount) <= AMOUNT_MAX;
}
function ym(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function shiftMonth(base, delta) {
  return new Date(base.getFullYear(), base.getMonth() + delta, 1);
}
function normalizeMonth(raw, text2, now = /* @__PURE__ */ new Date()) {
  const candidates = [raw ?? "", text2];
  for (const src of candidates) {
    if (!src) continue;
    const iso = src.match(/(20\d{2})[-./](0?[1-9]|1[0-2])(?!\d)/);
    if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}`;
    if (/이번\s*달|이달|당월|금월/.test(src)) return ym(now);
    if (/지난\s*달|저번\s*달|전월|지난달/.test(src)) return ym(shiftMonth(now, -1));
    if (/다음\s*달|담달|익월|내달/.test(src)) return ym(shiftMonth(now, 1));
    const monthOnly = src.match(/(1[0-2]|[1-9])\s*월/);
    if (monthOnly) {
      const mm = Number(monthOnly[1]);
      let year = now.getFullYear();
      const diff = mm - (now.getMonth() + 1);
      if (diff <= -6) year += 1;
      if (diff >= 7) year -= 1;
      return `${year}-${String(mm).padStart(2, "0")}`;
    }
  }
  return null;
}
function extractDueDay(text2) {
  const patterns = [
    /(?:납부|납입|수납)?\s*기준일\s*(?:은|는|:)?\s*(?:매\s*월\s*)?(\d{1,2})\s*일?/,
    /매\s*월\s*(\d{1,2})\s*일/,
    /(\d{1,2})\s*일\s*기준/,
    /(?:납부|납입|수납)일\s*(?:은|는|:)?\s*(\d{1,2})\s*일?/
  ];
  for (const re of patterns) {
    const m = text2.match(re);
    if (!m) continue;
    const day = Number(m[1]);
    if (Number.isInteger(day) && day >= 1 && day <= 31) return day;
  }
  return null;
}
function inferYear(month, now) {
  const diff = month - (now.getMonth() + 1);
  if (diff <= -6) return now.getFullYear() + 1;
  if (diff >= 7) return now.getFullYear() - 1;
  return now.getFullYear();
}
function toIsoDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function extractStartDate(text2, now = /* @__PURE__ */ new Date()) {
  const iso = text2.match(/(20\d{2})[-./](0?[1-9]|1[0-2])[-./](0?[1-9]|[12]\d|3[01])(?!\d)/);
  if (iso) {
    const hit = toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (hit) return hit;
  }
  const korean = text2.match(/(1[0-2]|[1-9])\s*월\s*(0?[1-9]|[12]\d|3[01])\s*일/);
  if (korean) {
    const month = Number(korean[1]);
    const hit = toIsoDate(inferYear(month, now), month, Number(korean[2]));
    if (hit) return hit;
  }
  const slash = text2.match(/(?<![\d/])(1[0-2]|[1-9])\/(0?[1-9]|[12]\d|3[01])(?![\d/])/);
  if (slash) {
    const month = Number(slash[1]);
    const hit = toIsoDate(inferYear(month, now), month, Number(slash[2]));
    if (hit) return hit;
  }
  return null;
}
function extractConsultationStatus(text2) {
  if (/보류|철회|거절|등록\s*취소|안\s*하기로|그만/.test(text2)) return "\uBCF4\uB958";
  if (/최종\s*등록|신규\s*등록|정식\s*등록|등록\s*생|등록\s*완료|등록\s*했|등록\s*함|등록\s*시켜|등록\s*시켰|등록\s*처리|등록\s*확정/.test(
    text2
  )) {
    return "\uCD5C\uC885\uB4F1\uB85D";
  }
  if (/대기(?!\s*중이지)|웨이팅|웨이트|자리\s*나면/.test(text2)) return "\uB300\uAE30\uB4F1\uB85D";
  if (/문의|상담|알아보|물어/.test(text2)) return "\uC0C1\uB2F4\uBB38\uC758";
  if (/등록|입반|반\s*(?:에|으로)?\s*(?:넣|배정|편성|올려)|들어오기로|다니기로|시작하기로/.test(text2)) {
    return "\uCD5C\uC885\uB4F1\uB85D";
  }
  return null;
}
function extractPaymentType(text2) {
  if (/환불|환급|반환|돌려\s*(주|줌|드림|드렸)|결제\s*취소|취소\s*환/.test(text2)) return "\uD658\uBD88";
  if (/지출|매입|구입|구매|수리|임대료|월세|공과금|급여|인건비|비품|운영비/.test(text2)) return "\uC9C0\uCD9C";
  if (/원비|수강료|학원비|교습비|수납|결제|납부|입금|완납|선납/.test(text2)) return "\uC6D0\uBE44";
  return null;
}
function extractPaymentMethod(text2) {
  if (/계좌\s*이체|이체|무통장|송금|입금\s*받/.test(text2)) return "\uACC4\uC88C\uC774\uCCB4";
  if (/카드|신용\s*카드|체크\s*카드/.test(text2)) return "\uCE74\uB4DC";
  if (/현금/.test(text2)) return "\uD604\uAE08";
  return null;
}
function matchClassName(text2, classes2) {
  const normalized = text2.replace(/\s+/g, "");
  const sorted = [...classes2].sort((a, b) => b.name.length - a.name.length);
  const hits = sorted.filter((c) => {
    const name = c.name.replace(/\s+/g, "");
    return name.length >= 2 && normalized.includes(name);
  });
  if (hits.length === 0) return null;
  const best = hits[0].name.replace(/\s+/g, "");
  const ambiguous = hits.some((c) => !best.includes(c.name.replace(/\s+/g, "")));
  return ambiguous ? null : hits[0];
}
function cleanStudentName(raw) {
  if (!raw) return null;
  let name = raw.trim().replace(/\s+/g, "");
  name = name.replace(/(학생|어머니|아버지|님|씨)$/, "");
  name = name.replace(/(이가|이는|이랑|이|가|은|는|의|도)$/, "");
  if (!/^[가-힣a-zA-Z]{2,5}$/.test(name)) return null;
  return name;
}

// server/lib/nlpParser.ts
var OPENAI_URL = "https://api.openai.com/v1/chat/completions";
var MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
var SYSTEM_PROMPT = `\uB2F9\uC2E0\uC740 \uD55C\uAD6D \uC601\uC5B4\uD559\uC6D0 \uAD00\uB9AC \uC2DC\uC2A4\uD15C\uC758 \uC790\uC5F0\uC5B4 \uC785\uB825 \uBD84\uC11D\uAE30\uC785\uB2C8\uB2E4.
\uC6D0\uC7A5\uC774 \uD55C \uC904\uB85C \uC785\uB825\uD55C \uBB38\uC7A5\uC5D0\uC11C \uC815\uBCF4\uB97C \uCD94\uCD9C\uD574 JSON\uC73C\uB85C\uB9CC \uC751\uB2F5\uD558\uC138\uC694.

[\uBD84\uB958 \uADDC\uCE59 \u2014 \uC6B0\uC120\uC21C\uC704 \uC21C]
1. \uC804\uD654\uBC88\uD638\uAC00 \uD558\uB098\uB77C\uB3C4 \uC5B8\uAE09\uB418\uBA74 category="contact"
2. \uC804\uD654\uBC88\uD638\uAC00 \uC5C6\uACE0 \uAE08\uC561\uC774 \uC5B8\uAE09\uB418\uBA74 category="accounting"
3. \uB458 \uB2E4 \uC5C6\uAC70\uB098 \uD310\uB2E8\uC774 \uC5B4\uB824\uC6B0\uBA74 category="unclear" (\uC5B5\uC9C0\uB85C \uCD94\uCE21\uD558\uC9C0 \uB9D0 \uAC83)

[\uC911\uC694]
- "\uB9CC\uC6D0"\uC740 10000\uC744 \uACF1\uD574 \uC22B\uC790\uB85C \uD658\uC0B0 (35\uB9CC\uC6D0 \u2192 350000)
- amount\uB294 \uD56D\uC0C1 \uC591\uC218\uB85C \uCD94\uCD9C\uD558\uC138\uC694. \uD658\uBD88/\uC9C0\uCD9C \uC5EC\uBD80\uB294 type \uD544\uB4DC\uB85C\uB9CC \uD45C\uD604\uD569\uB2C8\uB2E4.
- \uD655\uC2E4\uD558\uC9C0 \uC54A\uC740 \uD544\uB4DC\uB294 \uC808\uB300 \uCD94\uCE21\uD558\uC9C0 \uB9D0\uACE0 null\uC744 \uB123\uC73C\uC138\uC694.
- \uC774\uB984\uC774 \uBA85\uC2DC\uB418\uC9C0 \uC54A\uC558\uC73C\uBA74 student_name\uC740 null\uC785\uB2C8\uB2E4. \uD754\uD55C \uC774\uB984\uC744 \uC9C0\uC5B4\uB0B4\uC9C0 \uB9C8\uC138\uC694.
- month\uB294 \uC6D0\uBB38 \uD45C\uD604\uC744 \uADF8\uB300\uB85C \uB123\uC73C\uC138\uC694 ("\uC774\uBC88\uB2EC", "8\uC6D4", "2026-08" \uB4F1). \uACC4\uC0B0\uD558\uC9C0 \uB9C8\uC138\uC694.

[type \u2014 \uB3C8\uC774 \uB4E4\uC5B4\uC624\uB294 \uBC29\uD5A5]
- "\uACB0\uC81C", "\uC218\uB0A9", "\uB0A9\uBD80", "\uC785\uAE08", "\uC6D0\uBE44", "\uC218\uAC15\uB8CC" \u2192 "\uC6D0\uBE44" (\uD559\uC6D0\uC73C\uB85C \uB3C8\uC774 \uB4E4\uC5B4\uC634)
- "\uD658\uBD88", "\uD658\uAE09", "\uB3CC\uB824\uC90C" \u2192 "\uD658\uBD88"
- "\uC9C0\uCD9C", "\uAD6C\uC785", "\uC218\uB9AC\uBE44", "\uC6D4\uC138", "\uAE09\uC5EC" \u2192 "\uC9C0\uCD9C"
- \uACB0\uC81C \uAD00\uB828 \uB0B1\uB9D0\uC744 \uD658\uBD88\uB85C \uB4A4\uC9D1\uC9C0 \uB9C8\uC138\uC694. \uD658\uBD88\uC740 "\uD658\uBD88"\uC774\uB77C\uACE0 \uBA85\uC2DC\uB41C \uACBD\uC6B0\uC5D0\uB9CC\uC785\uB2C8\uB2E4.

[status \u2014 \uC0C1\uB2F4 \uC9C4\uD589 \uB2E8\uACC4]
- "\uB4F1\uB85D", "\uC2E0\uADDC\uB4F1\uB85D", "\uCD5C\uC885\uB4F1\uB85D", "\uB4F1\uB85D\uC0DD", "\uB4F1\uB85D\uD588\uC5B4", "\uBC18\uC5D0 \uB123\uC5B4\uC918" \u2192 "\uCD5C\uC885\uB4F1\uB85D"
- "\uB300\uAE30", "\uC790\uB9AC \uB098\uBA74" \u2192 "\uB300\uAE30\uB4F1\uB85D"
- "\uBB38\uC758", "\uC0C1\uB2F4", "\uC54C\uC544\uBD04" \u2192 "\uC0C1\uB2F4\uBB38\uC758"
- "\uBCF4\uB958", "\uCDE8\uC18C", "\uC548 \uD558\uAE30\uB85C" \u2192 "\uBCF4\uB958"

[\uC608\uC2DC]
- "010-1234-5678 \uAE40\uBBFC\uC900 \uC9112 \uC601\uC5B4 \uB4F1\uB85D, \uAE30\uC900\uC77C 13\uC77C" \u2192 contact / status="\uCD5C\uC885\uB4F1\uB85D"
- "\uAE40\uBBFC\uC900 35\uB9CC\uC6D0 \uC774\uBC88\uB2EC \uC6D0\uBE44 \uCE74\uB4DC \uACB0\uC81C" \u2192 accounting / type="\uC6D0\uBE44" / payment_method="\uCE74\uB4DC"
- "\uC774\uC9C0\uC6B0 20\uB9CC\uC6D0 \uD658\uBD88" \u2192 accounting / type="\uD658\uBD88"`;
var JSON_SCHEMA = {
  name: "hagwon_input",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "category",
      "student_name",
      "amount",
      "type",
      "month",
      "payment_method",
      "phone",
      "guardian_name",
      "student_grade",
      "status",
      "subject",
      "follow_up",
      "memo"
    ],
    properties: {
      category: { type: "string", enum: ["accounting", "contact", "unclear"] },
      student_name: { type: ["string", "null"] },
      amount: { type: ["number", "null"] },
      type: { type: ["string", "null"], enum: ["\uC6D0\uBE44", "\uD658\uBD88", "\uC9C0\uCD9C", "\uAE30\uD0C0", null] },
      month: { type: ["string", "null"] },
      payment_method: { type: ["string", "null"], enum: ["\uACC4\uC88C\uC774\uCCB4", "\uCE74\uB4DC", "\uD604\uAE08", null] },
      phone: { type: ["string", "null"] },
      guardian_name: { type: ["string", "null"] },
      student_grade: { type: ["string", "null"] },
      status: {
        type: ["string", "null"],
        enum: ["\uC0C1\uB2F4\uBB38\uC758", "\uB300\uAE30\uB4F1\uB85D", "\uCD5C\uC885\uB4F1\uB85D", "\uBCF4\uB958", null]
      },
      subject: { type: ["string", "null"] },
      follow_up: { type: ["string", "null"] },
      memo: { type: ["string", "null"] }
    }
  }
};
var NlpConfigError = class extends Error {
};
async function callOpenAi(text2, signal) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new NlpConfigError(
      "OPENAI_API_KEY\uAC00 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. Railway \uB300\uC2DC\uBCF4\uB4DC \u2192 Variables\uC5D0\uC11C \uB4F1\uB85D\uD574\uC8FC\uC138\uC694."
    );
  }
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // 같은 문장은 항상 같은 결과가 나오도록 고정
      max_tokens: 400,
      response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text2 }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI \uD638\uCD9C \uC2E4\uD328 (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI \uC751\uB2F5\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.");
  return JSON.parse(content);
}
function arbitrate(ai, sourceText, now = /* @__PURE__ */ new Date()) {
  const corrections = [];
  const phones = extractPhones(sourceText);
  const amounts = extractAmounts(sourceText);
  if (phones.length > 0) {
    if (ai.category !== "contact") {
      corrections.push(`\uC804\uD654\uBC88\uD638(${phones[0]})\uAC00 \uC788\uC5B4 \uC0C1\uB2F4/\uBB38\uC758\uB85C \uBD84\uB958\uD588\uC2B5\uB2C8\uB2E4.`);
    }
    const aiStatus = ["\uC0C1\uB2F4\uBB38\uC758", "\uB300\uAE30\uB4F1\uB85D", "\uCD5C\uC885\uB4F1\uB85D", "\uBCF4\uB958"].includes(
      ai.status
    ) ? ai.status : null;
    const statusFromText = extractConsultationStatus(sourceText);
    const status = statusFromText ?? aiStatus ?? "\uC0C1\uB2F4\uBB38\uC758";
    if (statusFromText && aiStatus && statusFromText !== aiStatus) {
      corrections.push(`\uC0C1\uD0DC\uB97C \uC6D0\uBB38 \uAE30\uC900 "${statusFromText}"\uB85C \uC815\uC815\uD588\uC2B5\uB2C8\uB2E4. (AI \uD310\uB2E8: "${aiStatus}")`);
    } else if (!statusFromText && !aiStatus) {
      corrections.push(`\uC0C1\uD0DC\uB97C \uAE30\uBCF8\uAC12 "\uC0C1\uB2F4\uBB38\uC758"\uB85C \uC124\uC815\uD588\uC2B5\uB2C8\uB2E4.`);
    }
    const dueDay = extractDueDay(sourceText);
    const startDate = extractStartDate(sourceText, now);
    if (dueDay !== null) corrections.push(`\uB0A9\uBD80 \uAE30\uC900\uC77C\uC744 \uB9E4\uC6D4 ${dueDay}\uC77C\uB85C \uC77D\uC5C8\uC2B5\uB2C8\uB2E4.`);
    if (startDate !== null) corrections.push(`\uB4F1\uB85D\uC77C\uC744 ${startDate}\uB85C \uC77D\uC5C8\uC2B5\uB2C8\uB2E4.`);
    return {
      sourceText,
      corrections,
      draft: {
        category: "contact",
        phone: normalizePhone(phones[0]),
        guardianName: ai.guardian_name?.trim() || null,
        studentName: cleanStudentName(ai.student_name),
        studentGrade: ai.student_grade?.trim() || null,
        status,
        subject: ai.subject?.trim() || null,
        followUp: ai.follow_up?.trim() || null,
        memo: ai.memo?.trim() || null,
        dueDay,
        startDate
      }
    };
  }
  if (amounts.length > 0) {
    const fromText = amounts[0];
    const fromAi = ai.amount != null ? Math.abs(ai.amount) : null;
    if (fromAi != null && fromAi !== fromText) {
      corrections.push(
        `\uAE08\uC561\uC744 \uC6D0\uBB38 \uAE30\uC900 ${fromText.toLocaleString()}\uC6D0\uC73C\uB85C \uC815\uC815\uD588\uC2B5\uB2C8\uB2E4. (AI \uCD94\uCD9C\uAC12: ${fromAi.toLocaleString()}\uC6D0)`
      );
    }
    if (!isPlausibleAmount(fromText)) {
      return {
        sourceText,
        corrections,
        draft: {
          category: "unclear",
          reason: `\uAE08\uC561 ${fromText.toLocaleString()}\uC6D0\uC774 \uC815\uC0C1 \uBC94\uC704(${AMOUNT_MIN.toLocaleString()}~${AMOUNT_MAX.toLocaleString()}\uC6D0)\uB97C \uBC97\uC5B4\uB0A9\uB2C8\uB2E4.`,
          question: "\uAE08\uC561\uC744 \uB2E4\uC2DC \uD655\uC778\uD574 \uC8FC\uC138\uC694. \uC790\uB9BF\uC218\uAC00 \uB9DE\uB098\uC694?"
        }
      };
    }
    if (amounts.length > 1) {
      corrections.push(
        `\uAE08\uC561\uC774 \uC5EC\uB7EC \uAC1C(${amounts.map((a) => a.toLocaleString()).join(", ")}) \uBC1C\uACAC\uB418\uC5B4 \uCCAB \uBC88\uC9F8\uB97C \uC0AC\uC6A9\uD588\uC2B5\uB2C8\uB2E4. \uD655\uC778\uD574 \uC8FC\uC138\uC694.`
      );
    }
    const aiType = ["\uC6D0\uBE44", "\uD658\uBD88", "\uC9C0\uCD9C", "\uAE30\uD0C0"].includes(ai.type) ? ai.type : null;
    const typeFromText = extractPaymentType(sourceText);
    const type = typeFromText ?? aiType ?? "\uC6D0\uBE44";
    if (typeFromText && aiType && typeFromText !== aiType) {
      corrections.push(`\uC720\uD615\uC744 \uC6D0\uBB38 \uAE30\uC900 "${typeFromText}"\uB85C \uC815\uC815\uD588\uC2B5\uB2C8\uB2E4. (AI \uD310\uB2E8: "${aiType}")`);
    }
    const signed = type === "\uD658\uBD88" || type === "\uC9C0\uCD9C" ? -fromText : fromText;
    if (signed < 0) {
      corrections.push(`${type}\uC774\uBBC0\uB85C \uAE08\uC561\uC744 \uC74C\uC218(${signed.toLocaleString()}\uC6D0)\uB85C \uAE30\uB85D\uD569\uB2C8\uB2E4.`);
    }
    const paymentMonth = normalizeMonth(ai.month, sourceText, now);
    if (!paymentMonth) {
      return {
        sourceText,
        corrections,
        draft: {
          category: "unclear",
          reason: "\uBA87 \uC6D4\uBD84 \uC218\uB0A9\uC778\uC9C0 \uBB38\uC7A5\uC5D0\uC11C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
          question: "\uBA87 \uC6D4\uBD84\uC778\uAC00\uC694? (\uC608: \uC774\uBC88\uB2EC, 8\uC6D4)"
        }
      };
    }
    if (!ai.month) {
      corrections.push(`\uC6D4 \uC815\uBCF4\uAC00 \uC5C6\uC5B4 \uC6D0\uBB38\uC5D0\uC11C ${paymentMonth}\uB85C \uD574\uC11D\uD588\uC2B5\uB2C8\uB2E4.`);
    }
    const studentName = cleanStudentName(ai.student_name);
    if (!studentName && (type === "\uC6D0\uBE44" || type === "\uD658\uBD88")) {
      return {
        sourceText,
        corrections,
        draft: {
          category: "unclear",
          reason: "\uD559\uC0DD \uC774\uB984\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
          question: "\uC5B4\uB290 \uD559\uC0DD\uC758 \uC218\uB0A9\uC778\uAC00\uC694?"
        }
      };
    }
    const method = ["\uACC4\uC88C\uC774\uCCB4", "\uCE74\uB4DC", "\uD604\uAE08"].includes(
      ai.payment_method
    ) ? ai.payment_method : extractPaymentMethod(sourceText);
    return {
      sourceText,
      corrections,
      draft: {
        category: "accounting",
        studentName,
        amount: signed,
        type,
        paymentMonth,
        method,
        memo: ai.memo?.trim() || null
      }
    };
  }
  const looksLikePayment = /원비|수강료|납부|입금|결제|환불|지출|수납/.test(sourceText);
  if (looksLikePayment) {
    return {
      sourceText,
      corrections,
      draft: {
        category: "unclear",
        reason: "\uC218\uB0A9 \uAD00\uB828 \uBB38\uC7A5 \uAC19\uC740\uB370 \uAE08\uC561\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.",
        question: "\uAE08\uC561\uC774 \uC5BC\uB9C8\uC778\uAC00\uC694? (\uC608: \uAE40\uBBFC\uC900 35\uB9CC\uC6D0 \uC774\uBC88\uB2EC \uC6D0\uBE44 \uCE74\uB4DC)"
      }
    };
  }
  if (extractConsultationStatus(sourceText) !== null) {
    return {
      sourceText,
      corrections,
      draft: {
        category: "unclear",
        reason: "\uB4F1\uB85D/\uC0C1\uB2F4 \uAC74\uC73C\uB85C \uBCF4\uC774\uB294\uB370 \uC5F0\uB77D\uCC98\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.",
        question: "\uD559\uBD80\uBAA8 \uC5F0\uB77D\uCC98\uB97C \uD568\uAED8 \uC801\uC5B4\uC8FC\uC138\uC694. (\uC608: 010-1234-5678 \uAE40\uBBFC\uC900 \uC9112 \uC601\uC5B4 \uB4F1\uB85D, \uAE30\uC900\uC77C 13\uC77C, 8\uC6D4 13\uC77C\uBD80\uD130)"
      }
    };
  }
  return {
    sourceText,
    corrections,
    draft: {
      category: "unclear",
      reason: "\uC804\uD654\uBC88\uD638\uB3C4 \uAE08\uC561\uB3C4 \uC5C6\uC5B4 \uC5B4\uB290 \uCABD\uC778\uC9C0 \uD310\uB2E8\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
      question: "\uC218\uB0A9 \uAC74\uC774\uBA74 \uAE08\uC561\uC744, \uC0C1\uB2F4\xB7\uB4F1\uB85D \uAC74\uC774\uBA74 \uC5F0\uB77D\uCC98\uB97C \uD568\uAED8 \uC801\uC5B4\uC8FC\uC138\uC694."
    }
  };
}
async function parseInput(text2, opts = {}) {
  const trimmed = text2.trim();
  if (!trimmed) {
    return {
      sourceText: text2,
      corrections: [],
      draft: { category: "unclear", reason: "\uC785\uB825\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.", question: "\uB0B4\uC6A9\uC744 \uC785\uB825\uD574 \uC8FC\uC138\uC694." }
    };
  }
  const ai = await callOpenAi(trimmed, opts.signal);
  return arbitrate(ai, trimmed, opts.now ?? /* @__PURE__ */ new Date());
}

// server/routes.ts
import { z as z2 } from "zod";
import { eq as eq2 } from "drizzle-orm";
var idParamSchema = z2.object({
  id: z2.string().uuid("\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 ID \uD615\uC2DD\uC785\uB2C8\uB2E4.")
});
var tenantIdParamSchema = z2.object({
  id: z2.string().min(1, "\uD14C\uB10C\uD2B8 ID\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.")
});
var signupSchema = z2.object({
  email: z2.string().email("\uC720\uD6A8\uD55C \uC774\uBA54\uC77C \uC8FC\uC18C\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  password: z2.string().min(6, "\uBE44\uBC00\uBC88\uD638\uB294 \uCD5C\uC18C 6\uC790 \uC774\uC0C1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4."),
  name: z2.string().min(1, "\uC774\uB984\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  academyName: z2.string().min(1, "\uD559\uC6D0\uBA85\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  ownerName: z2.string().min(1, "\uB300\uD45C\uC790\uBA85\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  ownerPhone: z2.string().min(1, "\uB300\uD45C\uC790 \uC5F0\uB77D\uCC98\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694.")
});
var signinSchema = z2.object({
  email: z2.string().email("\uC720\uD6A8\uD55C \uC774\uBA54\uC77C \uC8FC\uC18C\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  password: z2.string().min(1, "\uBE44\uBC00\uBC88\uD638\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694.")
});
var teacherSignupSchema = z2.object({
  academyEmail: z2.string().email("\uD559\uC6D0 \uC774\uBA54\uC77C\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  email: z2.string().email("\uC720\uD6A8\uD55C \uC774\uBA54\uC77C \uC8FC\uC18C\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  password: z2.string().min(6, "\uBE44\uBC00\uBC88\uD638\uB294 \uCD5C\uC18C 6\uC790 \uC774\uC0C1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4."),
  name: z2.string().min(1, "\uC774\uB984\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  subject: z2.string().min(1, "\uB2F4\uB2F9 \uACFC\uBAA9\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694."),
  phone: z2.string().optional()
});
async function registerRoutes(app2) {
  app2.use(cookieParser());
  const validateBody = (schema) => {
    return (req, res, next) => {
      try {
        req.body = schema.parse(req.body);
        next();
      } catch (error) {
        if (error instanceof z2.ZodError) {
          console.error("\u{1F6A8} Validation Error:", JSON.stringify(error.errors, null, 2));
          return res.status(400).json({
            error: "\uC785\uB825 \uB370\uC774\uD130\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",
            details: error.errors
          });
        }
        return res.status(400).json({ error: "\uC785\uB825 \uB370\uC774\uD130 \uAC80\uC99D \uC2E4\uD328" });
      }
    };
  };
  const validateParams = (schema) => {
    return (req, res, next) => {
      try {
        req.params = schema.parse(req.params);
        next();
      } catch (error) {
        if (error instanceof z2.ZodError) {
          return res.status(400).json({
            error: "\uB9E4\uAC1C\uBCC0\uC218\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",
            details: error.errors
          });
        }
        return res.status(400).json({ error: "\uB9E4\uAC1C\uBCC0\uC218 \uAC80\uC99D \uC2E4\uD328" });
      }
    };
  };
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1e3
    // 7 days
  };
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn("\u26A0\uFE0F  ADMIN_PASSWORD is not set \u2014 admin login is disabled. Set it in Railway Variables!");
  }
  app2.post(
    "/api/auth/admin-login",
    validateBody(z2.object({
      password: z2.string()
    })),
    async (req, res) => {
      try {
        const { password } = req.body;
        console.log("\u{1F527} Admin login attempt received");
        console.log("\u{1F527} ADMIN_PASSWORD configured:", !!adminPassword);
        if (!adminPassword) {
          console.error("\u274C Admin login failed: ADMIN_PASSWORD env var is not set");
          return res.status(503).json({ error: "ADMIN_PASSWORD \uD658\uACBD\uBCC0\uC218\uAC00 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. Railway Variables\uC5D0\uC11C \uC124\uC815\uD574\uC8FC\uC138\uC694." });
        }
        if (password !== adminPassword) {
          console.warn("\u26A0\uFE0F  Admin login: wrong password attempt");
          return res.status(401).json({ error: "\uC798\uBABB\uB41C \uAD00\uB9AC\uC790 \uBE44\uBC00\uBC88\uD638\uC785\uB2C8\uB2E4." });
        }
        const token = generateToken({
          id: "admin",
          email: "admin@system.local",
          name: "\uC2DC\uC2A4\uD15C \uAD00\uB9AC\uC790",
          role: "superadmin",
          tenantId: null
        });
        console.log("\u{1F527} Admin token generated:", token ? "SUCCESS" : "FAILED");
        console.log("\u{1F527} Setting cookie with token length:", token?.length || 0);
        res.cookie("token", token, cookieOptions);
        console.log("\u{1F527} Admin login cookie set successfully");
        res.json({
          message: "\uAD00\uB9AC\uC790 \uB85C\uADF8\uC778 \uC131\uACF5",
          user: {
            id: "admin",
            email: "admin@system.local",
            name: "\uC2DC\uC2A4\uD15C \uAD00\uB9AC\uC790",
            role: "superadmin",
            tenantId: null
          }
        });
      } catch (error) {
        console.error("\u274C Admin login error:", error);
        res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post(
    "/api/auth/signup",
    validateBody(signupSchema),
    async (req, res) => {
      try {
        const { email, password, name, academyName, ownerName, ownerPhone } = req.body;
        const existingUser = await storage.getUserByEmail(email);
        if (existingUser) {
          return res.status(409).json({ error: "\uC774\uBBF8 \uB4F1\uB85D\uB41C \uC774\uBA54\uC77C \uC8FC\uC18C\uC785\uB2C8\uB2E4." });
        }
        const accountNumber = `AC${Date.now()}`;
        const tenant = await storage.createTenant({
          name: academyName,
          accountNumber,
          ownerName,
          ownerPhone,
          status: "pending"
        });
        const hashedPassword = await hashPassword(password);
        const user = await storage.createUser({
          tenantId: tenant.id,
          email,
          password: hashedPassword,
          name,
          role: "owner",
          isActive: true
        });
        const token = generateToken({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId
        });
        res.cookie("token", token, cookieOptions);
        res.status(201).json({
          message: "\uD68C\uC6D0\uAC00\uC785\uC774 \uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC2B9\uC778 \uCC98\uB9AC\uB97C \uC704\uD574 \uAD00\uB9AC\uC790\uC5D0\uAC8C \uBB38\uC758\uD574\uC8FC\uC138\uC694.",
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
          },
          tenant: {
            id: tenant.id,
            name: tenant.name,
            accountNumber: tenant.accountNumber,
            status: tenant.status
          }
        });
      } catch (error) {
        console.error("Signup error:", error);
        res.status(500).json({ error: "\uD68C\uC6D0\uAC00\uC785 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post(
    "/api/auth/signup/teacher",
    validateBody(teacherSignupSchema),
    async (req, res) => {
      try {
        const { academyEmail, email, password, name, subject, phone } = req.body;
        let existingUser = await storage.getUserByEmail(email);
        if (existingUser) {
          const existingTeacher = await storage.getTeacherByUserId(existingUser.id);
          if (existingTeacher) {
            return res.status(409).json({ error: "\uC774\uBBF8 \uB4F1\uB85D\uB41C \uC774\uBA54\uC77C \uC8FC\uC18C\uC785\uB2C8\uB2E4." });
          }
          await storage.deleteUser(existingUser.id);
          existingUser = void 0;
        }
        const ownerUser = await storage.getUserByEmail(academyEmail);
        if (!ownerUser || ownerUser.role !== "owner") {
          return res.status(404).json({ error: "\uD574\uB2F9 \uD559\uC6D0\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (!ownerUser.tenantId) {
          return res.status(400).json({ error: "\uD559\uC6D0 \uC815\uBCF4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
        }
        const tenant = await storage.getTenant(ownerUser.tenantId);
        if (!tenant) {
          return res.status(404).json({ error: "\uD559\uC6D0\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const hashedPassword = await hashPassword(password);
        const isTeacherActive = tenant.status === "active";
        const user = await storage.createUser({
          tenantId: tenant.id,
          email,
          password: hashedPassword,
          name,
          role: "teacher",
          isActive: isTeacherActive
          // Active only if academy is already approved
        });
        let teacher;
        try {
          teacher = await storage.createTeacher({
            tenantId: tenant.id,
            userId: user.id,
            name,
            subject,
            phone: phone || null,
            isActive: isTeacherActive
          });
        } catch (teacherError) {
          await storage.deleteUser(user.id);
          throw teacherError;
        }
        if (isTeacherActive) {
          const token = generateToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            tenantId: user.tenantId
          });
          res.cookie("token", token, cookieOptions);
        }
        const statusMessage = isTeacherActive ? "\uAD50\uC0AC \uACC4\uC815\uC774 \uC0DD\uC131\uB418\uC5C8\uC2B5\uB2C8\uB2E4." : "\uAD50\uC0AC \uACC4\uC815\uC774 \uC0DD\uC131\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uD559\uC6D0 \uC2B9\uC778 \uD6C4 \uB85C\uADF8\uC778 \uAC00\uB2A5\uD569\uB2C8\uB2E4.";
        const responseData = {
          message: statusMessage,
          needsApproval: !isTeacherActive,
          teacher: {
            id: teacher.id,
            subject: teacher.subject,
            phone: teacher.phone
          }
        };
        if (isTeacherActive) {
          responseData.user = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
          };
          responseData.tenant = {
            id: tenant.id,
            name: tenant.name,
            accountNumber: tenant.accountNumber,
            status: tenant.status
          };
        }
        res.status(201).json(responseData);
      } catch (error) {
        console.error("Teacher signup error:", error);
        res.status(500).json({ error: "\uAD50\uC0AC \uAC00\uC785 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post(
    "/api/auth/signin",
    validateBody(signinSchema),
    async (req, res) => {
      try {
        const { email, password } = req.body;
        console.log(`\u{1F510} Signin attempt: ${email}`);
        const user = await storage.getUserByEmail(email);
        if (!user) {
          console.warn(`\u26A0\uFE0F  Signin failed: user not found for ${email}`);
          return res.status(401).json({ error: "\uC774\uBA54\uC77C \uB610\uB294 \uBE44\uBC00\uBC88\uD638\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
        }
        const isValidPassword = await verifyPassword(password, user.password);
        if (!isValidPassword) {
          console.warn(`\u26A0\uFE0F  Signin failed: wrong password for ${email}`);
          return res.status(401).json({ error: "\uC774\uBA54\uC77C \uB610\uB294 \uBE44\uBC00\uBC88\uD638\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
        }
        if (!user.isActive) {
          console.warn(`\u26A0\uFE0F  Signin failed: account inactive for ${email}`);
          return res.status(403).json({ error: "\uBE44\uD65C\uC131\uD654\uB41C \uACC4\uC815\uC785\uB2C8\uB2E4." });
        }
        const token = generateToken({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId
        });
        res.cookie("token", token, cookieOptions);
        console.log(`\u2705 User signin success: ${user.email} (role=${user.role})`);
        let tenant = null;
        if (user.tenantId) {
          tenant = await storage.getTenant(user.tenantId);
        }
        res.json({
          message: "\uB85C\uADF8\uC778 \uC131\uACF5",
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
          },
          tenant: tenant ? {
            id: tenant.id,
            name: tenant.name,
            accountNumber: tenant.accountNumber,
            status: tenant.status
          } : null
        });
      } catch (error) {
        console.error("Signin error:", error);
        res.status(500).json({ error: "\uB85C\uADF8\uC778 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post("/api/auth/signout", (req, res) => {
    res.clearCookie("token");
    res.json({ message: "\uB85C\uADF8\uC544\uC6C3 \uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
  });
  app2.get("/api/auth/me", authGuard, async (req, res) => {
    try {
      let tenant = null;
      if (req.user.tenantId) {
        tenant = await storage.getTenant(req.user.tenantId);
      }
      res.json({
        user: {
          id: req.user.id,
          email: req.user.email,
          name: req.user.name,
          role: req.user.role
        },
        tenant: tenant ? {
          id: tenant.id,
          name: tenant.name,
          accountNumber: tenant.accountNumber,
          status: tenant.status
        } : null
      });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "\uC0AC\uC6A9\uC790 \uC815\uBCF4 \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.get("/api/students", authGuard, tenantGuard, async (req, res) => {
    try {
      const students2 = await storage.getStudentsByTenant(req.user.tenantId);
      res.json(students2);
    } catch (error) {
      console.error("Get students error:", error);
      res.status(500).json({ error: "\uD559\uC0DD \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.get("/api/dashboard/students", authGuard, tenantGuard, async (req, res) => {
    try {
      const students2 = await storage.getDashboardStudents(req.user.tenantId);
      res.json(students2);
    } catch (error) {
      console.error("Get dashboard students error:", error);
      res.status(500).json({ error: "\uB300\uC2DC\uBCF4\uB4DC \uD559\uC0DD \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.get(
    "/api/students/:id",
    authGuard,
    tenantGuard,
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: "\uD559\uC0DD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (student.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        res.json(student);
      } catch (error) {
        console.error("Get student error:", error);
        res.status(500).json({ error: "\uD559\uC0DD \uC815\uBCF4 \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post(
    "/api/students",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateBody(insertStudentSchema.omit({ tenantId: true, isActive: true })),
    async (req, res) => {
      try {
        const studentData = {
          ...req.body,
          tenantId: req.user.tenantId,
          isActive: true
        };
        const student = await storage.createStudent(studentData);
        res.status(201).json(student);
      } catch (error) {
        console.error("Create student error:", error);
        res.status(500).json({ error: "\uD559\uC0DD \uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.put(
    "/api/students/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    validateBody(insertStudentSchema.omit({ tenantId: true }).partial()),
    async (req, res) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: "\uD559\uC0DD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (student.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const updatedStudent = await storage.updateStudent(req.params.id, req.body);
        res.json(updatedStudent);
      } catch (error) {
        console.error("Update student error:", error);
        res.status(500).json({ error: "\uD559\uC0DD \uC815\uBCF4 \uC218\uC815 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/students/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: "\uD559\uC0DD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (student.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        await storage.deleteStudent(req.params.id);
        res.json({ message: "\uD559\uC0DD\uC774 \uC644\uC804\uD788 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      } catch (error) {
        console.error("Delete student error:", error);
        res.status(500).json({ error: "\uD559\uC0DD \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.patch(
    "/api/students/:id/deactivate",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: "\uD559\uC0DD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (student.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        await storage.deactivateStudent(req.params.id);
        res.json({ message: "\uD559\uC0DD\uC774 \uD734\uC6D0 \uCC98\uB9AC\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      } catch (error) {
        console.error("Deactivate student error:", error);
        res.status(500).json({ error: "\uD559\uC0DD \uD734\uC6D0 \uCC98\uB9AC \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.patch(
    "/api/students/:id/activate",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: "\uD559\uC0DD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (student.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        await storage.activateStudent(req.params.id);
        res.json({ message: "\uD559\uC0DD\uC774 \uC7AC\uB4F1\uB85D\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      } catch (error) {
        console.error("Activate student error:", error);
        res.status(500).json({ error: "\uD559\uC0DD \uC7AC\uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.get("/api/teachers", authGuard, tenantGuard, async (req, res) => {
    try {
      const teachers2 = await storage.getTeachersByTenant(req.user.tenantId);
      res.json(teachers2);
    } catch (error) {
      console.error("Get teachers error:", error);
      res.status(500).json({ error: "\uAD50\uC0AC \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.get(
    "/api/teachers/:id",
    authGuard,
    tenantGuard,
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const teacher = await storage.getTeacher(req.params.id);
        if (!teacher) {
          return res.status(404).json({ error: "\uAD50\uC0AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (teacher.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        res.json(teacher);
      } catch (error) {
        console.error("Get teacher error:", error);
        res.status(500).json({ error: "\uAD50\uC0AC \uC815\uBCF4 \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post(
    "/api/teachers",
    authGuard,
    tenantGuard,
    roleGuard("owner"),
    validateBody(insertTeacherSchema.omit({ tenantId: true, isActive: true })),
    async (req, res) => {
      try {
        const teacherData = {
          ...req.body,
          tenantId: req.user.tenantId,
          isActive: true
        };
        const teacher = await storage.createTeacher(teacherData);
        res.status(201).json(teacher);
      } catch (error) {
        console.error("Create teacher error:", error);
        res.status(500).json({ error: "\uAD50\uC0AC \uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.put(
    "/api/teachers/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner"),
    validateParams(idParamSchema),
    validateBody(insertTeacherSchema.omit({ tenantId: true }).partial()),
    async (req, res) => {
      try {
        const teacher = await storage.getTeacher(req.params.id);
        if (!teacher) {
          return res.status(404).json({ error: "\uAD50\uC0AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (teacher.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const updatedTeacher = await storage.updateTeacher(req.params.id, req.body);
        res.json(updatedTeacher);
      } catch (error) {
        console.error("Update teacher error:", error);
        res.status(500).json({ error: "\uAD50\uC0AC \uC815\uBCF4 \uC218\uC815 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/teachers/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const teacher = await storage.getTeacher(req.params.id);
        if (!teacher) {
          return res.status(404).json({ error: "\uAD50\uC0AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (teacher.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const isAlreadyInactive = !teacher.isActive;
        await storage.deleteTeacher(req.params.id);
        res.json({
          message: isAlreadyInactive ? "\uAD50\uC0AC\uAC00 \uC644\uC804\uD788 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." : "\uAD50\uC0AC\uAC00 \uBE44\uD65C\uC131\uD654\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
          permanentlyDeleted: isAlreadyInactive
        });
      } catch (error) {
        console.error("Delete teacher error:", error);
        res.status(500).json({ error: "\uAD50\uC0AC \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.get("/api/classes", authGuard, tenantGuard, async (req, res) => {
    try {
      const classes2 = await storage.getClassesByTenant(req.user.tenantId);
      res.json(classes2);
    } catch (error) {
      console.error("Get classes error:", error);
      res.status(500).json({ error: "\uBC18 \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.get(
    "/api/classes/:id",
    authGuard,
    tenantGuard,
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const classItem = await storage.getClass(req.params.id);
        if (!classItem) {
          return res.status(404).json({ error: "\uBC18\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (classItem.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        res.json(classItem);
      } catch (error) {
        console.error("Get class error:", error);
        res.status(500).json({ error: "\uBC18 \uC815\uBCF4 \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post(
    "/api/classes",
    authGuard,
    tenantGuard,
    roleGuard("owner"),
    validateBody(insertClassSchema.omit({ tenantId: true, isActive: true })),
    async (req, res) => {
      try {
        const classData = {
          ...req.body,
          tenantId: req.user.tenantId,
          isActive: true
        };
        const newClass = await storage.createClass(classData);
        res.status(201).json(newClass);
      } catch (error) {
        console.error("Create class error:", error);
        res.status(500).json({ error: "\uBC18 \uC0DD\uC131 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.put(
    "/api/classes/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner"),
    validateParams(idParamSchema),
    validateBody(insertClassSchema.omit({ tenantId: true }).partial()),
    async (req, res) => {
      try {
        const classItem = await storage.getClass(req.params.id);
        if (!classItem) {
          return res.status(404).json({ error: "\uBC18\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (classItem.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const updatedClass = await storage.updateClass(req.params.id, req.body);
        res.json(updatedClass);
      } catch (error) {
        console.error("Update class error:", error);
        res.status(500).json({ error: "\uBC18 \uC815\uBCF4 \uC218\uC815 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/classes/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const classItem = await storage.getClass(req.params.id);
        if (!classItem) {
          return res.status(404).json({ error: "\uBC18\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (classItem.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const wasInactive = !classItem.isActive;
        await storage.deleteClass(req.params.id);
        res.json({
          message: wasInactive ? "\uBC18\uC774 \uC644\uC804\uD788 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." : "\uBC18\uC774 \uBE44\uD65C\uC131 \uCC98\uB9AC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
          hardDeleted: wasInactive
        });
      } catch (error) {
        console.error("Delete class error:", error);
        res.status(500).json({ error: "\uBC18 \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.get("/api/enrollments", authGuard, tenantGuard, async (req, res) => {
    try {
      const enrollments2 = await storage.getEnrollmentsByTenant(req.user.tenantId);
      res.json(enrollments2);
    } catch (error) {
      console.error("Get enrollments error:", error);
      res.status(500).json({ error: "\uC218\uAC15 \uB4F1\uB85D \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.post(
    "/api/enrollments",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    (req, res, next) => {
      console.log("\u{1F525} BEFORE conversion:", JSON.stringify(req.body, null, 2));
      if (req.body.startDate && typeof req.body.startDate === "string") {
        req.body.startDate = new Date(req.body.startDate);
        console.log("\u{1F525} Converted startDate to:", req.body.startDate, typeof req.body.startDate);
      }
      if (req.body.endDate && typeof req.body.endDate === "string") {
        req.body.endDate = new Date(req.body.endDate);
      }
      console.log("\u{1F525} AFTER conversion:", JSON.stringify(req.body, null, 2));
      next();
    },
    validateBody(insertEnrollmentSchema.omit({ tenantId: true, isActive: true })),
    async (req, res) => {
      try {
        const enrollmentData = {
          ...req.body,
          tenantId: req.user.tenantId,
          isActive: true
        };
        const enrollment = await storage.createEnrollment(enrollmentData);
        res.status(201).json(enrollment);
      } catch (error) {
        console.error("Create enrollment error:", error);
        res.status(500).json({ error: "\uC218\uAC15 \uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.put(
    "/api/enrollments/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    validateBody(updateEnrollmentSchema),
    (req, res, next) => {
      if (req.body.startDate && typeof req.body.startDate === "string") {
        const dateStr = req.body.startDate;
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          req.body.startDate = /* @__PURE__ */ new Date(dateStr + "T00:00:00Z");
        } else {
          delete req.body.startDate;
        }
      }
      if (req.body.endDate && typeof req.body.endDate === "string") {
        const dateStr = req.body.endDate;
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          req.body.endDate = /* @__PURE__ */ new Date(dateStr + "T00:00:00Z");
        } else {
          delete req.body.endDate;
        }
      }
      next();
    },
    async (req, res) => {
      try {
        const enrollment = await storage.getEnrollment ? await storage.getEnrollment(req.params.id) : null;
        if (!enrollment) {
          return res.status(404).json({ error: "\uC218\uAC15 \uB4F1\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (enrollment.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const updatedEnrollment = await storage.updateEnrollment(req.params.id, req.body);
        res.json(updatedEnrollment);
      } catch (error) {
        console.error("Update enrollment error:", error);
        res.status(500).json({ error: "\uC218\uAC15 \uB4F1\uB85D \uC218\uC815 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/enrollments/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const enrollment = await storage.getEnrollment ? await storage.getEnrollment(req.params.id) : null;
        if (!enrollment) {
          return res.status(404).json({ error: "\uC218\uAC15 \uB4F1\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (enrollment.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        await storage.deleteEnrollment(req.params.id);
        res.json({ message: "\uC218\uAC15 \uB4F1\uB85D\uC774 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      } catch (error) {
        console.error("Delete enrollment error:", error);
        res.status(500).json({ error: "\uC218\uAC15 \uB4F1\uB85D \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.get("/api/payments", authGuard, tenantGuard, async (req, res) => {
    try {
      const payments2 = await storage.getPaymentsByTenant ? await storage.getPaymentsByTenant(req.user.tenantId) : [];
      res.json(payments2);
    } catch (error) {
      console.error("Get payments error:", error);
      res.status(500).json({ error: "\uACB0\uC81C \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.post(
    "/api/payments",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    (req, res, next) => {
      console.log("\u{1F525} Payment data received:", JSON.stringify(req.body, null, 2));
      if (req.body.paidDate && typeof req.body.paidDate === "string") {
        req.body.paidDate = new Date(req.body.paidDate);
        console.log("\u{1F525} Converted paidDate to:", req.body.paidDate, typeof req.body.paidDate);
      }
      next();
    },
    validateBody(createPaymentBodySchema),
    async (req, res) => {
      try {
        const paymentData = {
          ...req.body,
          tenantId: req.user.tenantId,
          createdBy: req.user.id
        };
        const payment = await storage.createPayment(paymentData);
        res.status(201).json(payment);
      } catch (error) {
        console.error("Create payment error:", error);
        res.status(500).json({ error: "\uACB0\uC81C \uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.get("/api/lesson-logs", authGuard, tenantGuard, async (req, res) => {
    try {
      const lessonLogs2 = await storage.getLessonLogsByTenant ? await storage.getLessonLogsByTenant(req.user.tenantId) : [];
      res.json(lessonLogs2);
    } catch (error) {
      console.error("Get lesson logs error:", error);
      res.status(500).json({ error: "\uC218\uC5C5 \uC77C\uC9C0 \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.post(
    "/api/lesson-logs",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    (req, res, next) => {
      if (req.body.date && typeof req.body.date === "string") {
        req.body.date = new Date(req.body.date);
      }
      next();
    },
    validateBody(insertLessonLogSchema.omit({ tenantId: true, createdBy: true })),
    async (req, res) => {
      try {
        const lessonLogData = {
          ...req.body,
          tenantId: req.user.tenantId,
          createdBy: req.user.id
        };
        const lessonLog = await storage.createLessonLog ? await storage.createLessonLog(lessonLogData) : null;
        if (!lessonLog) {
          throw new Error("\uC218\uC5C5 \uC77C\uC9C0 \uC0DD\uC131\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
        }
        res.status(201).json(lessonLog);
      } catch (error) {
        console.error("Create lesson log error:", error);
        res.status(500).json({ error: "\uC218\uC5C5 \uC77C\uC9C0 \uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/lesson-logs/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        await storage.deleteLessonLog(req.params.id);
        res.json({ message: "\uC218\uC5C5 \uC77C\uC9C0\uAC00 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      } catch (error) {
        console.error("Delete lesson log error:", error);
        res.status(500).json({ error: "\uC218\uC5C5 \uC77C\uC9C0 \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.get("/api/waiters", authGuard, tenantGuard, async (req, res) => {
    try {
      const waiters2 = await storage.getWaitersByTenant ? await storage.getWaitersByTenant(req.user.tenantId) : [];
      res.json(waiters2);
    } catch (error) {
      console.error("Get waiters error:", error);
      res.status(500).json({ error: "\uB300\uAE30\uC790 \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.post(
    "/api/waiters",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateBody(insertWaiterSchema.omit({ tenantId: true })),
    async (req, res) => {
      try {
        const waiterData = {
          ...req.body,
          tenantId: req.user.tenantId
        };
        const waiter = await storage.createWaiter ? await storage.createWaiter(waiterData) : null;
        if (!waiter) {
          throw new Error("\uB300\uAE30\uC790 \uB4F1\uB85D\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
        }
        res.status(201).json(waiter);
      } catch (error) {
        console.error("Create waiter error:", error);
        res.status(500).json({ error: "\uB300\uAE30\uC790 \uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/waiters/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const waiter = await storage.getWaiter ? await storage.getWaiter(req.params.id) : null;
        if (!waiter) {
          return res.status(404).json({ error: "\uB300\uAE30\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (waiter.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        await storage.deleteWaiter ? await storage.deleteWaiter(req.params.id) : null;
        res.json({ message: "\uB300\uAE30\uC790\uAC00 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      } catch (error) {
        console.error("Delete waiter error:", error);
        res.status(500).json({ error: "\uB300\uAE30\uC790 \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.get("/api/consultations", authGuard, tenantGuard, async (req, res) => {
    try {
      const rows = await storage.getConsultationsByTenant(req.user.tenantId);
      res.json(rows);
    } catch (error) {
      console.error("Get consultations error:", error);
      res.status(500).json({ error: "\uC0C1\uB2F4 \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
    }
  });
  app2.post(
    "/api/consultations",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateBody(createConsultationBodySchema),
    async (req, res) => {
      try {
        const created = await storage.createConsultation({
          ...req.body,
          tenantId: req.user.tenantId,
          createdBy: req.user.id
        });
        res.status(201).json(created);
      } catch (error) {
        console.error("Create consultation error:", error);
        res.status(500).json({ error: "\uC0C1\uB2F4 \uB4F1\uB85D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.patch(
    "/api/consultations/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateParams(idParamSchema),
    validateBody(createConsultationBodySchema.partial()),
    async (req, res) => {
      try {
        const existing = await storage.getConsultation(req.params.id);
        if (!existing) return res.status(404).json({ error: "\uC0C1\uB2F4 \uAE30\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        if (existing.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const updated = await storage.updateConsultation(req.params.id, req.body);
        res.json(updated);
      } catch (error) {
        console.error("Update consultation error:", error);
        res.status(500).json({ error: "\uC0C1\uB2F4 \uC218\uC815 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/consultations/:id",
    authGuard,
    tenantGuard,
    roleGuard("owner"),
    validateParams(idParamSchema),
    async (req, res) => {
      try {
        const existing = await storage.getConsultation(req.params.id);
        if (!existing) return res.status(404).json({ error: "\uC0C1\uB2F4 \uAE30\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        if (existing.tenantId !== req.user.tenantId) {
          return res.status(403).json({ error: "\uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        await storage.deleteConsultation(req.params.id);
        res.json({ message: "\uC0C1\uB2F4 \uAE30\uB85D\uC774 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      } catch (error) {
        console.error("Delete consultation error:", error);
        res.status(500).json({ error: "\uC0C1\uB2F4 \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.post(
    "/api/nlp/parse",
    authGuard,
    tenantGuard,
    roleGuard("owner", "teacher"),
    validateBody(z2.object({
      text: z2.string().min(1, "\uC785\uB825 \uB0B4\uC6A9\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.").max(500, "500\uC790 \uC774\uB0B4\uB85C \uC785\uB825\uD574\uC8FC\uC138\uC694.")
    })),
    async (req, res) => {
      try {
        const result = await parseInput(req.body.text);
        let studentMatches = [];
        if (result.draft.category === "accounting" && result.draft.studentName) {
          const found = await storage.findStudentsByName(
            req.user.tenantId,
            result.draft.studentName
          );
          studentMatches = await Promise.all(
            found.map(async (s) => ({
              student: { id: s.id, name: s.name, grade: s.grade, school: s.school },
              enrollments: await storage.getActiveEnrollmentsWithClass(req.user.tenantId, s.id)
            }))
          );
        }
        let classMatch = null;
        if (result.draft.category === "contact") {
          const classes2 = await storage.getClassesByTenant(req.user.tenantId);
          const hit = matchClassName(req.body.text, classes2);
          if (hit) classMatch = { id: hit.id, name: hit.name };
        }
        res.json({ ...result, studentMatches, classMatch });
      } catch (error) {
        if (error instanceof NlpConfigError) {
          console.error("NLP config error:", error.message);
          return res.status(503).json({ error: error.message });
        }
        console.error("NLP parse error:", error?.message || error);
        res.status(502).json({ error: "\uBB38\uC7A5 \uBD84\uC11D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694." });
      }
    }
  );
  app2.get(
    "/api/superadmin/tenants",
    authGuard,
    roleGuard("superadmin"),
    async (req, res) => {
      try {
        const tenants2 = await storage.getAllTenants();
        res.json(tenants2);
      } catch (error) {
        console.error("Get all tenants error:", error);
        res.status(500).json({ error: "\uD14C\uB10C\uD2B8 \uBAA9\uB85D \uC870\uD68C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.put(
    "/api/superadmin/tenants/:id/approve",
    authGuard,
    roleGuard("superadmin"),
    validateParams(tenantIdParamSchema),
    async (req, res) => {
      try {
        const tenant = await storage.getTenant(req.params.id);
        if (!tenant) {
          return res.status(404).json({ error: "\uD14C\uB10C\uD2B8\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        if (tenant.status !== "pending") {
          return res.status(400).json({ error: "\uC2B9\uC778 \uB300\uAE30 \uC0C1\uD0DC\uC758 \uD14C\uB10C\uD2B8\uB9CC \uC2B9\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4." });
        }
        const approvedTenant = await storage.updateTenantStatus(req.params.id, "active");
        res.json({
          message: "\uD14C\uB10C\uD2B8\uAC00 \uC2B9\uC778\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
          tenant: approvedTenant
        });
      } catch (error) {
        console.error("Approve tenant error:", error);
        res.status(500).json({ error: "\uD14C\uB10C\uD2B8 \uC2B9\uC778 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.patch(
    "/api/superadmin/tenants/:id/status",
    authGuard,
    roleGuard("superadmin"),
    validateParams(tenantIdParamSchema),
    validateBody(z2.object({
      status: z2.enum(["pending", "active", "expired", "suspended"])
    })),
    async (req, res) => {
      try {
        const tenant = await storage.getTenant(req.params.id);
        if (!tenant) {
          return res.status(404).json({ error: "\uD14C\uB10C\uD2B8\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        const updatedTenant = await storage.updateTenantStatus(req.params.id, req.body.status);
        res.json({
          message: `\uD14C\uB10C\uD2B8 \uC0C1\uD0DC\uAC00 ${req.body.status}\uB85C \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`,
          tenant: updatedTenant
        });
      } catch (error) {
        console.error("Update tenant status error:", error);
        res.status(500).json({ error: "\uD14C\uB10C\uD2B8 \uC0C1\uD0DC \uC5C5\uB370\uC774\uD2B8 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.delete(
    "/api/superadmin/tenants/:id",
    authGuard,
    roleGuard("superadmin"),
    validateParams(tenantIdParamSchema),
    async (req, res) => {
      try {
        const tenant = await storage.getTenant(req.params.id);
        if (!tenant) {
          return res.status(404).json({ error: "\uD14C\uB10C\uD2B8\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        await storage.deleteTenant(req.params.id);
        res.json({
          message: "\uD14C\uB10C\uD2B8\uAC00 \uC644\uC804\uD788 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
          tenantId: req.params.id
        });
      } catch (error) {
        console.error("Delete tenant error:", error);
        res.status(500).json({ error: "\uD14C\uB10C\uD2B8 \uC0AD\uC81C \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.patch(
    "/api/superadmin/users/fix-account",
    authGuard,
    roleGuard("superadmin"),
    validateBody(z2.object({
      tenantId: z2.string(),
      newEmail: z2.string().email(),
      newPassword: z2.string().min(6),
      newName: z2.string().optional()
    })),
    async (req, res) => {
      try {
        const { tenantId, newEmail, newPassword, newName } = req.body;
        const hashedPassword = await hashPassword(newPassword);
        const result = await db.update(users).set({
          email: newEmail,
          password: hashedPassword,
          isActive: true,
          ...newName ? { name: newName } : {}
        }).where(eq2(users.tenantId, tenantId)).returning({ id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive });
        if (result.length === 0) {
          return res.status(404).json({ error: "\uD574\uB2F9 \uD14C\uB10C\uD2B8\uC758 \uC0AC\uC6A9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        console.log(`\u2705 fix-account: tenantId=${tenantId}, updated ${result.length} user(s)`);
        res.json({ message: "\uC0AC\uC6A9\uC790 \uACC4\uC815\uC774 \uC218\uC815\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", users: result });
      } catch (error) {
        console.error("fix-account error:", error);
        res.status(500).json({ error: "\uACC4\uC815 \uC218\uC815 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  app2.patch(
    "/api/superadmin/users/reset-password",
    authGuard,
    roleGuard("superadmin"),
    validateBody(z2.object({
      email: z2.string().email(),
      newPassword: z2.string().min(6)
    })),
    async (req, res) => {
      try {
        const { email, newPassword } = req.body;
        const hashedPassword = await hashPassword(newPassword);
        const result = await db.update(users).set({
          password: hashedPassword,
          isActive: true
        }).where(eq2(users.email, email)).returning({ id: users.id, email: users.email, name: users.name, role: users.role, tenantId: users.tenantId, isActive: users.isActive });
        if (result.length === 0) {
          return res.status(404).json({ error: "\uD574\uB2F9 \uC774\uBA54\uC77C\uC758 \uC0AC\uC6A9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        }
        console.log(`\u2705 reset-password: email=${email}, updated ${result.length} user(s)`);
        res.json({ message: "\uBE44\uBC00\uBC88\uD638\uAC00 \uC218\uC815\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", users: result });
      } catch (error) {
        console.error("reset-password error:", error);
        res.status(500).json({ error: "\uBE44\uBC00\uBC88\uD638 \uC218\uC815 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
      }
    }
  );
  const httpServer = createServer(app2);
  return httpServer;
}

// server/vite.ts
import express from "express";
import fs from "fs";
import path2 from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
import { createServer as createViteServer, createLogger } from "vite";

// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var vite_config_default = defineConfig({
  plugins: [
    react()
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@assets": path.resolve(__dirname, "attached_assets")
    }
  },
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/vite.ts
import { nanoid } from "nanoid";
var __filename2 = fileURLToPath2(import.meta.url);
var __dirname2 = path2.dirname(__filename2);
var viteLogger = createLogger();
function log(message, source = "express") {
  const formattedTime = (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
async function setupVite(app2, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      }
    },
    server: serverOptions,
    appType: "custom"
  });
  app2.use(vite.middlewares);
  app2.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        __dirname2,
        "..",
        "client",
        "index.html"
      );
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app2) {
  const distPath = path2.resolve(__dirname2, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/index.ts
var app = express2();
app.set("trust proxy", 1);
app.use(express2.json());
app.use(express2.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const start = Date.now();
  const path3 = req.path;
  let capturedJsonResponse = void 0;
  const originalResJson = res.json;
  res.json = function(bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path3.startsWith("/api")) {
      let logLine = `${req.method} ${path3} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    }
  });
  next();
});
(async () => {
  const server = await registerRoutes(app);
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error(`\u274C Unhandled error [${status}]:`, err);
    if (!res.headersSent) {
      res.status(status).json({ message });
    }
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "\uC874\uC7AC\uD558\uC9C0 \uC54A\uB294 API \uACBD\uB85C\uC785\uB2C8\uB2E4." });
  });
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  if (!process.env.JWT_SECRET) {
    console.warn("\u26A0\uFE0F  JWT_SECRET not set \u2014 using insecure default. Set it in Railway Variables!");
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("\u26A0\uFE0F  ADMIN_PASSWORD not set \u2014 admin login will be disabled.");
  }
  if (!process.env.DATABASE_URL) {
    console.warn("\u26A0\uFE0F  DATABASE_URL not set \u2014 database operations will fail.");
  }
  console.log(`\u{1F680} NODE_ENV=${process.env.NODE_ENV || "development"}`);
  console.log(`\u{1F511} JWT_SECRET set: ${!!process.env.JWT_SECRET}`);
  console.log(`\u{1F511} ADMIN_PASSWORD set: ${!!process.env.ADMIN_PASSWORD}`);
  console.log(`\u{1F5C4}\uFE0F  DATABASE_URL set: ${!!process.env.DATABASE_URL}`);
  const port = parseInt(process.env.PORT || "3000", 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true
  }, () => {
    log(`serving on port ${port}`);
  });
})();
