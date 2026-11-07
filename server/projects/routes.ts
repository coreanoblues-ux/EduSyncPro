/**
 * 설명회·광고 프로젝트 — /api/projects, /api/project-templates
 *
 * D-day 하나를 넣으면 역산 템플릿이 준비 할 일을 날짜별로 깔아 준다.
 * 깔리는 자리는 새 테이블이 아니라 **기존 tasks** 다. 설명회 준비도 결국
 * "퇴근 전에 할 일"이고, 따로 두면 원장이 화면 두 개를 봐야 하기 때문이다.
 *
 * 참석자를 상담으로 넘기는 경로(/attendees/:id/to-consultation)는 아직 없다.
 * 그 기능만 실제 consultations 에 쓰기 때문에 UI 와 함께 마지막에 붙인다. (PLAN.md 5단계)
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import {
  createProjectBodySchema,
  updateProjectBodySchema,
  projectTemplateBodySchema,
  createAttendeeBodySchema,
  generateTasksBodySchema,
  DEFAULT_PROJECT_TEMPLATES,
  type Project,
  type InsertTask,
} from "@shared/schema";
import { addDays } from "@shared/day";

const router = Router();

const idParam = z.string().uuid("유효하지 않은 ID 형식입니다.");

function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "입력 데이터가 올바르지 않습니다.",
        details: parsed.error.errors,
      });
    }
    req.body = parsed.data;
    next();
  };
}

/**
 * 경로의 프로젝트를 읽고 **우리 학원 것인지** 확인한다.
 * 다른 학원 프로젝트 id 를 주소창에 넣어도 404 로 막힌다 — 존재 여부조차 알려주지 않는다.
 */
async function loadProject(req: Request, res: Response): Promise<Project | null> {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    return null;
  }
  const project = await storage.getProject(id.data);
  if (!project || project.tenantId !== req.user!.tenantId) {
    res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
    return null;
  }
  return project;
}

const guards = [authGuard, tenantGuard, roleGuard("owner", "teacher")] as const;

/**
 * 템플릿을 읽되, **종류별로** 비어 있으면 기본 묶음을 깔고 읽는다.
 *
 * 목록 조회와 역산 생성이 같은 함수를 쓰는 것이 중요하다. 목록 화면에서만 깔아 주면,
 * 설정을 한 번도 안 열어 본 원장이 신규반 프로젝트를 만들었을 때 "템플릿이 없습니다"로
 * 튕긴다. 프로젝트를 만든 직후가 바로 그 상황이다.
 */
async function loadTemplatesSeeded(tenantId: string) {
  const templates = await storage.getProjectTemplatesByTenant(tenantId);
  const haveKinds = new Set(templates.map((t) => t.kind));
  const missing = DEFAULT_PROJECT_TEMPLATES.filter((t) => !haveKinds.has(t.kind));
  if (missing.length === 0) return templates;
  for (const t of missing) {
    await storage.createProjectTemplate({ ...t, tenantId });
  }
  return await storage.getProjectTemplatesByTenant(tenantId);
}

/* ── 프로젝트 ──────────────────────────────────────────────────────────── */

router.get("/api/projects", authGuard, tenantGuard, async (req, res) => {
  try {
    res.json(await storage.getProjectsByTenant(req.user!.tenantId!));
  } catch (error) {
    console.error("Get projects error:", error);
    res.status(500).json({ error: "프로젝트 목록 조회 중 오류가 발생했습니다." });
  }
});

/** 상세는 할 일·참석자까지 한 번에 준다. 화면이 세 번 왕복할 이유가 없다. */
router.get("/api/projects/:id", authGuard, tenantGuard, async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const [tasks, attendees] = await Promise.all([
      storage.getTasksByProject(project.id),
      storage.getAttendeesByProject(project.id),
    ]);
    res.json({ ...project, tasks, attendees });
  } catch (error) {
    console.error("Get project error:", error);
    res.status(500).json({ error: "프로젝트 조회 중 오류가 발생했습니다." });
  }
});

router.post("/api/projects", ...guards, validateBody(createProjectBodySchema), async (req, res) => {
  try {
    const project = await storage.createProject({
      ...req.body,
      tenantId: req.user!.tenantId!,
      createdBy: req.user!.id,
    });
    res.status(201).json(project);
  } catch (error) {
    console.error("Create project error:", error);
    res.status(500).json({ error: "프로젝트 등록 중 오류가 발생했습니다." });
  }
});

router.patch("/api/projects/:id", ...guards, validateBody(updateProjectBodySchema), async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    res.json(await storage.updateProject(project.id, req.body));
  } catch (error) {
    console.error("Update project error:", error);
    res.status(500).json({ error: "프로젝트 수정 중 오류가 발생했습니다." });
  }
});

router.delete("/api/projects/:id", ...guards, async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    await storage.deleteProject(project.id);
    res.json({ message: "프로젝트가 삭제되었습니다." });
  } catch (error) {
    console.error("Delete project error:", error);
    res.status(500).json({ error: "프로젝트 삭제 중 오류가 발생했습니다." });
  }
});

/* ── 역산 할 일 생성 ───────────────────────────────────────────────────── */

