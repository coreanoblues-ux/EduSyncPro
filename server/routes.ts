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
  insertWaiterSchema,
  updateEnrollmentSchema
} from "@shared/schema";
import { z } from "zod";

// Define common schemas for validation
const idParamSchema = z.object({
  id: z.string().uuid("유효하지 않은 ID 형식입니다.")
});

// For tenant IDs that might not be UUID format
const tenantIdParamSchema = z.object({
  id: z.string().min(1, "테넌트 ID가 필요합니다.")
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

const teacherSignupSchema = z.object({
  academyEmail: z.string().email("학원 이메일을 입력해주세요."),
  email: z.string().email("유효한 이메일 주소를 입력해주세요."),
  password: z.string().min(6, "비밀번호는 최소 6자 이상이어야 합니다."),
  name: z.string().min(1, "이름을 입력해주세요."),
  subject: z.string().min(1, "담당 과목을 입력해주세요."),
  phone: z.string().optional()
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
          console.error('🚨 Validation Error:', JSON.stringify(error.errors, null, 2));
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

  // ─── Cookie helper — shared across ALL login endpoints ─────────────────
  // sameSite: 'lax'  → allows cookies after top-level navigations / link clicks
  //                     (Railway reverse-proxy + HTTPS works correctly with lax)
  // secure: true in production because Railway serves HTTPS (trust proxy is set)
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  };

  // CRITICAL: Admin login route - MUST be registered FIRST to avoid Vite interference
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    // ⚠ Warn but do NOT crash — missing env var disables admin login, it does NOT
    //   take down the entire app.  The user will see a clear 503 on the admin route.
    console.warn('⚠️  ADMIN_PASSWORD is not set — admin login is disabled. Set it in Railway Variables!');
  }
  
  app.post('/api/auth/admin-login',
    validateBody(z.object({
      password: z.string()
    })),
    async (req: Request, res: Response) => {
      try {
        const { password } = req.body;

        console.log('🔧 Admin login attempt received');
        console.log('🔧 ADMIN_PASSWORD configured:', !!adminPassword);

        // If env var was never set, return a clear error (don't crash)
        if (!adminPassword) {
          console.error('❌ Admin login failed: ADMIN_PASSWORD env var is not set');
          return res.status(503).json({ error: 'ADMIN_PASSWORD 환경변수가 설정되지 않았습니다. Railway Variables에서 설정해주세요.' });
        }

        if (password !== adminPassword) {
          console.warn('⚠️  Admin login: wrong password attempt');
          return res.status(401).json({ error: '잘못된 관리자 비밀번호입니다.' });
        }

        // Create admin user token
        const token = generateToken({
          id: 'admin',
          email: 'admin@system.local',
          name: '시스템 관리자',
          role: 'superadmin',
          tenantId: null
        });

        console.log('🔧 Admin token generated:', token ? 'SUCCESS' : 'FAILED');
        console.log('🔧 Setting cookie with token length:', token?.length || 0);

        // Set HTTP-only cookie (using shared cookieOptions with sameSite: 'lax')
        res.cookie('token', token, cookieOptions);

        console.log('🔧 Admin login cookie set successfully');

        res.json({
          message: '관리자 로그인 성공',
          user: {
            id: 'admin',
            email: 'admin@system.local',
            name: '시스템 관리자',
            role: 'superadmin',
            tenantId: null
          }
        });
      } catch (error) {
        console.error('❌ Admin login error:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
      }
    }
  );

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

        // Create tenant with unique account number
        const accountNumber = `AC${Date.now()}`;
        const tenant = await storage.createTenant({
          name: academyName,
          accountNumber,
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

        // Set HTTP-only cookie (sameSite: 'lax' for Railway compatibility)
        res.cookie('token', token, cookieOptions);

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

  // Teacher sign up - Join existing academy
  app.post('/api/auth/signup/teacher',
    validateBody(teacherSignupSchema),
    async (req: Request, res: Response) => {
      try {
        const { academyEmail, email, password, name, subject, phone } = req.body;
        
        // Check if teacher email already exists
        let existingUser = await storage.getUserByEmail(email);
        if (existingUser) {
          // Check if this user has a teacher record — if so, truly already registered
          const existingTeacher = await storage.getTeacherByUserId(existingUser.id);
          if (existingTeacher) {
            return res.status(409).json({ error: '이미 등록된 이메일 주소입니다.' });
          }
          // Orphaned user from a failed previous attempt — clean up and retry
          await storage.deleteUser(existingUser.id);
          existingUser = undefined;
        }

        // Find the academy owner by email to get tenant
        const ownerUser = await storage.getUserByEmail(academyEmail);
        if (!ownerUser || ownerUser.role !== 'owner') {
          return res.status(404).json({ error: '해당 학원을 찾을 수 없습니다.' });
        }

        if (!ownerUser.tenantId) {
          return res.status(400).json({ error: '학원 정보가 올바르지 않습니다.' });
        }

        // Get tenant to check if it exists and is valid
        const tenant = await storage.getTenant(ownerUser.tenantId);
        if (!tenant) {
          return res.status(404).json({ error: '학원을 찾을 수 없습니다.' });
        }

        // Create teacher user (pending approval like academy owner)
        const hashedPassword = await hashPassword(password);
        const isTeacherActive = tenant.status === 'active';
        const user = await storage.createUser({
          tenantId: tenant.id,
          email,
          password: hashedPassword,
          name,
          role: 'teacher',
          isActive: isTeacherActive // Active only if academy is already approved
        });

        // Create teacher record — if this fails, clean up the user we just created
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
          // Rollback: delete the user we just created
          await storage.deleteUser(user.id);
          throw teacherError;
        }

        // Only issue JWT token if user is active (academy is approved)
        if (isTeacherActive) {
          const token = generateToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            tenantId: user.tenantId
          });

          // Set HTTP-only cookie only for active teachers (sameSite: 'lax')
          res.cookie('token', token, cookieOptions);
        }

        const statusMessage = isTeacherActive 
          ? '교사 계정이 생성되었습니다.'
          : '교사 계정이 생성되었습니다. 학원 승인 후 로그인 가능합니다.';

        // Return different response based on activation status
        const responseData: any = {
          message: statusMessage,
          needsApproval: !isTeacherActive,
          teacher: {
            id: teacher.id,
            subject: teacher.subject,
            phone: teacher.phone
          }
        };

        // Only include user and tenant data if teacher is active (logged in)
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
        console.error('Teacher signup error:', error);
        res.status(500).json({ error: '교사 가입 중 오류가 발생했습니다.' });
      }
    }
  );

  // Sign in
  app.post('/api/auth/signin',
    validateBody(signinSchema),
    async (req: Request, res: Response) => {
      try {
        const { email, password } = req.body;

        console.log(`🔐 Signin attempt: ${email}`);

        // Find user
        const user = await storage.getUserByEmail(email);
        if (!user) {
          console.warn(`⚠️  Signin failed: user not found for ${email}`);
          return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }

        // Verify password
        const isValidPassword = await verifyPassword(password, user.password);
        if (!isValidPassword) {
          console.warn(`⚠️  Signin failed: wrong password for ${email}`);
          return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }

        // Check if user is active
        if (!user.isActive) {
          console.warn(`⚠️  Signin failed: account inactive for ${email}`);
          return res.status(403).json({ error: '비활성화된 계정입니다.' });
        }

        const token = generateToken({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId
        });

        // Set HTTP-only cookie (sameSite: 'lax' for Railway compatibility)
        res.cookie('token', token, cookieOptions);

        console.log(`✅ User signin success: ${user.email} (role=${user.role})`);

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

  // Dashboard Students Route (미납자 우선, 최신순, 최대 6명)
  app.get('/api/dashboard/students', authGuard, tenantGuard, async (req, res) => {
    try {
      const students = await storage.getDashboardStudents(req.user!.tenantId!);
      res.json(students);
    } catch (error) {
      console.error('Get dashboard students error:', error);
      res.status(500).json({ error: '대시보드 학생 목록 조회 중 오류가 발생했습니다.' });
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
        res.json({ message: '학생이 완전히 삭제되었습니다.' });
      } catch (error) {
        console.error('Delete student error:', error);
        res.status(500).json({ error: '학생 삭제 중 오류가 발생했습니다.' });
      }
    }
  );

  // 학생 휴원 처리 (비활성화)
  app.patch('/api/students/:id/deactivate',
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

        await storage.deactivateStudent(req.params.id);
        res.json({ message: '학생이 휴원 처리되었습니다.' });
      } catch (error) {
        console.error('Deactivate student error:', error);
        res.status(500).json({ error: '학생 휴원 처리 중 오류가 발생했습니다.' });
      }
    }
  );

  // 학생 재등록 처리 (활성화)
  app.patch('/api/students/:id/activate',
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

        await storage.activateStudent(req.params.id);
        res.json({ message: '학생이 재등록되었습니다.' });
      } catch (error) {
        console.error('Activate student error:', error);
        res.status(500).json({ error: '학생 재등록 중 오류가 발생했습니다.' });
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

        const isAlreadyInactive = !teacher.isActive;
        await storage.deleteTeacher(req.params.id);
        res.json({ 
          message: isAlreadyInactive ? '교사가 완전히 삭제되었습니다.' : '교사가 비활성화되었습니다.',
          permanentlyDeleted: isAlreadyInactive 
        });
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

        const wasInactive = !classItem.isActive;
        await storage.deleteClass(req.params.id);
        res.json({ 
          message: wasInactive ? '반이 완전히 삭제되었습니다.' : '반이 비활성 처리되었습니다.',
          hardDeleted: wasInactive
        });
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
    (req: Request, res: Response, next: any) => {
      console.log('🔥 BEFORE conversion:', JSON.stringify(req.body, null, 2));
      // 날짜 문자열을 Date 객체로 변환
      if (req.body.startDate && typeof req.body.startDate === 'string') {
        req.body.startDate = new Date(req.body.startDate);
        console.log('🔥 Converted startDate to:', req.body.startDate, typeof req.body.startDate);
      }
      if (req.body.endDate && typeof req.body.endDate === 'string') {
        req.body.endDate = new Date(req.body.endDate);
      }
      console.log('🔥 AFTER conversion:', JSON.stringify(req.body, null, 2));
      next();
    },
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
    validateBody(updateEnrollmentSchema),
    (req: Request, res: Response, next: any) => {
      // 문자열 날짜를 유효한 Date 객체로 변환
      if (req.body.startDate && typeof req.body.startDate === 'string') {
        // YYYY-MM-DD 형태를 안전하게 Date로 변환
        const dateStr = req.body.startDate;
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          req.body.startDate = new Date(dateStr + 'T00:00:00Z'); // UTC로 통일
        } else {
          delete req.body.startDate; // 잘못된 형식이면 제거
        }
      }
      if (req.body.endDate && typeof req.body.endDate === 'string') {
        const dateStr = req.body.endDate;
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          req.body.endDate = new Date(dateStr + 'T00:00:00Z'); // UTC로 통일
        } else {
          delete req.body.endDate; // 잘못된 형식이면 제거
        }
      }
      next();
    },
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
    (req: Request, res: Response, next: any) => {
      console.log('🔥 Payment data received:', JSON.stringify(req.body, null, 2));
      // 날짜 문자열을 Date 객체로 변환
      if (req.body.paidDate && typeof req.body.paidDate === 'string') {
        req.body.paidDate = new Date(req.body.paidDate);
        console.log('🔥 Converted paidDate to:', req.body.paidDate, typeof req.body.paidDate);
      }
      next();
    },
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
    (req: Request, res: Response, next: any) => {
      // 날짜 문자열을 Date 객체로 변환
      if (req.body.date && typeof req.body.date === 'string') {
        req.body.date = new Date(req.body.date);
      }
      next();
    },
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

  app.delete('/api/lesson-logs/:id',
    authGuard,
    tenantGuard,
    roleGuard('owner', 'teacher'),
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      try {
        await storage.deleteLessonLog(req.params.id);
        res.json({ message: '수업 일지가 삭제되었습니다.' });
      } catch (error) {
        console.error('Delete lesson log error:', error);
        res.status(500).json({ error: '수업 일지 삭제 중 오류가 발생했습니다.' });
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

  // Superadmin Routes
  // Get all tenants (for approval management)
  app.get('/api/superadmin/tenants',
    authGuard,
    roleGuard('superadmin'),
    async (req: Request, res: Response) => {
      try {
        const tenants = await storage.getAllTenants();
        res.json(tenants);
      } catch (error) {
        console.error('Get all tenants error:', error);
        res.status(500).json({ error: '테넌트 목록 조회 중 오류가 발생했습니다.' });
      }
    }
  );

  // Approve tenant (change status from pending to active)
  app.put('/api/superadmin/tenants/:id/approve',
    authGuard,
    roleGuard('superadmin'),
    validateParams(tenantIdParamSchema),
    async (req: Request, res: Response) => {
      try {
        const tenant = await storage.getTenant(req.params.id);
        if (!tenant) {
          return res.status(404).json({ error: '테넌트를 찾을 수 없습니다.' });
        }

        if (tenant.status !== 'pending') {
          return res.status(400).json({ error: '승인 대기 상태의 테넌트만 승인할 수 있습니다.' });
        }

        const approvedTenant = await storage.updateTenantStatus(req.params.id, 'active');
        res.json({
          message: '테넌트가 승인되었습니다.',
          tenant: approvedTenant
        });
      } catch (error) {
        console.error('Approve tenant error:', error);
        res.status(500).json({ error: '테넌트 승인 중 오류가 발생했습니다.' });
      }
    }
  );

  // Update tenant status (for both approval and rejection)
  app.patch('/api/superadmin/tenants/:id/status',
    authGuard,
    roleGuard('superadmin'),
    validateParams(tenantIdParamSchema),
    validateBody(z.object({
      status: z.enum(['pending', 'active', 'expired', 'suspended'])
    })),
    async (req: Request, res: Response) => {
      try {
        const tenant = await storage.getTenant(req.params.id);
        if (!tenant) {
          return res.status(404).json({ error: '테넌트를 찾을 수 없습니다.' });
        }

        const updatedTenant = await storage.updateTenantStatus(req.params.id, req.body.status);
        res.json({
          message: `테넌트 상태가 ${req.body.status}로 변경되었습니다.`,
          tenant: updatedTenant
        });
      } catch (error) {
        console.error('Update tenant status error:', error);
        res.status(500).json({ error: '테넌트 상태 업데이트 중 오류가 발생했습니다.' });
      }
    }
  );

  // Delete tenant (완전 삭제)
  app.delete('/api/superadmin/tenants/:id',
    authGuard,
    roleGuard('superadmin'),
    validateParams(tenantIdParamSchema),
    async (req: Request, res: Response) => {
      try {
        const tenant = await storage.getTenant(req.params.id);
        if (!tenant) {
          return res.status(404).json({ error: '테넌트를 찾을 수 없습니다.' });
        }

        // 테넌트 완전 삭제
        await storage.deleteTenant(req.params.id);
        res.json({
          message: '테넌트가 완전히 삭제되었습니다.',
          tenantId: req.params.id
        });
      } catch (error) {
        console.error('Delete tenant error:', error);
        res.status(500).json({ error: '테넌트 삭제 중 오류가 발생했습니다.' });
      }
    }
  );

  const httpServer = createServer(app);
  return httpServer;
}