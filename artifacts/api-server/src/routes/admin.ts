import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import {
  AssignMinisterBody,
  AssignMinisterResponse,
  GetAdminDashboardResponse,
  GetProcessParams,
  GetProcessResponse,
  GetSystemSettingsResponse,
  ListAuditLogsResponse,
  ListMinistersResponse,
  ListUsersResponse,
  PublishDecisionBody,
  PublishDecisionParams,
  PublishDecisionResponse,
  SetTelegramWebhookBody,
  SetTelegramWebhookResponse,
  StartTrialParams,
  StartTrialResponse,
  UpdateProcessStatusBody,
  UpdateProcessStatusParams,
  UpdateProcessStatusResponse,
  UpdateUserRoleBody,
  UpdateUserRoleParams,
  UpdateUserRoleResponse,
  UpdateSystemSettingsBody,
  UpdateSystemSettingsResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  auditLogsTable,
  decisionsTable,
  db,
  ministersTable,
  processesTable,
  systemSettingsTable,
  usersTable,
  votesTable,
  type User,
} from "@workspace/db";
import { requireRole, requireUser } from "../middlewares/tribunalAuth";
import { buildProcessView } from "../lib/process-view";
import {
  getDeadlineHours,
  notifyUser,
  recordAudit,
  ROLES,
  STATUSES,
  VOTE_CHOICES,
} from "../lib/tribunal";

const router: IRouter = Router();
const adminOnly = [requireUser, requireRole(ROLES.ADMIN)];

function currentUser(req: Request): User {
  if (!req.tribunalUser) throw new Error("Authentication middleware was not applied.");
  return req.tribunalUser;
}

function parseId(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: { processId: number; userId?: number }; error?: unknown } },
  params: unknown,
  res: Response,
): number | null {
  const parsed = schema.safeParse(params);
  if (!parsed.success || !parsed.data?.processId) {
    res.status(400).json({ error: "Identificador inválido." });
    return null;
  }
  return parsed.data.processId;
}

router.get(
  "/admin/dashboard",
  ...adminOnly,
  async (_req: Request, res: Response): Promise<void> => {
    const grouped = await db
      .select({ status: processesTable.status, total: count() })
      .from(processesTable)
      .groupBy(processesTable.status);
    const totals = new Map(grouped.map((row) => [row.status, row.total]));
    const [ministerCount] = await db
      .select({ total: count() })
      .from(ministersTable)
      .where(and(eq(ministersTable.active, true), isNotNull(ministersTable.userId)));
    const data = {
      totalProcesses: grouped.reduce((sum, row) => sum + row.total, 0),
      received: totals.get(STATUSES.RECEIVED) ?? 0,
      inReview:
        (totals.get(STATUSES.TRIAGE) ?? 0) +
        (totals.get(STATUSES.AWAITING_TRIAL) ?? 0),
      inJudgment: totals.get(STATUSES.IN_TRIAL) ?? 0,
      awaitingInformation: totals.get(STATUSES.AWAITING_INFORMATION) ?? 0,
      concluded:
        (totals.get(STATUSES.CONCLUDED) ?? 0) +
        (totals.get(STATUSES.PROCEDENT) ?? 0) +
        (totals.get(STATUSES.IMPROCEDENT) ?? 0) +
        (totals.get(STATUSES.ARCHIVED) ?? 0),
      ministersAssigned: ministerCount.total,
    };
    res.json(GetAdminDashboardResponse.parse(data));
  },
);

router.get(
  "/admin/users",
  ...adminOnly,
  async (_req: Request, res: Response): Promise<void> => {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        clerkId: usersTable.clerkId,
        role: usersTable.role,
        seat: ministersTable.seat,
      })
      .from(usersTable)
      .leftJoin(
        ministersTable,
        and(eq(ministersTable.userId, usersTable.id), eq(ministersTable.active, true)),
      )
      .orderBy(usersTable.name);
    res.json(
      ListUsersResponse.parse(
        rows.map((row) => ({
          ...row,
          ministerSeat: row.seat ?? null,
          active: Boolean(row.clerkId),
        })),
      ),
    );
  },
);

