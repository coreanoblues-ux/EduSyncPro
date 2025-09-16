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
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "./db";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Tenant methods
  getTenant(id: string): Promise<Tenant | undefined>;
  createTenant(tenant: InsertTenant): Promise<Tenant>;
  getAllTenants(): Promise<Tenant[]>;
  updateTenantStatus(id: string, status: 'pending' | 'active' | 'expired' | 'suspended'): Promise<Tenant>;
  deleteTenant(id: string): Promise<void>;
  
  // Student methods
  getStudentsByTenant(tenantId: string): Promise<Student[]>;
  getDashboardStudents(tenantId: string): Promise<any[]>;
  getStudent(id: string): Promise<Student | undefined>;
  createStudent(student: InsertStudent): Promise<Student>;
  updateStudent(id: string, student: Partial<InsertStudent>): Promise<Student>;
  deleteStudent(id: string): Promise<void>;
  deactivateStudent(id: string): Promise<void>;
  activateStudent(id: string): Promise<void>;
  
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

  async getAllTenants(): Promise<Tenant[]> {
    const result = await db.select().from(tenants);
    return result;
  }

  async updateTenantStatus(id: string, status: 'pending' | 'active' | 'expired' | 'suspended'): Promise<Tenant> {
    const result = await db.update(tenants)
      .set({ 
        status, 
        updatedAt: new Date(),
        activeUntil: status === 'active' ? sql`NOW() + INTERVAL '1 year'` : null
      })
      .where(eq(tenants.id, id))
      .returning();
    return result[0];
  }

  async deleteTenant(id: string): Promise<void> {
    // 테넌트와 관련된 모든 데이터 삭제 (cascade)
    // 먼저 관련 데이터들을 삭제해야 함
    await db.delete(lessonLogs).where(eq(lessonLogs.tenantId, id));
    await db.delete(payments).where(eq(payments.tenantId, id));
    await db.delete(enrollments).where(eq(enrollments.tenantId, id));
    await db.delete(waiters).where(eq(waiters.tenantId, id));
    await db.delete(classes).where(eq(classes.tenantId, id));
    await db.delete(students).where(eq(students.tenantId, id));
    await db.delete(teachers).where(eq(teachers.tenantId, id));
    await db.delete(users).where(eq(users.tenantId, id));
    
    // 마지막으로 테넌트 삭제
    await db.delete(tenants).where(eq(tenants.id, id));
  }

  // Student methods
  async getStudentsByTenant(tenantId: string): Promise<Student[]> {
    return await db.select().from(students).where(eq(students.tenantId, tenantId));
  }

  async getDashboardStudents(tenantId: string): Promise<any[]> {
    // 현재 달을 YYYY-MM 형식으로 가져오기
    const currentMonth = new Date().toISOString().slice(0, 7);
    
    // 학생들을 enrollment, class, payment 정보와 함께 조인하고
    // 미납자 우선, 최신 등록순으로 정렬해서 최대 6명만 가져오기
    const result = await db
      .select({
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
      })
      .from(students)
      .leftJoin(enrollments, and(
        eq(enrollments.studentId, students.id),
        eq(enrollments.isActive, true)
      ))
      .leftJoin(classes, eq(classes.id, enrollments.classId))
      .leftJoin(payments, and(
        eq(payments.enrollmentId, enrollments.id),
        eq(payments.paymentMonth, currentMonth)
      ))
      .where(and(
        eq(students.tenantId, tenantId),
        eq(students.isActive, true)
      ))
      .orderBy(
        // 미납자를 우선으로 (hasCurrentPayment가 null인 경우가 먼저)
        sql`CASE WHEN ${payments.id} IS NULL THEN 0 ELSE 1 END`,
        // 그 다음은 최신 등록순
        desc(students.createdAt)
      )
      .limit(6);

    // 확장된 학생 객체로 변환하고 중복 제거
    const studentMap = new Map<string, any>();
    
    for (const row of result) {
      if (!studentMap.has(row.id)) {
        studentMap.set(row.id, {
          // 기본 학생 정보
          id: row.id,
          name: row.name,
          school: row.school || "미설정",
          grade: row.grade || "미설정",
          parentPhone: row.parentPhone || "미설정",
          // 반 정보 (수강시작일 없어도 수업배정되면 배정으로 표시)
          className: row.enrollmentId ? (row.className || "배정") : "미배정",
          // 등록/납부 정보
          dueDay: row.dueDay || 8,
          tuition: row.tuition || row.defaultTuition || 0,
          paymentStatus: row.hasCurrentPayment ? 'paid' : (row.enrollmentId ? 'overdue' : 'pending'),
          // 디버깅 정보
          enrollmentId: row.enrollmentId,
          hasCurrentPayment: !!row.hasCurrentPayment
        });
      }
    }

    return Array.from(studentMap.values());
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
    // 안전한 완전 삭제 - 관련 데이터를 먼저 삭제한 후 학생 삭제
    // Neon HTTP는 트랜잭션을 지원하지 않으므로 순차적으로 삭제
    try {
      // 1. 해당 학생의 수강 등록들을 찾아서 저장
      const studentEnrollments = await db.select({ id: enrollments.id })
        .from(enrollments)
        .where(eq(enrollments.studentId, id));
      
      // 2. 각 수강 등록에 연결된 결제 기록들 삭제
      for (const enrollment of studentEnrollments) {
        await db.delete(payments).where(eq(payments.enrollmentId, enrollment.id));
      }
      
      // 3. 학생의 수강 등록들 삭제
      await db.delete(enrollments).where(eq(enrollments.studentId, id));
      
      // 4. 마지막으로 학생 삭제
      await db.delete(students).where(eq(students.id, id));
      
      // 참고: lessonLogs와 waiters는 classId로 연결되어 학생과 직접 관계없으므로 삭제하지 않음
    } catch (error) {
      console.error('Error deleting student:', error);
      throw new Error('학생 삭제 중 오류가 발생했습니다.');
    }
  }

  async deactivateStudent(id: string): Promise<void> {
    // 휴원 처리 - 비활성화
    await db.update(students)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(students.id, id));
  }

  async activateStudent(id: string): Promise<void> {
    // 재등록 처리 - 활성화
    await db.update(students)
      .set({ isActive: true, updatedAt: new Date() })
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