router.post(
  "/api/projects/:id/generate-tasks",
  ...guards,
  validateBody(generateTasksBodySchema),
  async (req, res) => {
    try {
      const project = await loadProject(req, res);
      if (!project) return;

      const templates = await loadTemplatesSeeded(project.tenantId);
      const template = req.body.templateId
        ? templates.find((t) => t.id === req.body.templateId)
        : templates.find((t) => t.kind === project.kind);

      if (!template) {
        return res.status(400).json({
          error: `"${project.kind}" 종류에 맞는 역산 템플릿이 없습니다. 설정에서 먼저 만들어 주세요.`,
        });
      }

      const existing = await storage.getTasksByProject(project.id);
      if (req.body.replace) {
        await storage.deleteIncompleteTasksByProject(project.id);
      }

      /*
        같은 제목을 두 번 깔지 않는다.
        · replace 가 아닐 때는 이미 있는 할 일 전부가 기준이라 여러 번 눌러도 늘어나지 않는다.
        · replace 일 때는 완료한 것만 기준이다. 안 끝난 일은 위에서 지웠으니 새 날짜로 다시 깔리고,
          이미 보낸 문자 같은 완료 건은 그 자리에 그대로 남는다.
      */
      const keep = new Set(
        (req.body.replace ? existing.filter((t) => t.completedAt) : existing).map((t) => t.title)
      );

      const toInsert: InsertTask[] = template.items
        .filter((item) => !keep.has(item.title))
        .map((item) => ({
          tenantId: project.tenantId,
          title: item.title,
          dueDate: addDays(project.dDay, item.offsetDays),
          slot: item.slot,
          projectId: project.id,
          createdBy: req.user!.id,
        }));

      const created = await storage.createTasks(toInsert);
      res.status(201).json({ created: created.length, skipped: template.items.length - created.length, tasks: created });
    } catch (error) {
      console.error("Generate project tasks error:", error);
      res.status(500).json({ error: "역산 할 일 생성 중 오류가 발생했습니다." });
    }
  }
);

/* ── 역산 템플릿 ───────────────────────────────────────────────────────── */

/**
 * 템플릿 목록. **종류별로** 하나도 없으면 그 종류의 기본 묶음을 깔아 준다.
 *
 * 빈 화면을 주고 "직접 만드세요"라고 하면 아무도 안 만든다. 종류 단위로 보는 이유는
 * 나중에 종류가 늘어나기 때문이다 — "하나라도 있으면 안 깐다"로 두면 설명회 템플릿이
 * 이미 있다는 이유로 새로 생긴 신규반·교차수업 탭이 영영 빈 채로 남는다.
 *
 * 대가: 어떤 종류의 템플릿을 전부 지우면 다음 방문에 기본값이 되살아난다.
 * 삭제 이력을 따로 저장하는 것보다 이 편이 단순하고, 빈 탭보다는 낫다고 판단했다.
 */
router.get("/api/project-templates", authGuard, tenantGuard, async (req, res) => {
  try {
    res.json(await loadTemplatesSeeded(req.user!.tenantId!));
  } catch (error) {
    console.error("Get project templates error:", error);
    res.status(500).json({ error: "템플릿 조회 중 오류가 발생했습니다." });
  }
});

router.post("/api/project-templates", ...guards, validateBody(projectTemplateBodySchema), async (req, res) => {
  try {
    res.status(201).json(
      await storage.createProjectTemplate({ ...req.body, tenantId: req.user!.tenantId! })
    );
  } catch (error) {
    console.error("Create project template error:", error);
    res.status(500).json({ error: "템플릿 등록 중 오류가 발생했습니다." });
  }
});

router.patch("/api/project-templates/:id", ...guards, validateBody(projectTemplateBodySchema), async (req, res) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    const existing = await storage.getProjectTemplate(id.data);
    if (!existing || existing.tenantId !== req.user!.tenantId) {
      return res.status(404).json({ error: "템플릿을 찾을 수 없습니다." });
    }
    res.json(await storage.updateProjectTemplate(id.data, req.body));
  } catch (error) {
    console.error("Update project template error:", error);
    res.status(500).json({ error: "템플릿 수정 중 오류가 발생했습니다." });
  }
});

router.delete("/api/project-templates/:id", ...guards, async (req, res) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    const existing = await storage.getProjectTemplate(id.data);
    if (!existing || existing.tenantId !== req.user!.tenantId) {
      return res.status(404).json({ error: "템플릿을 찾을 수 없습니다." });
    }
    await storage.deleteProjectTemplate(id.data);
    res.json({ message: "템플릿이 삭제되었습니다." });
  } catch (error) {
    console.error("Delete project template error:", error);
    res.status(500).json({ error: "템플릿 삭제 중 오류가 발생했습니다." });
  }
});

/* ── 참석 신청자 ───────────────────────────────────────────────────────── */

router.get("/api/projects/:id/attendees", authGuard, tenantGuard, async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    res.json(await storage.getAttendeesByProject(project.id));
  } catch (error) {
    console.error("Get attendees error:", error);
    res.status(500).json({ error: "참석자 조회 중 오류가 발생했습니다." });
  }
});

router.post("/api/projects/:id/attendees", ...guards, validateBody(createAttendeeBodySchema), async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    res.status(201).json(
      await storage.createProjectAttendee({
        ...req.body,
        tenantId: project.tenantId,
        projectId: project.id,
      })
    );
  } catch (error) {
    console.error("Create attendee error:", error);
    res.status(500).json({ error: "참석자 등록 중 오류가 발생했습니다." });
  }
});

router.delete("/api/projects/:id/attendees/:attendeeId", ...guards, async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const attendeeId = idParam.safeParse(req.params.attendeeId);
    if (!attendeeId.success) return res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    const attendee = await storage.getProjectAttendee(attendeeId.data);
    if (!attendee || attendee.projectId !== project.id) {
      return res.status(404).json({ error: "참석자를 찾을 수 없습니다." });
    }
    await storage.deleteProjectAttendee(attendee.id);
    res.json({ message: "참석자가 삭제되었습니다." });
  } catch (error) {
    console.error("Delete attendee error:", error);
    res.status(500).json({ error: "참석자 삭제 중 오류가 발생했습니다." });
  }
});

export default router;