router.get(
  "/admin/ministers",
  ...adminOnly,
  async (_req: Request, res: Response): Promise<void> => {
    const seats = await db
      .select({
        seat: ministersTable.seat,
        active: ministersTable.active,
        userId: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
      })
      .from(ministersTable)
      .leftJoin(usersTable, eq(usersTable.id, ministersTable.userId))
      .orderBy(ministersTable.seat);
    res.json(
      ListMinistersResponse.parse(
        seats.map((seat) => ({
          id: seat.userId ?? -seat.seat,
          name: seat.name ?? "Assento vago",
          email: seat.email ?? `vago${seat.seat}@stf-rp.invalid`,
          role: seat.role ?? ROLES.CITIZEN,
          ministerSeat: seat.seat,
          active: seat.active,
        })),
      ),
    );
  },
);

router.post(
  "/admin/ministers",
  ...adminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = AssignMinisterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Assento ou conta ministerial inválidos." });
      return;
    }
    const admin = currentUser(req);
    const { userId, seat } = parsed.data;

    const [activeTrial] = await db
      .select({ id: processesTable.id })
      .from(processesTable)
      .where(eq(processesTable.status, STATUSES.IN_TRIAL))
      .limit(1);
    if (activeTrial) {
      res.status(409).json({ error: "Finalize ou encerre as votações abertas antes de trocar ministros." });
      return;
    }

    const [candidate] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    const [targetSeat] = await db
      .select()
      .from(ministersTable)
      .where(eq(ministersTable.seat, seat))
      .limit(1);
    if (!candidate || !candidate.clerkId || !targetSeat || !targetSeat.active) {
      res.status(400).json({ error: "A conta ou o assento informado não está disponível." });
      return;
    }
    if (candidate.role === ROLES.ADMIN) {
      res.status(409).json({ error: "Uma conta administradora não pode ocupar um assento ministerial." });
      return;
    }
    const [otherSeat] = await db
      .select()
      .from(ministersTable)
      .where(and(eq(ministersTable.userId, userId), eq(ministersTable.active, true)))
      .limit(1);
    if (otherSeat && otherSeat.seat !== seat) {
      res.status(409).json({ error: "Esta conta já ocupa outro assento ministerial." });
      return;
    }

    await db.transaction(async (tx) => {
      if (targetSeat.userId && targetSeat.userId !== userId) {
        await tx
          .update(usersTable)
          .set({ role: ROLES.CITIZEN, updatedAt: new Date() })
          .where(eq(usersTable.id, targetSeat.userId));
      }
      await tx
        .update(ministersTable)
        .set({ userId, appointedAt: new Date() })
        .where(eq(ministersTable.id, targetSeat.id));
      await tx
        .update(usersTable)
        .set({ role: ROLES.MINISTER, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));
      await tx.insert(auditLogsTable).values({
        actorUserId: admin.id,
        action: "MINISTER_ASSIGNED",
        details: {
          seat,
          userId,
          replacedUserId: targetSeat.userId ?? null,
        },
      });
    });

    const [assigned] = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    res.json(
      AssignMinisterResponse.parse({
        id: assigned.id,
        name: assigned.name,
        email: assigned.email,
        role: assigned.role,
        ministerSeat: seat,
        active: true,
      }),
    );
  },
);

