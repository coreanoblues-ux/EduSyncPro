import { drizzle } from "drizzle-orm/neon-serverless";
import { neon } from "@neondatabase/serverless";
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
const client = neon(connectionString);
const db = drizzle(client, {
  schema: {
    users,
    tenants,
    students,
    teachers,
    classes,
    enrollments,
    payments,
    lessonLogs,
    waiters
  }
});

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
  createStudent(student: InsertStudent): Promise<Student>;
  
  // Teacher methods
  getTeachersByTenant(tenantId: string): Promise<Teacher[]>;
  createTeacher(teacher: InsertTeacher): Promise<Teacher>;
  
  // Class methods
  getClassesByTenant(tenantId: string): Promise<Class[]>;
  createClass(cls: InsertClass): Promise<Class>;
  
  // Enrollment methods
  getEnrollmentsByStudent(studentId: string): Promise<Enrollment[]>;
  createEnrollment(enrollment: InsertEnrollment): Promise<Enrollment>;
  
  // Payment methods
  getPaymentsByEnrollment(enrollmentId: string): Promise<Payment[]>;
  createPayment(payment: InsertPayment): Promise<Payment>;
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

  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const result = await db.insert(students).values({
      ...insertStudent,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  // Teacher methods
  async getTeachersByTenant(tenantId: string): Promise<Teacher[]> {
    return await db.select().from(teachers).where(eq(teachers.tenantId, tenantId));
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

  // Class methods
  async getClassesByTenant(tenantId: string): Promise<Class[]> {
    return await db.select().from(classes).where(eq(classes.tenantId, tenantId));
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

  // Enrollment methods
  async getEnrollmentsByStudent(studentId: string): Promise<Enrollment[]> {
    return await db.select().from(enrollments).where(eq(enrollments.studentId, studentId));
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

  // Payment methods
  async getPaymentsByEnrollment(enrollmentId: string): Promise<Payment[]> {
    return await db.select().from(payments).where(eq(payments.enrollmentId, enrollmentId));
  }

  async createPayment(insertPayment: InsertPayment): Promise<Payment> {
    const result = await db.insert(payments).values({
      ...insertPayment,
      id: randomUUID(),
      createdAt: new Date()
    }).returning();
    return result[0];
  }
}

export const storage = new DbStorage();
