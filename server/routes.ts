import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import cookieParser from "cookie-parser";
import { storage } from "./storage";
import { 
  generateToken, 
  hashPassword, 
  verifyPassword, 
  authGuard, 
  tenantGuard, 
  roleGuard 
} from "./middleware/auth";
import { 
  insertTenantSchema, 
  insertUserSchema,
  insertStudentSchema,
  insertTeacherSchema,
  insertClassSchema,
  insertEnrollmentSchema,
  insertPaymentSchema,
  insertLessonLogSchema,
  insertWaiterSchema
} from "@shared/schema";
import { z } from "zod";

// Define common schemas for validation
const idParamSchema = z.object({
  id: z.string().uuid("유효하지 않은 ID 형식입니다.")
});

const signupSchema = z.object({
  email: z.string().email("유효한 이메일 주소를 입력해주세요."),
  password: z.string().min(6, "비밀번호는 최소 6자 이상이어야 합니다."),
  name: z.string().min(1, "이름을 입력해주세요."),
  academyName: z.string().min(1, "학원명을 입력해주세요."),
  ownerName: z.string().min(1, "대표자명을 입력해주세요."),
  ownerPhone: z.string().min(1, "대표자 연락처를 입력해주세요.")
});

const signinSchema = z.object({
  email: z.string().email("유효한 이메일 주소를 입력해주세요."),
  password: z.string().min(1, "비밀번호를 입력해주세요.")
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Enable cookie parsing
  app.use(cookieParser());

  // Zod validation middleware
  const validateBody = (schema: z.ZodSchema) => {
    return (req: Request, res: Response, next: any) => {
      try {
        req.body = schema.parse(req.body);
        next();
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ 
            error: "입력 데이터가 올바르지 않습니다.", 
            details: error.errors 
          });
        }
        return res.status(400).json({ error: "입력 데이터 검증 실패" });
      }
    };
  };

  const validateParams = (schema: z.ZodSchema) => {
    return (req: Request, res: Response, next: any) => {
      try {
        req.params = schema.parse(req.params);
        next();
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ 
            error: "매개변수가 올바르지 않습니다.", 
            details: error.errors 
          });
        }
        return res.status(400).json({ error: "매개변수 검증 실패" });
      }
    };
  };

  // Auth Routes
  
  // Sign up - Create new tenant and owner user
  app.post('/api/auth/signup',
    validateBody(signupSchema),
    async (req: Request, res: Response) => {
      try {
        const { email, password, name, academyName, ownerName, ownerPhone } = req.body;
        
        // Check if email already exists
        const existingUser = await storage.getUserByEmail(email);
        if (existingUser) {
          return res.status(409).json({ error: '이미 등록된 이메일 주소입니다.' });
        }

        // Create tenant
        const tenant = await storage.createTenant({
          name: academyName,
          ownerName,
          ownerPhone,
          status: 'pending'
        });

        // Create owner user
        const hashedPassword = await hashPassword(password);
        const user = await storage.createUser({
          tenantId: tenant.id,
          email,
          password: hashedPassword,
          name,
          role: 'owner',
          isActive: true
        });

        const token = generateToken({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId
        });

        // Set HTTP-only cookie
        res.cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        res.status(201).json({
          message: '회원가입이 완료되었습니다. 승인 처리를 위해 관리자에게 문의해주세요.',
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
        console.error('Signup error:', error);
        res.status(500).json({ error: '회원가입 중 오류가 발생했습니다.' });
      }
    }
  );

  // Sign in
  app.post('/api/auth/signin',
    validateBody(signinSchema),
    async (req: Request, res: Response) => {
      try {
        const { email, password } = req.body;
        
        // Find user
        const user = await storage.getUserByEmail(email);
        if (!user) {
          return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }

        // Verify password
        const isValidPassword = await verifyPassword(password, user.password);
        if (!isValidPassword) {
          return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }

        // Check if user is active
        if (!user.isActive) {
          return res.status(403).json({ error: '비활성화된 계정입니다.' });
        }

        const token = generateToken({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId
        });

        // Set HTTP-only cookie
        res.cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        // Get tenant info if exists
        let tenant = null;
        if (user.tenantId) {
          tenant = await storage.getTenant(user.tenantId);
        }

        res.json({
          message: '로그인 성공',
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
        console.error('Signin error:', error);
        res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
      }
    }
  );

  // Sign out
  app.post('/api/auth/signout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: '로그아웃 되었습니다.' });
  });

  // Get current user
  app.get('/api/auth/me', authGuard, async (req, res) => {
    try {
      let tenant = null;
      if (req.user!.tenantId) {
        tenant = await storage.getTenant(req.user!.tenantId);
      }

      res.json({
        user: {
          id: req.user!.id,
          email: req.user!.email,
          name: req.user!.name,
          role: req.user!.role
        },
        tenant: tenant ? {
          id: tenant.id,
          name: tenant.name,
          accountNumber: tenant.accountNumber,
          status: tenant.status
        } : null
      });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ error: '사용자 정보 조회 중 오류가 발생했습니다.' });
    }
  });

  // Student Routes
  app.get('/api/students', authGuard, tenantGuard, async (req, res) => {
    try {
      const students = await storage.getStudentsByTenant(req.user!.tenantId!);
      res.json(students);
    } catch (error) {
      console.error('Get students error:', error);
      res.status(500).json({ error: '학생 목록 조회 중 오류가 발생했습니다.' });
    }
  });

  app.get('/api/students/:id', 
    authGuard, 
    tenantGuard, 
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
        }
        
        // Check if student belongs to current tenant
        if (student.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        res.json(student);
      } catch (error) {
        console.error('Get student error:', error);
        res.status(500).json({ error: '학생 정보 조회 중 오류가 발생했습니다.' });
      }
    }
  );

  app.post('/api/students', 
    authGuard, 
    tenantGuard, 
    roleGuard('owner', 'teacher'),
    validateBody(insertStudentSchema.omit({ tenantId: true, isActive: true })),
    async (req: Request, res: Response) => {
      try {
        const studentData = {
          ...req.body,
          tenantId: req.user!.tenantId!,
          isActive: true
        };

        const student = await storage.createStudent(studentData);
        res.status(201).json(student);
      } catch (error) {
        console.error('Create student error:', error);
        res.status(500).json({ error: '학생 등록 중 오류가 발생했습니다.' });
      }
    }
  );

  app.put('/api/students/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateParams(idParamSchema),
    validateBody(insertStudentSchema.omit({ tenantId: true }).partial()),
    async (req: Request, res: Response) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
        }
        
        if (student.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        const updatedStudent = await storage.updateStudent(req.params.id, req.body);
        res.json(updatedStudent);
      } catch (error) {
        console.error('Update student error:', error);
        res.status(500).json({ error: '학생 정보 수정 중 오류가 발생했습니다.' });
      }
    }
  );

  app.delete('/api/students/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const student = await storage.getStudent(req.params.id);
        if (!student) {
          return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
        }
        
        if (student.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        await storage.deleteStudent(req.params.id);
        res.json({ message: '학생이 삭제되었습니다.' });
      } catch (error) {
        console.error('Delete student error:', error);
        res.status(500).json({ error: '학생 삭제 중 오류가 발생했습니다.' });
      }
    }
  );

  // Teacher Routes
  app.get('/api/teachers', authGuard, tenantGuard, async (req, res) => {
    try {
      const teachers = await storage.getTeachersByTenant(req.user!.tenantId!);
      res.json(teachers);
    } catch (error) {
      console.error('Get teachers error:', error);
      res.status(500).json({ error: '교사 목록 조회 중 오류가 발생했습니다.' });
    }
  });

  app.get('/api/teachers/:id',
    authGuard,
    tenantGuard,
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const teacher = await storage.getTeacher(req.params.id);
        if (!teacher) {
          return res.status(404).json({ error: '교사를 찾을 수 없습니다.' });
        }
        
        if (teacher.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        res.json(teacher);
      } catch (error) {
        console.error('Get teacher error:', error);
        res.status(500).json({ error: '교사 정보 조회 중 오류가 발생했습니다.' });
      }
    }
  );

  app.post('/api/teachers',
    authGuard,
    tenantGuard,
    roleGuard('owner'),
    validateBody(insertTeacherSchema.omit({ tenantId: true, isActive: true })),
    async (req: Request, res: Response) => {
      try {
        const teacherData = {
          ...req.body,
          tenantId: req.user!.tenantId!,
          isActive: true
        };

        const teacher = await storage.createTeacher(teacherData);
        res.status(201).json(teacher);
      } catch (error) {
        console.error('Create teacher error:', error);
        res.status(500).json({ error: '교사 등록 중 오류가 발생했습니다.' });
      }
    }
  );

  app.put('/api/teachers/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner'),
    validateParams(idParamSchema),
    validateBody(insertTeacherSchema.omit({ tenantId: true }).partial()),
    async (req: Request, res: Response) => {
      try {
        const teacher = await storage.getTeacher(req.params.id);
        if (!teacher) {
          return res.status(404).json({ error: '교사를 찾을 수 없습니다.' });
        }
        
        if (teacher.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        const updatedTeacher = await storage.updateTeacher(req.params.id, req.body);
        res.json(updatedTeacher);
      } catch (error) {
        console.error('Update teacher error:', error);
        res.status(500).json({ error: '교사 정보 수정 중 오류가 발생했습니다.' });
      }
    }
  );

  app.delete('/api/teachers/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner'),
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const teacher = await storage.getTeacher(req.params.id);
        if (!teacher) {
          return res.status(404).json({ error: '교사를 찾을 수 없습니다.' });
        }
        
        if (teacher.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        await storage.deleteTeacher(req.params.id);
        res.json({ message: '교사가 삭제되었습니다.' });
      } catch (error) {
        console.error('Delete teacher error:', error);
        res.status(500).json({ error: '교사 삭제 중 오류가 발생했습니다.' });
      }
    }
  );

  // Class Routes
  app.get('/api/classes', authGuard, tenantGuard, async (req, res) => {
    try {
      const classes = await storage.getClassesByTenant(req.user!.tenantId!);
      res.json(classes);
    } catch (error) {
      console.error('Get classes error:', error);
      res.status(500).json({ error: '반 목록 조회 중 오류가 발생했습니다.' });
    }
  });

  app.get('/api/classes/:id',
    authGuard,
    tenantGuard,
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const classItem = await storage.getClass(req.params.id);
        if (!classItem) {
          return res.status(404).json({ error: '반을 찾을 수 없습니다.' });
        }
        
        if (classItem.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        res.json(classItem);
      } catch (error) {
        console.error('Get class error:', error);
        res.status(500).json({ error: '반 정보 조회 중 오류가 발생했습니다.' });
      }
    }
  );

  app.post('/api/classes',
    authGuard,
    tenantGuard,
    roleGuard('owner'),
    validateBody(insertClassSchema.omit({ tenantId: true, isActive: true })),
    async (req: Request, res: Response) => {
      try {
        const classData = {
          ...req.body,
          tenantId: req.user!.tenantId!,
          isActive: true
        };

        const newClass = await storage.createClass(classData);
        res.status(201).json(newClass);
      } catch (error) {
        console.error('Create class error:', error);
        res.status(500).json({ error: '반 생성 중 오류가 발생했습니다.' });
      }
    }
  );

  app.put('/api/classes/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner'),
    validateParams(idParamSchema),
    validateBody(insertClassSchema.omit({ tenantId: true }).partial()),
    async (req: Request, res: Response) => {
      try {
        const classItem = await storage.getClass(req.params.id);
        if (!classItem) {
          return res.status(404).json({ error: '반을 찾을 수 없습니다.' });
        }
        
        if (classItem.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        const updatedClass = await storage.updateClass(req.params.id, req.body);
        res.json(updatedClass);
      } catch (error) {
        console.error('Update class error:', error);
        res.status(500).json({ error: '반 정보 수정 중 오류가 발생했습니다.' });
      }
    }
  );

  app.delete('/api/classes/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner'),
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const classItem = await storage.getClass(req.params.id);
        if (!classItem) {
          return res.status(404).json({ error: '반을 찾을 수 없습니다.' });
        }
        
        if (classItem.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        await storage.deleteClass(req.params.id);
        res.json({ message: '반이 삭제되었습니다.' });
      } catch (error) {
        console.error('Delete class error:', error);
        res.status(500).json({ error: '반 삭제 중 오류가 발생했습니다.' });
      }
    }
  );

  // Enrollment Routes
  app.get('/api/enrollments', authGuard, tenantGuard, async (req, res) => {
    try {
      const enrollments = await storage.getEnrollmentsByTenant(req.user!.tenantId!);
      res.json(enrollments);
    } catch (error) {
      console.error('Get enrollments error:', error);
      res.status(500).json({ error: '수강 등록 목록 조회 중 오류가 발생했습니다.' });
    }
  });

  app.post('/api/enrollments',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateBody(insertEnrollmentSchema.omit({ tenantId: true, isActive: true })),
    async (req: Request, res: Response) => {
      try {
        const enrollmentData = {
          ...req.body,
          tenantId: req.user!.tenantId!,
          isActive: true
        };

        const enrollment = await storage.createEnrollment(enrollmentData);
        res.status(201).json(enrollment);
      } catch (error) {
        console.error('Create enrollment error:', error);
        res.status(500).json({ error: '수강 등록 중 오류가 발생했습니다.' });
      }
    }
  );

  app.put('/api/enrollments/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateParams(idParamSchema),
    validateBody(insertEnrollmentSchema.omit({ tenantId: true }).partial()),
    async (req: Request, res: Response) => {
      try {
        const enrollment = await storage.getEnrollment ? await storage.getEnrollment(req.params.id) : null;
        if (!enrollment) {
          return res.status(404).json({ error: '수강 등록을 찾을 수 없습니다.' });
        }
        
        if (enrollment.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        const updatedEnrollment = await storage.updateEnrollment(req.params.id, req.body);
        res.json(updatedEnrollment);
      } catch (error) {
        console.error('Update enrollment error:', error);
        res.status(500).json({ error: '수강 등록 수정 중 오류가 발생했습니다.' });
      }
    }
  );

  app.delete('/api/enrollments/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const enrollment = await storage.getEnrollment ? await storage.getEnrollment(req.params.id) : null;
        if (!enrollment) {
          return res.status(404).json({ error: '수강 등록을 찾을 수 없습니다.' });
        }
        
        if (enrollment.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        await storage.deleteEnrollment(req.params.id);
        res.json({ message: '수강 등록이 삭제되었습니다.' });
      } catch (error) {
        console.error('Delete enrollment error:', error);
        res.status(500).json({ error: '수강 등록 삭제 중 오류가 발생했습니다.' });
      }
    }
  );

  // Payment Routes
  app.get('/api/payments', authGuard, tenantGuard, async (req, res) => {
    try {
      const payments = await storage.getPaymentsByTenant ? await storage.getPaymentsByTenant(req.user!.tenantId!) : [];
      res.json(payments);
    } catch (error) {
      console.error('Get payments error:', error);
      res.status(500).json({ error: '결제 목록 조회 중 오류가 발생했습니다.' });
    }
  });

  app.post('/api/payments',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateBody(insertPaymentSchema.omit({ tenantId: true, createdBy: true })),
    async (req: Request, res: Response) => {
      try {
        const paymentData = {
          ...req.body,
          tenantId: req.user!.tenantId!,
          createdBy: req.user!.id
        };

        const payment = await storage.createPayment(paymentData);
        res.status(201).json(payment);
      } catch (error) {
        console.error('Create payment error:', error);
        res.status(500).json({ error: '결제 등록 중 오류가 발생했습니다.' });
      }
    }
  );

  // Lesson Log Routes
  app.get('/api/lesson-logs', authGuard, tenantGuard, async (req, res) => {
    try {
      const lessonLogs = await storage.getLessonLogsByTenant ? await storage.getLessonLogsByTenant(req.user!.tenantId!) : [];
      res.json(lessonLogs);
    } catch (error) {
      console.error('Get lesson logs error:', error);
      res.status(500).json({ error: '수업 일지 목록 조회 중 오류가 발생했습니다.' });
    }
  });

  app.post('/api/lesson-logs',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateBody(insertLessonLogSchema.omit({ tenantId: true, createdBy: true })),
    async (req: Request, res: Response) => {
      try {
        const lessonLogData = {
          ...req.body,
          tenantId: req.user!.tenantId!,
          createdBy: req.user!.id
        };

        const lessonLog = await storage.createLessonLog ? await storage.createLessonLog(lessonLogData) : null;
        if (!lessonLog) {
          throw new Error('수업 일지 생성에 실패했습니다.');
        }
        res.status(201).json(lessonLog);
      } catch (error) {
        console.error('Create lesson log error:', error);
        res.status(500).json({ error: '수업 일지 등록 중 오류가 발생했습니다.' });
      }
    }
  );

  // Waiter Routes
  app.get('/api/waiters', authGuard, tenantGuard, async (req, res) => {
    try {
      const waiters = await storage.getWaitersByTenant ? await storage.getWaitersByTenant(req.user!.tenantId!) : [];
      res.json(waiters);
    } catch (error) {
      console.error('Get waiters error:', error);
      res.status(500).json({ error: '대기자 목록 조회 중 오류가 발생했습니다.' });
    }
  });

  app.post('/api/waiters',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateBody(insertWaiterSchema.omit({ tenantId: true })),
    async (req: Request, res: Response) => {
      try {
        const waiterData = {
          ...req.body,
          tenantId: req.user!.tenantId!
        };

        const waiter = await storage.createWaiter ? await storage.createWaiter(waiterData) : null;
        if (!waiter) {
          throw new Error('대기자 등록에 실패했습니다.');
        }
        res.status(201).json(waiter);
      } catch (error) {
        console.error('Create waiter error:', error);
        res.status(500).json({ error: '대기자 등록 중 오류가 발생했습니다.' });
      }
    }
  );

  app.delete('/api/waiters/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        const waiter = await storage.getWaiter ? await storage.getWaiter(req.params.id) : null;
        if (!waiter) {
          return res.status(404).json({ error: '대기자를 찾을 수 없습니다.' });
        }
        
        if (waiter.tenantId !== req.user!.tenantId) {
          return res.status(403).json({ error: '접근 권한이 없습니다.' });
        }

        await storage.deleteWaiter ? await storage.deleteWaiter(req.params.id) : null;
        res.json({ message: '대기자가 삭제되었습니다.' });
      } catch (error) {
        console.error('Delete waiter error:', error);
        res.status(500).json({ error: '대기자 삭제 중 오류가 발생했습니다.' });
      }
    }
  );

  const httpServer = createServer(app);
  return httpServer;
}