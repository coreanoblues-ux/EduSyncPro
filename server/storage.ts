import { drizzle } from "drizzle-orm/neon-serverless";
import { neon, NeonQueryFunction } from "@neondatabase/serverless";
import { 
  type User, 
  type InsertUser,
  type Tenant,
  type InsertTenant,
  type Student,
  type InsertStudent,
  type Teacher,
  type InsertTeacher,
  type Class,
  type InsertClass,
  type Enrollment,
  type InsertEnrollment,
  type Payment,
  type InsertPayment,
  type LessonLog,
  type InsertLessonLog,
  type Waiter,
  type InsertWaiter,
  users,
  tenants,
  students,
  teachers,
  classes,
  enrollments,
  payments,
  lessonLogs,
  waiters
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

// Database connection
const connectionString = process.env.DATABASE_URL!;
const client: NeonQueryFunction<false, false> = neon(connectionString);
const db = drizzle(client);

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Tenant methods
  getTenant(id: string): Promise<Tenant | undefined>;
  createTenant(tenant: InsertTenant): Promise<Tenant>;
  
  // Student methods
  getStudentsByTenant(tenantId: string): Promise<Student[]>;
  getStudent(id: string): Promise<Student | undefined>;
  createStudent(student: InsertStudent): Promise<Student>;
  updateStudent(id: string, student: Partial<InsertStudent>): Promise<Student>;
  deleteStudent(id: string): Promise<void>;
  
  // Teacher methods
  getTeachersByTenant(tenantId: string): Promise<Teacher[]>;
  getTeacher(id: string): Promise<Teacher | undefined>;
  createTeacher(teacher: InsertTeacher): Promise<Teacher>;
  updateTeacher(id: string, teacher: Partial<InsertTeacher>): Promise<Teacher>;
  deleteTeacher(id: string): Promise<void>;
  
  // Class methods
  getClassesByTenant(tenantId: string): Promise<Class[]>;
  getClass(id: string): Promise<Class | undefined>;
  createClass(cls: InsertClass): Promise<Class>;
  updateClass(id: string, cls: Partial<InsertClass>): Promise<Class>;
  deleteClass(id: string): Promise<void>;
  
  // Enrollment methods
  getEnrollment(id: string): Promise<Enrollment | undefined>;
  getEnrollmentsByStudent(studentId: string): Promise<Enrollment[]>;
  getEnrollmentsByTenant(tenantId: string): Promise<Enrollment[]>;
  createEnrollment(enrollment: InsertEnrollment): Promise<Enrollment>;
  updateEnrollment(id: string, enrollment: Partial<InsertEnrollment>): Promise<Enrollment>;
  deleteEnrollment(id: string): Promise<void>;
  
  // Payment methods
  getPaymentsByEnrollment(enrollmentId: string): Promise<Payment[]>;
  getPaymentsByTenant(tenantId: string): Promise<Payment[]>;
  createPayment(payment: InsertPayment): Promise<Payment>;
  
  // Lesson Log methods
  getLessonLogsByTenant(tenantId: string): Promise<LessonLog[]>;
  getLessonLogsByClass(classId: string): Promise<LessonLog[]>;
  createLessonLog(lessonLog: InsertLessonLog): Promise<LessonLog>;
  
  // Waiter methods
  getWaitersByTenant(tenantId: string): Promise<Waiter[]>;
  getWaitersByClass(classId: string): Promise<Waiter[]>;
  getWaiter(id: string): Promise<Waiter | undefined>;
  createWaiter(waiter: InsertWaiter): Promise<Waiter>;
  deleteWaiter(id: string): Promise<void>;
}