router.patch(
  "/admin/users/:userId/role",
  ...adminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const parsedId = UpdateUserRoleParams.safeParse(req.params);
    const parsedBody = UpdateUserRoleBody.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) {
      res.status(400).json({ error: "Conta ou papel inválido." });
      return;
    }
    const admin = currentUser(req);
    const userId = parsedId.data.userId;
    if (userId === admin.id) {
      res.status(409).json({ error: "Não é possível alterar o próprio papel." });
      return;
    }
    const [target] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Conta não encontrada." });
      return;
    }
    if (!target.clerkId) {
      res.status(409).json({ error: "Esta conta do Telegram precisa de um cadastro web antes de receber um papel do portal." });
      return;
    }
    if (target.role === ROLES.ADMIN && parsedBody.data.role !== ROLES.ADMIN) {
      const [adminCount] = await db
        .select({ total: count() })
        .from(usersTable)
        .where(eq(usersTable.role, ROLES.ADMIN));
      if (adminCount.total < 2) {
        res.status(409).json({ error: "O tribunal precisa manter ao menos um administrador." });
        return;
      }
    }
    await db.transaction(async (tx) => {
      await tx
        .update(ministersTable)
        .set({ userId: null, appointedAt: null })
        .where(eq(ministersTable.userId, userId));
      await tx
        .update(usersTable)
        .set({ role: parsedBody.data.role, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));
      await tx.insert(auditLogsTable).values({
        actorUserId: admin.id,
        action: "USER_ROLE_CHANGED",
        details: { targetUserId: userId, role: parsedBody.data.role },
      });
    });
    const [updated] = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    res.json(
      UpdateUserRoleResponse.parse({
        ...updated,
        ministerSeat: null,
        active: true,
      }),
    );
  },
);

router.patch(
  "/admin/processes/:processId/status",
  ...adminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const parsedId = UpdateProcessStatusParams.safeParse(req.params);
    const parsedBody = UpdateProcessStatusBody.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) {
      res.status(400).json({ error: "Processo ou situação inválida." });
      return;
    }
    const admin = currentUser(req);
    const [process] = await db
      .select()
      .from(processesTable)
      .where(eq(processesTable.id, parsedId.data.processId))
      .limit(1);
    if (!process) {
      res.status(404).json({ error: "Processo não encontrado." });
      return;
    }
    const allowed: Record<string, string[]> = {
      [STATUSES.RECEIVED]: [STATUSES.TRIAGE, STATUSES.ARCHIVED],
      [STATUSES.TRIAGE]: [STATUSES.AWAITING_TRIAL, STATUSES.ARCHIVED],
      [STATUSES.AWAITING_TRIAL]: [STATUSES.TRIAGE, STATUSES.ARCHIVED],
      [STATUSES.AWAITING_INFORMATION]: [STATUSES.ARCHIVED],
    };
    const nextStatus = parsedBody.data.status;
    if (!allowed[process.status]?.includes(nextStatus)) {
      res.status(409).json({ error: "Esta movimentação não é permitida para a situação atual." });
      return;
    }
    await db
      .update(processesTable)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(processesTable.id, process.id));
    await recordAudit(
      admin.id,
      "PROCESS_STATUS_CHANGED",
      { from: process.status, to: nextStatus, processNumber: process.processNumber },
      process.id,
    );
    await notifyUser(
      process.complainantUserId,
      "process_status_changed",
      "Movimentação no processo",
      `O processo ${process.processNumber} agora está com a situação "${nextStatus}".`,
      process.id,
    );
    const view = await buildProcessView(process.id, admin);
    res.json(UpdateProcessStatusResponse.parse(view));
  },
);

