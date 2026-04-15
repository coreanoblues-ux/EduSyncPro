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
  enrollments: () => enrollments,
  enrollmentsRelations: () => enrollmentsRelations,
  insertClassSchema: () => insertClassSchema,
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
  paymentStatusEnum: () => paymentStatusEnum,
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
  enrollmentId: varchar("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }).notNull(),
  amount: integer("amount").notNull(),
  paymentMonth: text("payment_month").notNull(),
  // YYYY-MM 형식
  paidDate: timestamp("paid_date").notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull()
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
import { eq, and, sql as sql2, desc } from "drizzle-orm";
import { randomUUID } from "crypto";

// server/db.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?"
  );
}
var pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});
var db = drizzle(pool, { schema: schema_exports });

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
      eq(payments.paymentMonth, currentMonth)
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
};
var storage = new DbStorage();

// server/middleware/auth.ts
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
var JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-for-academy";
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
    const token = req.cookies.token || req.headers.authorization?.replace("Bearer ", "");
    console.log("\u{1F512} AuthGuard: token exists:", !!token);
    console.log("\u{1F512} AuthGuard: token length:", token?.length || 0);
    if (!token) {
      return res.status(401).json({ error: "\uC778\uC99D \uD1A0\uD070\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log("\u{1F512} AuthGuard: decoded user:", { id: decoded.id, role: decoded.role, email: decoded.email });
    if (decoded.role === "superadmin" && decoded.id === "admin") {
      console.log("\u{1F512} AuthGuard: Superadmin detected - allowing access");
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
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uC0AC\uC6A9\uC790\uC785\uB2C8\uB2E4." });
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
    console.error("\u{1F512} AuthGuard error:", error);
    return res.status(401).json({ error: "\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uD1A0\uD070\uC785\uB2C8\uB2E4." });
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

// server/routes.ts
import { z as z2 } from "zod";
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
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("ADMIN_PASSWORD environment variable must be set for security. No default password allowed.");
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
        if (password !== adminPassword) {
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
        res.cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 7 * 24 * 60 * 60 * 1e3
          // 7 days
        });
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
        res.cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 7 * 24 * 60 * 60 * 1e3
          // 7 days
        });
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
          res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 7 * 24 * 60 * 60 * 1e3
            // 7 days
          });
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
        const user = await storage.getUserByEmail(email);
        if (!user) {
          return res.status(401).json({ error: "\uC774\uBA54\uC77C \uB610\uB294 \uBE44\uBC00\uBC88\uD638\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
        }
        const isValidPassword = await verifyPassword(password, user.password);
        if (!isValidPassword) {
          return res.status(401).json({ error: "\uC774\uBA54\uC77C \uB610\uB294 \uBE44\uBC00\uBC88\uD638\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
        }
        if (!user.isActive) {
          return res.status(403).json({ error: "\uBE44\uD65C\uC131\uD654\uB41C \uACC4\uC815\uC785\uB2C8\uB2E4." });
        }
        const token = generateToken({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId
        });
        res.cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 7 * 24 * 60 * 60 * 1e3
          // 7 days
        });
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
    validateBody(insertPaymentSchema.omit({ tenantId: true, createdBy: true })),
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
  const httpServer = createServer(app2);
  return httpServer;
}

// server/vite.ts
import express from "express";
import fs from "fs";
import path2 from "path";
import { createServer as createViteServer, createLogger } from "vite";

// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
var vite_config_default = defineConfig({
  plugins: [
    react()
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
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
        import.meta.dirname,
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
  const distPath = path2.resolve(import.meta.dirname, "public");
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
    res.status(status).json({ message });
    throw err;
  });
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true
  }, () => {
    log(`serving on port ${port}`);
  });
})();