export class DbStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values({
      ...insertUser,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  // Tenant methods
  async getTenant(id: string): Promise<Tenant | undefined> {
    const result = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return result[0];
  }

  async createTenant(insertTenant: InsertTenant): Promise<Tenant> {
    const accountNumber = `AC${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    const result = await db.insert(tenants).values({
      ...insertTenant,
      id: randomUUID(),
      accountNumber,
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  // Student methods
  async getStudentsByTenant(tenantId: string): Promise<Student[]> {
    return await db.select().from(students).where(eq(students.tenantId, tenantId));
  }

  async getStudent(id: string): Promise<Student | undefined> {
    const result = await db.select().from(students).where(eq(students.id, id)).limit(1);
    return result[0];
  }

  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const result = await db.insert(students).values({
      ...insertStudent,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  async updateStudent(id: string, updateData: Partial<InsertStudent>): Promise<Student> {
    const result = await db.update(students)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(students.id, id))
      .returning();
    return result[0];
  }

  async deleteStudent(id: string): Promise<void> {
    await db.update(students)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(students.id, id));
  }

  // Teacher methods
  async getTeachersByTenant(tenantId: string): Promise<Teacher[]> {
    return await db.select().from(teachers).where(eq(teachers.tenantId, tenantId));
  }

  async getTeacher(id: string): Promise<Teacher | undefined> {
    const result = await db.select().from(teachers).where(eq(teachers.id, id)).limit(1);
    return result[0];
  }

  async createTeacher(insertTeacher: InsertTeacher): Promise<Teacher> {
    const result = await db.insert(teachers).values({
      ...insertTeacher,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  async updateTeacher(id: string, updateData: Partial<InsertTeacher>): Promise<Teacher> {
    const result = await db.update(teachers)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(teachers.id, id))
      .returning();
    return result[0];
  }

  async deleteTeacher(id: string): Promise<void> {
    await db.update(teachers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(teachers.id, id));
  }

  // Class methods
  async getClassesByTenant(tenantId: string): Promise<Class[]> {
    return await db.select().from(classes).where(eq(classes.tenantId, tenantId));
  }

  async getClass(id: string): Promise<Class | undefined> {
    const result = await db.select().from(classes).where(eq(classes.id, id)).limit(1);
    return result[0];
  }

  async createClass(insertClass: InsertClass): Promise<Class> {
    const result = await db.insert(classes).values({
      ...insertClass,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  async updateClass(id: string, updateData: Partial<InsertClass>): Promise<Class> {
    const result = await db.update(classes)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(classes.id, id))
      .returning();
    return result[0];
  }

  async deleteClass(id: string): Promise<void> {
    await db.update(classes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(classes.id, id));
  }

  // Enrollment methods
  async getEnrollmentsByStudent(studentId: string): Promise<Enrollment[]> {
    return await db.select().from(enrollments).where(eq(enrollments.studentId, studentId));
  }

  async getEnrollmentsByTenant(tenantId: string): Promise<Enrollment[]> {
    return await db.select().from(enrollments).where(eq(enrollments.tenantId, tenantId));
  }

  async createEnrollment(insertEnrollment: InsertEnrollment): Promise<Enrollment> {
    const result = await db.insert(enrollments).values({
      ...insertEnrollment,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  async updateEnrollment(id: string, updateData: Partial<InsertEnrollment>): Promise<Enrollment> {
    const result = await db.update(enrollments)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(enrollments.id, id))
      .returning();
    return result[0];
  }

  async deleteEnrollment(id: string): Promise<void> {
    await db.update(enrollments)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(enrollments.id, id));
  }

  // Enrollment methods (additional)
  async getEnrollment(id: string): Promise<Enrollment | undefined> {
    const result = await db.select().from(enrollments).where(eq(enrollments.id, id)).limit(1);
    return result[0];
  }

  // Payment methods
  async getPaymentsByEnrollment(enrollmentId: string): Promise<Payment[]> {
    return await db.select().from(payments).where(eq(payments.enrollmentId, enrollmentId));
  }

  async getPaymentsByTenant(tenantId: string): Promise<Payment[]> {
    return await db.select().from(payments).where(eq(payments.tenantId, tenantId));
  }

  async createPayment(insertPayment: InsertPayment): Promise<Payment> {
    const result = await db.insert(payments).values({
      ...insertPayment,
      id: randomUUID(),
      createdAt: new Date()
    }).returning();
    return result[0];
  }

  // Lesson Log methods
  async getLessonLogsByTenant(tenantId: string): Promise<LessonLog[]> {
    return await db.select().from(lessonLogs).where(eq(lessonLogs.tenantId, tenantId));
  }

  async getLessonLogsByClass(classId: string): Promise<LessonLog[]> {
    return await db.select().from(lessonLogs).where(eq(lessonLogs.classId, classId));
  }

  async createLessonLog(insertLessonLog: InsertLessonLog): Promise<LessonLog> {
    const result = await db.insert(lessonLogs).values({
      ...insertLessonLog,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  // Waiter methods
  async getWaitersByTenant(tenantId: string): Promise<Waiter[]> {
    return await db.select().from(waiters).where(eq(waiters.tenantId, tenantId));
  }

  async getWaitersByClass(classId: string): Promise<Waiter[]> {
    return await db.select().from(waiters).where(eq(waiters.classId, classId));
  }

  async getWaiter(id: string): Promise<Waiter | undefined> {
    const result = await db.select().from(waiters).where(eq(waiters.id, id)).limit(1);
    return result[0];
  }

  async createWaiter(insertWaiter: InsertWaiter): Promise<Waiter> {
    const result = await db.insert(waiters).values({
      ...insertWaiter,
      id: randomUUID(),
      createdAt: new Date()
    }).returning();
    return result[0];
  }

  async deleteWaiter(id: string): Promise<void> {
    await db.delete(waiters).where(eq(waiters.id, id));
  }
}

export const storage = new DbStorage();