router.post(
  "/admin/processes/:processId/start-trial",
  ...adminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const processId = parseId(StartTrialParams, req.params, res);
    if (!processId) return;
    const admin = currentUser(req);
    const [process] = await db
      .select()
      .from(processesTable)
      .where(eq(processesTable.id, processId))
      .limit(1);
    if (!process) {
      res.status(404).json({ error: "Processo não encontrado." });
      return;
    }
    const startableStatuses = new Set<string>([
      STATUSES.RECEIVED,
      STATUSES.TRIAGE,
      STATUSES.AWAITING_TRIAL,
    ]);
    if (!startableStatuses.has(process.status)) {
      res.status(409).json({ error: "O processo ainda não pode iniciar ou retomar o julgamento." });
      return;
    }
    const seats = await db
      .select({ seat: ministersTable.seat, userId: ministersTable.userId })
      .from(ministersTable)
      .where(eq(ministersTable.active, true));
    if (seats.length !== 5 || seats.some((seat) => seat.userId === null)) {
      res.status(409).json({ error: "Designe cinco ministros antes de iniciar o julgamento." });
      return;
    }
    const previousVotes = await db
      .select()
      .from(votesTable)
      .where(
        and(
          eq(votesTable.processId, process.id),
          eq(votesTable.round, process.voteRound),
        ),
      );
    const impedimentVoters = previousVotes
      .filter((vote) => vote.choice === VOTE_CHOICES.IMPEDIMENT)
      .map((vote) => vote.ministerUserId);
    if (impedimentVoters.length) {
      const stillAssigned = await db
        .select({ userId: ministersTable.userId })
        .from(ministersTable)
        .where(
          and(
            eq(ministersTable.active, true),
            inArray(ministersTable.userId, impedimentVoters),
          ),
        );
      if (stillAssigned.length) {
        res.status(409).json({ error: "Substitua os ministros impedidos antes de abrir nova rodada." });
        return;
      }
    }
    const deadlineAt = new Date(Date.now() + (await getDeadlineHours()) * 3_600_000);
    const nextRound = previousVotes.length ? process.voteRound + 1 : process.voteRound;
    await db
      .update(processesTable)
      .set({
        status: STATUSES.IN_TRIAL,
        voteRound: nextRound,
        deadlineAt,
        result: null,
        updatedAt: new Date(),
      })
      .where(eq(processesTable.id, process.id));
    await recordAudit(
      admin.id,
      "TRIAL_STARTED",
      { processNumber: process.processNumber, round: nextRound },
      process.id,
    );
    await notifyUser(
      process.complainantUserId,
      "trial_started",
      "Julgamento iniciado",
      `O julgamento do processo ${process.processNumber} foi iniciado. Prazo vigente até ${deadlineAt.toLocaleString("pt-BR")}.`,
      process.id,
    );
    const view = await buildProcessView(process.id, admin);
    res.json(StartTrialResponse.parse(view));
  },
);

router.post(
  "/admin/processes/:processId/publish-decision",
  ...adminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const parsedId = PublishDecisionParams.safeParse(req.params);
    const parsedBody = PublishDecisionBody.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) {
      res.status(400).json({ error: "Resumo da decisão inválido." });
      return;
    }
    const admin = currentUser(req);
    const [process] = await db
      .select()
      .from(processesTable)
      .where(eq(processesTable.id, parsedId.data.processId))
      .limit(1);
    if (!process || !process.result) {
      res.status(409).json({ error: "A votação ainda não foi concluída." });
      return;
    }
    const [existing] = await db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.processId, process.id))
      .limit(1);
    if (existing?.publishedAt) {
      res.status(409).json({ error: "A decisão deste processo já foi publicada." });
      return;
    }
    const now = new Date();
    let decision;
    if (existing) {
      [decision] = await db
        .update(decisionsTable)
        .set({
          outcome: process.result,
          summary: parsedBody.data.summary.trim(),
          publishedByUserId: admin.id,
          publishedAt: now,
        })
        .where(eq(decisionsTable.id, existing.id))
        .returning();
    } else {
      [decision] = await db
        .insert(decisionsTable)
        .values({
          processId: process.id,
          outcome: process.result,
          summary: parsedBody.data.summary.trim(),
          publishedByUserId: admin.id,
          publishedAt: now,
        })
        .returning();
    }
    const finalStatus =
      process.result === VOTE_CHOICES.PROCEDENT
        ? STATUSES.PROCEDENT
        : process.result === VOTE_CHOICES.IMPROCEDENT
          ? STATUSES.IMPROCEDENT
          : STATUSES.CONCLUDED;
    await db
      .update(processesTable)
      .set({ status: finalStatus, updatedAt: now })
      .where(eq(processesTable.id, process.id));
    await recordAudit(
      admin.id,
      "DECISION_PUBLISHED",
      { processNumber: process.processNumber, outcome: process.result },
      process.id,
    );
    await notifyUser(
      process.complainantUserId,
      "decision_published",
      "Decisão publicada",
      `A decisão do processo ${process.processNumber} foi publicada no portal.`,
      process.id,
    );
    res.status(201).json(
      PublishDecisionResponse.parse({
        id: decision.id,
        processId: process.id,
        processNumber: process.processNumber,
        subject: process.subject,
        category: process.category,
        outcome: process.result,
        summary: decision.summary,
        publishedAt: decision.publishedAt?.toISOString() ?? null,
      }),
    );
  },
);

