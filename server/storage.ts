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
  type Consultation,
  type InsertConsultation,
  type Task,
  type InsertTask,
  type AiAuditLog,
  type InsertAiAuditLog,
  type LevelTest,
  type InsertLevelTest,
  users,
  tenants,
  students,
  teachers,
  classes,
  enrollments,
  payments,
  lessonLogs,
  waiters,
  consultations,
  tasks,
  aiAuditLogs,
  levelTests,
} from "@shared/schema";
import { eq, and, sql, desc, isNull, isNotNull, gt, lt, ilike } from "drizzle-orm";
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
  /**
   * 학부모 눈에 닿는 학원 정보 두 칸(이름 · 결과지 전화번호)만 고친다.
   *
   * 매개변수 타입이 Partial<Tenant> 가 아니라 **두 칸짜리 전용 타입**인 것이
   * 핵심이다. 상태(status)·활성기한(activeUntil)·대표자는 결제 권한과 이어진
   * 칸이라 "학원 이름 고치기" 버튼이 거기까지 닿을 자리를 만들면 안 된다.
   * 그래서 일반적인 updateTenant(부분 수정) 를 끝내 만들지 않는다.
   */
  updateTenantProfile(
    id: string,
    patch: { name?: string; sharePhone?: string | null }
  ): Promise<Tenant | undefined>;
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
  getTeacherByUserId(userId: string): Promise<Teacher | undefined>;
  createTeacher(teacher: InsertTeacher): Promise<Teacher>;
  updateTeacher(id: string, teacher: Partial<InsertTeacher>): Promise<Teacher>;
  deleteTeacher(id: string): Promise<void>;
  deleteUser(id: string): Promise<void>;
  
  // Class methods
  getClassesByTenant(tenantId: string): Promise<Class[]>;
  /** 자연어 반 매칭용 — 요일·강사명으로 반을 좁히려면 강사 이름이 함께 필요하다 */
  getClassesWithTeacher(
    tenantId: string
  ): Promise<Array<{ id: string; name: string; schedule: string; teacherName: string | null }>>;
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
  deleteLessonLog(id: string): Promise<void>;
  
  // Waiter methods
  getWaitersByTenant(tenantId: string): Promise<Waiter[]>;
  getWaitersByClass(classId: string): Promise<Waiter[]>;
  getWaiter(id: string): Promise<Waiter | undefined>;
  createWaiter(waiter: InsertWaiter): Promise<Waiter>;
  deleteWaiter(id: string): Promise<void>;

  // Consultation methods
  getConsultationsByTenant(tenantId: string): Promise<Consultation[]>;
  getConsultation(id: string): Promise<Consultation | undefined>;
  createConsultation(consultation: InsertConsultation): Promise<Consultation>;
  updateConsultation(id: string, consultation: Partial<InsertConsultation>): Promise<Consultation>;
  deleteConsultation(id: string): Promise<void>;

  // LevelTest methods (레벨테스트 결과지 기록)
  /**
   * 목록용. raw_state 는 일부러 빼고 읽는다 — 결과지 원본이 한 건에 수십 KB라
   * 목록에 다 실으면 화면이 수 MB를 받는다. 재출력이 필요할 때만 getLevelTest 로
   * 한 건씩 가져온다.
   */
  getLevelTestsByTenant(tenantId: string): Promise<Array<Omit<LevelTest, "rawState">>>;
  getLevelTest(id: string, tenantId: string): Promise<LevelTest | undefined>;
  /** 같은 (tenantId, clientRecordId) 면 새 행이 아니라 덮어쓴다 */
  upsertLevelTest(levelTest: InsertLevelTest): Promise<LevelTest>;
  deleteLevelTest(id: string, tenantId: string): Promise<void>;

  // 학부모용 결과지 링크 (3층). 규칙은 server/lib/shareLink.ts 참조.
  issueLevelTestShare(
    id: string,
    tenantId: string,
    share: { token: string; expiresAt: Date }
  ): Promise<LevelTest | undefined>;
  revokeLevelTestShare(id: string, tenantId: string): Promise<LevelTest | undefined>;
  /** 공개 주소 전용. 토큰이 신원이므로 tenantId 를 받지 않는다. */
  getLevelTestByShareToken(token: string): Promise<LevelTest | undefined>;
  recordLevelTestShareView(id: string): Promise<void>;
  /** 발급일이 before 보다 오래된 링크의 토큰 값을 지운다. 지운 건수를 돌려준다. */
  purgeExpiredShareTokens(before: Date): Promise<number>;

  // Task methods (퇴근전 할 일)
  getTasksByTenant(tenantId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(task: InsertTask): Promise<Task>;
  updateTask(id: string, patch: Partial<InsertTask>): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  // 자연어 입력 지원
  findStudentsByName(tenantId: string, name: string): Promise<Student[]>;
  findStudentsByPartialName(tenantId: string, name: string): Promise<Student[]>;
  getActiveEnrollmentsWithClass(
    tenantId: string,
    studentId: string
  ): Promise<Array<Enrollment & { className: string; classSubject: string; defaultTuition: number }>>;

  // AI audit log
  createAiAuditLog(log: InsertAiAuditLog): Promise<AiAuditLog>;
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

  /**
   * 학부모 눈에 닿는 학원 정보. name · share_phone 두 칸만 쓴다.
   *
   * ⚠️ set 에 들어가는 칸을 늘리지 말 것. 아래 세 줄이 전부여야 한다.
   *    여기에 status/activeUntil 이 끼면 "학원 정보 저장" 버튼이 학원의
   *    결제 상태까지 바꿀 수 있게 된다. 테스트가 이 사실을 글자로 확인한다.
   *
   * patch 에 들어온 칸만 쓴다 — 전화번호만 보냈는데 이름이 undefined 로
   * 덮이는 일이 없게 한다.
   */
  async updateTenantProfile(
    id: string,
    patch: { name?: string; sharePhone?: string | null }
  ): Promise<Tenant | undefined> {
    const set: { name?: string; sharePhone?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.sharePhone !== undefined) set.sharePhone = patch.sharePhone;

    const result = await db.update(tenants)
      .set(set)
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
        eq(payments.paymentMonth, currentMonth),
        // 환불(음수)·지출은 납부 실적이 아니므로 제외한다
        gt(payments.amount, 0)
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

  async getTeacherByUserId(userId: string): Promise<Teacher | undefined> {
    const result = await db.select().from(teachers).where(eq(teachers.userId, userId)).limit(1);
    return result[0];
  }

  async deleteUser(id: string): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
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
    const teacher = await this.getTeacher(id);
    if (teacher && !teacher.isActive) {
      await db.delete(teachers).where(eq(teachers.id, id));
    } else {
      await db.update(teachers)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(teachers.id, id));
    }
  }

  // Class methods
  async getClassesByTenant(tenantId: string): Promise<Class[]> {
    return await db.select().from(classes).where(eq(classes.tenantId, tenantId));
  }

  async getClassesWithTeacher(
    tenantId: string
  ): Promise<Array<{ id: string; name: string; schedule: string; teacherName: string | null }>> {
    return await db
      .select({
        id: classes.id,
        name: classes.name,
        schedule: classes.schedule,
        teacherName: teachers.name,
      })
      .from(classes)
      .leftJoin(teachers, eq(classes.teacherId, teachers.id))
      .where(eq(classes.tenantId, tenantId));
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
    const classItem = await this.getClass(id);
    if (classItem && !classItem.isActive) {
      // Already inactive → hard delete
      await db.delete(classes).where(eq(classes.id, id));
    } else {
      // Active → soft delete (deactivate)
      await db.update(classes)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(classes.id, id));
    }
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

  async deleteLessonLog(id: string): Promise<void> {
    await db.delete(lessonLogs).where(eq(lessonLogs.id, id));
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

  // Consultation methods
  async getConsultationsByTenant(tenantId: string): Promise<Consultation[]> {
    return await db
      .select()
      .from(consultations)
      .where(eq(consultations.tenantId, tenantId))
      .orderBy(desc(consultations.createdAt));
  }

  async getConsultation(id: string): Promise<Consultation | undefined> {
    const result = await db.select().from(consultations).where(eq(consultations.id, id)).limit(1);
    return result[0];
  }

  async createConsultation(insert: InsertConsultation): Promise<Consultation> {
    const result = await db.insert(consultations).values({
      ...insert,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  async updateConsultation(id: string, patch: Partial<InsertConsultation>): Promise<Consultation> {
    const result = await db.update(consultations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(consultations.id, id))
      .returning();
    return result[0];
  }

  async deleteConsultation(id: string): Promise<void> {
    await db.delete(consultations).where(eq(consultations.id, id));
  }

  // LevelTest methods (레벨테스트 결과지 기록)
  async getLevelTestsByTenant(tenantId: string): Promise<Array<Omit<LevelTest, "rawState">>> {
    // raw_state 제외. 칼럼을 하나하나 적는 이유는 위 인터페이스 주석 참조.
    return await db
      .select({
        id: levelTests.id,
        tenantId: levelTests.tenantId,
        studentName: levelTests.studentName,
        school: levelTests.school,
        grade: levelTests.grade,
        parentPhone: levelTests.parentPhone,
        consultationId: levelTests.consultationId,
        studentId: levelTests.studentId,
        testDate: levelTests.testDate,
        examCode: levelTests.examCode,
        examTitle: levelTests.examTitle,
        totalScore: levelTests.totalScore,
        readingScore: levelTests.readingScore,
        grammarScore: levelTests.grammarScore,
        vocabScore: levelTests.vocabScore,
        writingScore: levelTests.writingScore,
        questionCount: levelTests.questionCount,
        correctCount: levelTests.correctCount,
        pendingCount: levelTests.pendingCount,
        skippedCount: levelTests.skippedCount,
        teacherName: levelTests.teacherName,
        notes: levelTests.notes,
        clientRecordId: levelTests.clientRecordId,
        // 학부모용 링크 상태. 원장 화면이 "링크 있음 / 몇 번 열어 봄 / 끊김" 을
        // 추가 요청 없이 그리려고 목록에 같이 싣는다. 이 응답은 로그인한
        // 원장·강사에게만 간다(roleGuard). 공개 주소는 이 칼럼을 쓰지 않는다.
        shareToken: levelTests.shareToken,
        shareCreatedAt: levelTests.shareCreatedAt,
        shareExpiresAt: levelTests.shareExpiresAt,
        shareRevokedAt: levelTests.shareRevokedAt,
        shareViewCount: levelTests.shareViewCount,
        shareLastViewedAt: levelTests.shareLastViewedAt,
        createdBy: levelTests.createdBy,
        createdAt: levelTests.createdAt,
        updatedAt: levelTests.updatedAt,
      })
      .from(levelTests)
      .where(eq(levelTests.tenantId, tenantId))
      .orderBy(desc(levelTests.testDate), desc(levelTests.createdAt));
  }

  async getLevelTest(id: string, tenantId: string): Promise<LevelTest | undefined> {
    // tenantId 를 WHERE 에 같이 넣는다. id 만으로 찾으면 다른 학원의 기록 id 를
    // 주워 넣었을 때 남의 학생 성적이 그대로 넘어간다.
    const result = await db
      .select()
      .from(levelTests)
      .where(and(eq(levelTests.id, id), eq(levelTests.tenantId, tenantId)))
      .limit(1);
    return result[0];
  }

  /**
   * 레벨테스트 저장. (tenantId, clientRecordId) 가 같으면 덮어쓴다.
   *
   * 앱은 채점 도중에도 저장을 여러 번 누른다. 그때마다 행이 쌓이면 한 학생의
   * 한 회차가 열 줄이 되므로, 엑셀 누적 저장이 하던 것과 같이 "같은 회차는 한 줄"
   * 로 만든다. 충돌 대상 인덱스는
   * scripts/migrate-add-level-test-records.ts 의
   * level_tests_tenant_client_record_uniq 다.
   *
   * createdAt / createdBy 는 덮어쓰지 않는다 — 처음 치른 시각이 사실이다.
   *
   * ⚠️ 아래 set 을 `...insert` 로 줄이지 말 것.
   *   칼럼을 하나하나 적는 것이 이 함수의 안전장치다. 특히 share* (학부모용
   *   링크) 칸이 빠져 있는 것은 의도된 것이다 — 선생님이 미채점 문항을 채워
   *   다시 저장할 때마다 이미 보낸 학부모 링크가 죽으면 안 되고, 열어 본 횟수
   *   기록도 0 으로 돌아가면 안 된다. `...insert` 로 바꾸면 그 사고가 조용히
   *   생긴다 (링크 칸은 본문으로 받지도 않으므로 전부 null 로 덮인다).
   *   테스트가 이 사실을 고정하고 있다: npm run test:share
   */
  async upsertLevelTest(insert: InsertLevelTest): Promise<LevelTest> {
    const now = new Date();
    const result = await db
      .insert(levelTests)
      .values({
        ...insert,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [levelTests.tenantId, levelTests.clientRecordId],
        set: {
          studentName: insert.studentName,
          school: insert.school ?? null,
          grade: insert.grade ?? null,
          parentPhone: insert.parentPhone ?? null,
          consultationId: insert.consultationId ?? null,
          studentId: insert.studentId ?? null,
          testDate: insert.testDate,
          examCode: insert.examCode,
          examTitle: insert.examTitle,
          totalScore: insert.totalScore ?? null,
          readingScore: insert.readingScore ?? null,
          grammarScore: insert.grammarScore ?? null,
          vocabScore: insert.vocabScore ?? null,
          writingScore: insert.writingScore ?? null,
          questionCount: insert.questionCount ?? null,
          correctCount: insert.correctCount ?? null,
          pendingCount: insert.pendingCount ?? null,
          skippedCount: insert.skippedCount ?? null,
          teacherName: insert.teacherName ?? null,
          notes: insert.notes ?? null,
          rawState: insert.rawState ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return result[0];
  }

  async deleteLevelTest(id: string, tenantId: string): Promise<void> {
    await db
      .delete(levelTests)
      .where(and(eq(levelTests.id, id), eq(levelTests.tenantId, tenantId)));
  }

  // ─── 학부모용 결과지 링크 (3층) ──────────────────────────────────────────
  // 규칙과 판단 근거는 server/lib/shareLink.ts 에 모아 뒀다.

  /**
   * 링크 발급(또는 재발급). tenantId 를 WHERE 에 넣어 남의 학원 기록에
   * 링크를 달 수 없게 한다.
   *
   * 재발급하면 이전 토큰은 그 즉시 못 쓰게 된다(칼럼을 덮어쓰므로).
   * 그래서 화면은 "이미 링크가 있으면 새로 만들지 않고 그대로 보여 준다" —
   * 원장이 복사하려고 누른 것 때문에 학부모가 받은 링크가 죽으면 안 된다.
   */
  async issueLevelTestShare(
    id: string,
    tenantId: string,
    share: { token: string; expiresAt: Date }
  ): Promise<LevelTest | undefined> {
    const now = new Date();
    const result = await db
      .update(levelTests)
      .set({
        shareToken: share.token,
        shareCreatedAt: now,
        shareExpiresAt: share.expiresAt,
        // 새로 발급하면 "끊긴 상태" 를 푼다. 열어 본 횟수는 0 으로 돌린다 —
        // 새 링크에 대한 횟수여야 "아직 안 봤다" 가 사실이 된다.
        shareRevokedAt: null,
        shareViewCount: 0,
        shareLastViewedAt: null,
      })
      .where(and(eq(levelTests.id, id), eq(levelTests.tenantId, tenantId)))
      .returning();
    return result[0];
  }

  /**
   * 링크 끊기.
   *
   * 토큰 칼럼을 null 로 비우지 않고 끊은 시각만 적는다. 그래야 원장이
   * "끊어 둔 링크였다" 를 나중에도 구별할 수 있고, 같은 토큰이 되살아나는
   * 일도 없다(되살리려면 재발급 = 새 토큰).
   */
  async revokeLevelTestShare(id: string, tenantId: string): Promise<LevelTest | undefined> {
    const result = await db
      .update(levelTests)
      .set({ shareRevokedAt: new Date() })
      .where(and(eq(levelTests.id, id), eq(levelTests.tenantId, tenantId)))
      .returning();
    return result[0];
  }

  /**
   * 토큰으로 한 건 찾기. **공개 주소(/r/:token)가 쓰는 유일한 조회다.**
   *
   * tenantId 를 받지 않는다 — 받을 수가 없다. 학부모는 로그인하지 않으므로
   * 어느 학원인지 말해 줄 주체가 없고, 주소에서 받으면 그 값을 공격자가 고른다.
   * 토큰 자체가 32바이트 난수라 그것이 곧 신원이다.
   *
   * 만료·해지 판단은 여기서 하지 않고 라우터가 한다. 그래야 "만료됐다" 와
   * "그런 링크 없다" 를 구별해 학부모에게 다른 안내를 보여 줄 수 있다.
   */
  async getLevelTestByShareToken(token: string): Promise<LevelTest | undefined> {
    // 빈 문자열을 그냥 넘기면 share_token 이 NULL 이 아닌 아무 행에나 걸릴
    // 위험을 코드 읽는 사람이 매번 확인해야 한다. 여기서 끊는다.
    if (!token) return undefined;
    const result = await db
      .select()
      .from(levelTests)
      .where(eq(levelTests.shareToken, token))
      .limit(1);
    return result[0];
  }

  /**
   * 학부모가 열어 본 사실을 적는다.
   *
   * id 로만 찾는다(토큰 조회로 이미 그 행을 특정했다). 횟수는 DB 안에서
   * +1 한다 — 읽어서 더해 쓰면 학부모가 두 기기에서 동시에 열 때 하나가 묻힌다.
   */
  async recordLevelTestShareView(id: string): Promise<void> {
    await db
      .update(levelTests)
      .set({
        shareViewCount: sql`${levelTests.shareViewCount} + 1`,
        shareLastViewedAt: new Date(),
      })
      .where(eq(levelTests.id, id));
  }

  /**
   * 오래된 링크 토큰을 지운다(파기). 지운 건수를 돌려준다.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ⚠️ 이 함수는 **스스로 자료를 지우는** 유일한 레벨테스트 코드다.
   *    고치기 전에 아래 네 줄을 반드시 읽을 것.
   * ════════════════════════════════════════════════════════════════════════
   *   1) **UPDATE 다.** db.delete 를 쓰지 않는다. 행을 지우는 일은 절대 없다.
   *   2) **단 한 칸만 NULL 로 만든다** — share_token. 점수·이름·메모·발급일·
   *      열어 본 횟수는 건드리지 않는다. set 에 칸을 더하지 말 것.
   *   3) **이미 토큰이 있는 행만** 고른다(isNotNull). 토큰이 없는 행은
   *      조건에서 빠지므로 아무 일도 일어나지 않는다.
   *   4) **발급일이 적혀 있고, 그게 기준보다 오래된 행만** 고른다.
   *      share_created_at 이 NULL 이면 비교가 NULL 이 되어 안 걸린다 —
   *      즉 "모르겠으면 지우지 않는다" 쪽으로 실패한다. 의도한 것이다.
   *
   *   테스트가 이 네 가지를 글자로 확인한다: npm run test:share
   */
  async purgeExpiredShareTokens(before: Date): Promise<number> {
    const result = await db
      .update(levelTests)
      .set({ shareToken: null })
      .where(
        and(
          isNotNull(levelTests.shareToken),
          isNotNull(levelTests.shareCreatedAt),
          lt(levelTests.shareCreatedAt, before)
        )
      )
      .returning({ id: levelTests.id });
    return result.length;
  }

  // Task methods (퇴근전 할 일)
  async getTasksByTenant(tenantId: string): Promise<Task[]> {
    return await db.select().from(tasks).where(eq(tasks.tenantId, tenantId));
  }

  async getTask(id: string): Promise<Task | undefined> {
    const result = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return result[0];
  }

  async createTask(insert: InsertTask): Promise<Task> {
    const result = await db.insert(tasks).values({
      ...insert,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return result[0];
  }

  async updateTask(id: string, patch: Partial<InsertTask>): Promise<Task> {
    const result = await db.update(tasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    return result[0];
  }

  async deleteTask(id: string): Promise<void> {
    await db.delete(tasks).where(eq(tasks.id, id));
  }

  // 자연어 입력 지원 — 이름으로 학생 찾기
  /**
   * 이름이 정확히 일치하는 활성 학생을 찾는다.
   * 동명이인이 있을 수 있으므로 배열을 반환하고, 판단은 호출자(=원장 확인 UI)에 맡긴다.
   */
  async findStudentsByName(tenantId: string, name: string): Promise<Student[]> {
    return await db
      .select()
      .from(students)
      .where(and(
        eq(students.tenantId, tenantId),
        eq(students.name, name),
        eq(students.isActive, true)
      ));
  }

  /**
   * 이름의 일부만으로 활성 학생을 찾는다. ("김민" → 김민준, 김민서)
   *
   * 원장이 급할 때 성만 치거나 이름 뒤 두 글자만 치는 것을 받아내기 위한 것이다.
   * 정확히 일치하는 학생을 앞에 세워서, 완전한 이름을 친 사람이 부분 일치 결과에
   * 묻히지 않게 한다.
   */
  async findStudentsByPartialName(tenantId: string, name: string): Promise<Student[]> {
    const term = name.trim();
    if (term.length < 2) return [];
    // LIKE 와일드카드가 이름에 섞여 들어오면 엉뚱한 학생까지 걸린다
    const escaped = term.replace(/[\\%_]/g, (ch) => "\\" + ch);

    const rows = await db
      .select()
      .from(students)
      .where(and(
        eq(students.tenantId, tenantId),
        ilike(students.name, `%${escaped}%`),
        eq(students.isActive, true)
      ));

    return rows.sort((a, b) => {
      const exact = (s: Student) => (s.name === term ? 0 : 1);
      return exact(a) - exact(b) || a.name.localeCompare(b.name, "ko");
    });
  }

  /**
   * 학생의 활성 수강 등록 목록을 반 정보와 함께 반환한다.
   * 자연어 수납 입력에서 enrollmentId를 확정하기 위해 쓰인다.
   * 학생이 두 반을 들으면 결과가 2건이 되고, 그때는 원장이 직접 골라야 한다.
   */
  async getActiveEnrollmentsWithClass(
    tenantId: string,
    studentId: string
  ): Promise<Array<Enrollment & { className: string; classSubject: string; defaultTuition: number }>> {
    const rows = await db
      .select({
        enrollment: enrollments,
        className: classes.name,
        classSubject: classes.subject,
        defaultTuition: classes.defaultTuition,
      })
      .from(enrollments)
      .innerJoin(classes, eq(enrollments.classId, classes.id))
      .where(and(
        eq(enrollments.tenantId, tenantId),
        eq(enrollments.studentId, studentId),
        eq(enrollments.isActive, true)
      ));

    return rows.map((r) => ({
      ...r.enrollment,
      className: r.className,
      classSubject: r.classSubject,
      defaultTuition: r.defaultTuition,
    }));
  }

  // AI audit log
  async createAiAuditLog(log: InsertAiAuditLog): Promise<AiAuditLog> {
    const result = await db.insert(aiAuditLogs).values(log).returning();
    return result[0];
  }
}

export const storage = new DbStorage();
