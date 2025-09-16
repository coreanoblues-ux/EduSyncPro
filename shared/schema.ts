import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, decimal, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums
export const userRoleEnum = pgEnum("user_role", ["owner", "teacher", "superadmin"]);
export const tenantStatusEnum = pgEnum("tenant_status", ["pending", "active", "expired", "suspended"]);
export const paymentStatusEnum = pgEnum("payment_status", ["paid", "overdue", "pending"]);

// Tenant table (학원)
export const tenants = pgTable("tenants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountNumber: varchar("account_number").notNull().unique(),
  name: text("name").notNull(), // 학원명
  ownerName: text("owner_name").notNull(), // 대표자명
  ownerPhone: text("owner_phone").notNull(), // 대표자 연락처
  status: tenantStatusEnum("status").default("pending").notNull(),
  activeUntil: timestamp("active_until"),
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
  enrollmentId: varchar("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }).notNull(),
  amount: integer("amount").notNull(),
  paymentMonth: text("payment_month").notNull(), // YYYY-MM 형식
  paidDate: timestamp("paid_date").notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
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

// Insert schemas
export const insertTenantSchema = createInsertSchema(tenants).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTeacherSchema = createInsertSchema(teachers).omit({ id: true, createdAt: true, updatedAt: true });
export const insertClassSchema = createInsertSchema(classes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertStudentSchema = createInsertSchema(students).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEnrollmentSchema = createInsertSchema(enrollments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPaymentSchema = createInsertSchema(payments).omit({ id: true, createdAt: true });
export const insertLessonLogSchema = createInsertSchema(lessonLogs).omit({ id: true, createdAt: true, updatedAt: true });
export const insertWaiterSchema = createInsertSchema(waiters).omit({ id: true, createdAt: true });

// Update schemas
export const updateEnrollmentSchema = z.object({
  studentId: z.string().optional(),
  classId: z.string().optional(),
  startDate: z.coerce.date().optional(),
  tuition: z.number().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  endDate: z.coerce.date().optional(),
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

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertTeacher = z.infer<typeof insertTeacherSchema>;
export type InsertClass = z.infer<typeof insertClassSchema>;
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type InsertEnrollment = z.infer<typeof insertEnrollmentSchema>;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type InsertLessonLog = z.infer<typeof insertLessonLogSchema>;
export type InsertWaiter = z.infer<typeof insertWaiterSchema>;