router.get(
  "/admin/settings",
  ...adminOnly,
  async (_req: Request, res: Response): Promise<void> => {
    res.json(GetSystemSettingsResponse.parse({ deadlineHours: await getDeadlineHours() }));
  },
);

router.patch(
  "/admin/settings",
  ...adminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateSystemSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "O prazo deve estar entre 1 e 720 horas." });
      return;
    }
    const admin = currentUser(req);
    await db
      .insert(systemSettingsTable)
      .values({
        key: "deadline_hours",
        value: String(parsed.data.deadlineHours),
        updatedByUserId: admin.id,
      })
      .onConflictDoUpdate({
        target: systemSettingsTable.key,
        set: {
          value: String(parsed.data.deadlineHours),
          updatedByUserId: admin.id,
          updatedAt: new Date(),
        },
      });
    await recordAudit(admin.id, "DEADLINE_UPDATED", {
      deadlineHours: parsed.data.deadlineHours,
    });
    res.json(
      UpdateSystemSettingsResponse.parse({
        deadlineHours: parsed.data.deadlineHours,
      }),
    );
  },
);

router.get(
  "/admin/audit-logs",
  ...adminOnly,
  async (_req: Request, res: Response): Promise<void> => {
    const rows = await db
      .select({
        id: auditLogsTable.id,
        actorName: usersTable.name,
        action: auditLogsTable.action,
        details: auditLogsTable.details,
        createdAt: auditLogsTable.createdAt,
      })
      .from(auditLogsTable)
      .leftJoin(usersTable, eq(usersTable.id, auditLogsTable.actorUserId))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(200);
    res.json(
      ListAuditLogsResponse.parse(
        rows.map((row) => ({
          id: row.id,
          actorName: row.actorName ?? "Sistema",
          action: row.action,
          details:
            typeof row.details === "string"
              ? row.details
              : JSON.stringify(row.details),
          createdAt: row.createdAt.toISOString(),
        })),
      ),
    );
  },
);

router.post(
  "/admin/telegram/webhook",
  ...adminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = SetTelegramWebhookBody.safeParse(req.body);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!parsed.success) {
      res.status(400).json({ error: "URL do webhook inválida." });
      return;
    }
    if (!token || !secret) {
      res.status(503).json({
        error: "Configure TELEGRAM_BOT_TOKEN e TELEGRAM_WEBHOOK_SECRET nos Secrets do projeto.",
      });
      return;
    }
    let webhookUrl: URL;
    try {
      webhookUrl = new URL(parsed.data.webhookUrl);
    } catch {
      res.status(400).json({ error: "URL do webhook inválida." });
      return;
    }
    if (
      webhookUrl.protocol !== "https:" ||
      webhookUrl.pathname !== "/api/telegram/webhook" ||
      webhookUrl.search ||
      webhookUrl.hash
    ) {
      res.status(400).json({ error: "Use uma URL HTTPS terminada em /api/telegram/webhook." });
      return;
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl.toString(),
          secret_token: secret,
          allowed_updates: ["message", "callback_query"],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = (await response.json()) as { ok?: boolean; description?: string };
      if (!response.ok || !result.ok) {
        res.status(502).json({ error: result.description ?? "O Telegram recusou o webhook." });
        return;
      }
      await recordAudit(currentUser(req).id, "TELEGRAM_WEBHOOK_REGISTERED", {
        host: webhookUrl.host,
      });
      res.json(
        SetTelegramWebhookResponse.parse({
          ok: true,
          message: "Webhook do Telegram registrado.",
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Unable to register Telegram webhook");
      res.status(502).json({ error: "Não foi possível registrar o webhook no Telegram." });
    }
  },
);

export default router;