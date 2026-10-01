import { Readable } from "node:stream";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  isNotNull,
  or,
} from "drizzle-orm";
import {
  CreateProcessBody,
  GetMyProfileResponse,
  GetProcessParams,
  GetProcessResponse,
  GetPublicSummaryResponse,
  GetPublishedDecisionsResponse,
  ListProcessesQueryParams,
  ListProcessesResponse,
  SubmitAdditionalInformationBody,
  SubmitAdditionalInformationParams,
  SubmitAdditionalInformationResponse,
  SubmitVoteBody,
  SubmitVoteParams,
  SubmitVoteResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  auditLogsTable,
  attachmentsTable,
  complaintsTable,
  decisionsTable,
  db,
  ministersTable,
  processesTable,
  usersTable,
  votesTable,
  type User,
} from "@workspace/db";
import { requireRole, requireUser } from "../middlewares/tribunalAuth";
import {
  buildProcessView,
  verifyUploadedAttachments,
} from "../lib/process-view";
import {
  createProcessRecord,
  notifyUser,
  ROLES,
  STATUSES,
  VOTE_CHOICES,
  type AttachmentInput,
} from "../lib/tribunal";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();
function actor(req: Request): User {
  if (!req.tribunalUser) throw new Error("Authentication middleware was not applied.");
  return req.tribunalUser;
}

function parseProcessId(req: Request, res: Response): number | null {
  const parsed = GetProcessParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Número de processo inválido." });
    return null;
  }
  return parsed.data.processId;
}

async function sendAttachment(
  req: Request,
  res: Response,
  attachmentId: number,
  processId: number,
): Promise<void> {
  const current = actor(req);
  const [processRecord] = await db
    .select()
    .from(processesTable)
    .where(eq(processesTable.id, processId))
    .limit(1);
  if (
    !processRecord ||
    (current.role === ROLES.CITIZEN && processRecord.complainantUserId !== current.id)
  ) {
    res.status(404).json({ error: "Arquivo não encontrado." });
    return;
  }

  const [attachment] = await db
    .select()
    .from(attachmentsTable)
    .where(
      and(
        eq(attachmentsTable.id, attachmentId),
        eq(attachmentsTable.processId, processId),
      ),
    )
    .limit(1);
  if (!attachment) {
    res.status(404).json({ error: "Arquivo não encontrado." });
    return;
  }

  try {
    if (attachment.objectPath) {
      const object = await storage.getObjectEntityFile(attachment.objectPath);
      const response = await storage.downloadObject(object, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
      );
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    if (attachment.telegramFileId) {
    const token = globalThis.process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        res.status(503).json({ error: "O armazenamento de anexos do Telegram não está configurado." });
        return;
      }
      const fileResponse = await fetch(
        `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(attachment.telegramFileId)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const fileResult = (await fileResponse.json()) as {
        ok?: boolean;
        result?: { file_path?: string };
      };
      if (!fileResponse.ok || !fileResult.ok || !fileResult.result?.file_path) {
        res.status(502).json({ error: "Não foi possível obter o anexo do Telegram." });
        return;
      }
      const telegramResponse = await fetch(
        `https://api.telegram.org/file/bot${token}/${fileResult.result.file_path}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!telegramResponse.ok || !telegramResponse.body) {
        res.status(502).json({ error: "Não foi possível baixar o anexo do Telegram." });
        return;
      }
      res.setHeader("Content-Type", attachment.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
      );
      Readable.fromWeb(telegramResponse.body as ReadableStream<Uint8Array>).pipe(res);
      return;
    }

    res.status(404).json({ error: "Arquivo não encontrado." });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Arquivo não encontrado." });
      return;
    }
    req.log.error({ err: error }, "Unable to serve process attachment");
    res.status(500).json({ error: "Não foi possível baixar o anexo." });
  }
}

router.get("/auth/me", requireUser, async (req: Request, res: Response) => {
  const current = actor(req);
  const [seat] = await db
    .select({ seat: ministersTable.seat })
    .from(ministersTable)
    .where(and(eq(ministersTable.userId, current.id), eq(ministersTable.active, true)))
    .limit(1);
  res.json(
    GetMyProfileResponse.parse({
      id: current.id,
      email: current.email,
      name: current.name,
      role: current.role,
      ministerSeat: seat?.seat ?? null,
    }),
  );
});

router.get("/public/summary", async (_req: Request, res: Response) => {
  const [total] = await db.select({ value: count() }).from(processesTable);
  const [published] = await db
    .select({ value: count() })
    .from(decisionsTable)
    .where(isNotNull(decisionsTable.publishedAt));
  const [inJudgment] = await db
    .select({ value: count() })
    .from(processesTable)
    .where(eq(processesTable.status, STATUSES.IN_TRIAL));
  const [ministers] = await db
    .select({ value: count() })
    .from(ministersTable)
    .where(eq(ministersTable.active, true));

  res.json(
    GetPublicSummaryResponse.parse({
      totalProcesses: total.value,
      publishedDecisions: published.value,
      inJudgment: inJudgment.value,
      ministers: ministers.value,
    }),
  );
});

router.get("/public/decisions", async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: decisionsTable.id,
      processId: processesTable.id,
      processNumber: processesTable.processNumber,
      subject: processesTable.subject,
      category: processesTable.category,
      outcome: decisionsTable.outcome,
      summary: decisionsTable.summary,
      publishedAt: decisionsTable.publishedAt,
    })
    .from(decisionsTable)
    .innerJoin(processesTable, eq(processesTable.id, decisionsTable.processId))
    .where(isNotNull(decisionsTable.publishedAt))
    .orderBy(desc(decisionsTable.publishedAt));
  res.json(
    GetPublishedDecisionsResponse.parse(
      rows.map((row) => ({
        ...row,
        publishedAt: row.publishedAt?.toISOString() ?? null,
      })),
    ),
  );
});

router.get("/processes", requireUser, async (req: Request, res: Response) => {
  const parsed = ListProcessesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Filtros de processo inválidos." });
    return;
  }
  const current = actor(req);
  const conditions = [];
  if (current.role === ROLES.CITIZEN) {
    conditions.push(eq(processesTable.complainantUserId, current.id));
  }
  if (parsed.data.status) {
    conditions.push(eq(processesTable.status, parsed.data.status));
  }
  if (parsed.data.search?.trim()) {
    const search = `%${parsed.data.search.trim().replace(/[%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(processesTable.processNumber, search),
        ilike(processesTable.subject, search),
        ilike(processesTable.accusedName, search),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(processesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(processesTable.createdAt))
    .limit(200);

  const items = await Promise.all(
    rows.map(async (process) => {
      const view = await buildProcessView(process.id, current);
      if (!view) return null;
      return {
        id: view.id,
        processNumber: view.processNumber,
        subject: view.subject,
        accusedName: view.accusedName,
        category: view.category,
        complainantName: view.complainantName,
        status: view.status,
        createdAt: view.createdAt,
        deadlineAt: view.deadlineAt,
        result: view.result,
        voteRound: view.voteRound,
        voteProgress: view.voteProgress,
        publishedAt: view.publishedAt,
      };
    }),
  );
  res.json(ListProcessesResponse.parse(items.filter(Boolean)));
});

router.post(
  "/processes",
  requireUser,
  requireRole(ROLES.CITIZEN, ROLES.MINISTER, ROLES.ADMIN),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateProcessBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Confira os campos obrigatórios da denúncia." });
      return;
    }
    const input = parsed.data;
    const attachments = input.attachments as AttachmentInput[];
    if (!(await verifyUploadedAttachments(attachments))) {
      res.status(400).json({ error: "Um ou mais arquivos não foram enviados corretamente." });
      return;
    }
    const current = actor(req);
    const created = await createProcessRecord(current.id, input, "website");
    await notifyUser(
      current.id,
      "process_created",
      "Denúncia protocolada",
      `A denúncia ${created.processNumber} foi registrada e está disponível no portal.`,
      created.id,
    );
    const view = await buildProcessView(created.id, current);
    res.status(201).json(GetProcessResponse.parse(view));
  },
);

router.get("/processes/:processId", requireUser, async (req: Request, res: Response) => {
  const processId = parseProcessId(req, res);
  if (!processId) return;
  const view = await buildProcessView(processId, actor(req));
  if (!view) {
    res.status(404).json({ error: "Processo não encontrado." });
    return;
  }
  res.json(GetProcessResponse.parse(view));
});

router.get(
  "/processes/:processId/attachments/:attachmentId",
  requireUser,
  async (req: Request, res: Response) => {
    const processId = parseProcessId(req, res);
    const attachmentId = Number(req.params.attachmentId);
    if (!processId || !Number.isSafeInteger(attachmentId) || attachmentId < 1) {
      res.status(400).json({ error: "Identificador de arquivo inválido." });
      return;
    }
    await sendAttachment(req, res, attachmentId, processId);
  },
);

router.post(
  "/processes/:processId/votes",
  requireUser,
  async (req: Request, res: Response): Promise<void> => {
    const parsedId = SubmitVoteParams.safeParse(req.params);
    const parsedBody = SubmitVoteBody.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) {
      res.status(400).json({ error: "Dados do voto inválidos." });
      return;
    }
    const current = actor(req);
    if (current.role !== ROLES.MINISTER) {
      res.status(403).json({ error: "Somente um ministro designado pode votar." });
      return;
    }

    let resultingStatus: string | null = null;
    let processNumber = "";
    try {
      await db.transaction(async (tx) => {
        const [process] = await tx
          .select()
          .from(processesTable)
          .where(eq(processesTable.id, parsedId.data.processId))
          .for("update")
          .limit(1);
        if (!process) throw Object.assign(new Error("Processo não encontrado."), { status: 404 });
        if (process.status !== STATUSES.IN_TRIAL) {
          throw Object.assign(new Error("A votação deste processo não está aberta."), { status: 409 });
        }
        const [seat] = await tx
          .select()
          .from(ministersTable)
          .where(and(eq(ministersTable.userId, current.id), eq(ministersTable.active, true)))
          .limit(1);
        if (!seat) throw Object.assign(new Error("Você não ocupa um assento ministerial ativo."), { status: 403 });

        const [existingVote] = await tx
          .select({ id: votesTable.id })
          .from(votesTable)
          .where(
            and(
              eq(votesTable.processId, process.id),
              eq(votesTable.round, process.voteRound),
              eq(votesTable.ministerUserId, current.id),
            ),
          )
          .limit(1);
        if (existingVote) {
          throw Object.assign(new Error("Seu voto já foi registrado e não pode ser alterado."), { status: 409 });
        }

        await tx.insert(votesTable).values({
          processId: process.id,
          ministerUserId: current.id,
          round: process.voteRound,
          choice: parsedBody.data.choice,
          rationale: parsedBody.data.rationale.trim(),
        });

        const roundVotes = await tx
          .select()
          .from(votesTable)
          .where(
            and(
              eq(votesTable.processId, process.id),
              eq(votesTable.round, process.voteRound),
            ),
          );
        const activeSeats = await tx
          .select({ userId: ministersTable.userId })
          .from(ministersTable)
          .where(eq(ministersTable.active, true));
        const allFiveVoted =
          activeSeats.length === 5 &&
          activeSeats.every((entry) => entry.userId !== null) &&
          roundVotes.length === 5;

        if (allFiveVoted) {
          if (roundVotes.some((vote) => vote.choice === VOTE_CHOICES.MORE_INFORMATION)) {
            resultingStatus = STATUSES.AWAITING_INFORMATION;
          } else if (roundVotes.some((vote) => vote.choice === VOTE_CHOICES.IMPEDIMENT)) {
            resultingStatus = STATUSES.AWAITING_TRIAL;
          } else {
            const procedente = roundVotes.filter(
              (vote) => vote.choice === VOTE_CHOICES.PROCEDENT,
            ).length;
            const improcedente = roundVotes.filter(
              (vote) => vote.choice === VOTE_CHOICES.IMPROCEDENT,
            ).length;
            const outcome =
              procedente > improcedente
                ? VOTE_CHOICES.PROCEDENT
                : improcedente > procedente
                  ? VOTE_CHOICES.IMPROCEDENT
                  : "EMPATE";
            resultingStatus = STATUSES.CONCLUDED;
            await tx
              .update(processesTable)
              .set({ status: resultingStatus, result: outcome, updatedAt: new Date() })
              .where(eq(processesTable.id, process.id));
          }
          if (resultingStatus !== STATUSES.CONCLUDED) {
            await tx
              .update(processesTable)
              .set({ status: resultingStatus, result: null, updatedAt: new Date() })
              .where(eq(processesTable.id, process.id));
          }
        }
        processNumber = process.processNumber;
        await tx.insert(auditLogsTable).values({
          actorUserId: current.id,
          processId: process.id,
          action: "MINISTER_VOTED",
          details: { processNumber, round: process.voteRound },
        });
      });
    } catch (error) {
      const status = Number((error as { status?: number }).status) || 500;
      if (status >= 500) req.log.error({ err: error }, "Unable to record minister vote");
      res.status(status).json({
        error: status < 500 && error instanceof Error ? error.message : "Não foi possível registrar o voto.",
      });
      return;
    }

    if (resultingStatus) {
      const [process] = await db
        .select({ complainantUserId: processesTable.complainantUserId })
        .from(processesTable)
        .where(eq(processesTable.id, parsedId.data.processId))
        .limit(1);
      if (process) {
        const text =
          resultingStatus === STATUSES.AWAITING_INFORMATION
            ? `Os ministros solicitaram informações adicionais no processo ${processNumber}.`
            : resultingStatus === STATUSES.CONCLUDED
              ? `A votação do processo ${processNumber} foi concluída.`
              : `A votação do processo ${processNumber} foi concluída e aguarda uma providência administrativa.`;
        await notifyUser(
          process.complainantUserId,
          "process_status_changed",
          "Movimentação no processo",
          text,
          parsedId.data.processId,
        );
      }
    }
    const view = await buildProcessView(parsedId.data.processId, current);
    res.status(201).json(SubmitVoteResponse.parse(view));
  },
);

router.post(
  "/processes/:processId/information",
  requireUser,
  async (req: Request, res: Response): Promise<void> => {
    const parsedId = SubmitAdditionalInformationParams.safeParse(req.params);
    const parsedBody = SubmitAdditionalInformationBody.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) {
      res.status(400).json({ error: "Dados complementares inválidos." });
      return;
    }
    const current = actor(req);
    const [process] = await db
      .select()
      .from(processesTable)
      .where(eq(processesTable.id, parsedId.data.processId))
      .limit(1);
    if (!process || process.complainantUserId !== current.id) {
      res.status(404).json({ error: "Processo não encontrado." });
      return;
    }
    if (process.status !== STATUSES.AWAITING_INFORMATION) {
      res.status(409).json({ error: "Este processo não está aguardando informações." });
      return;
    }
    const attachments = parsedBody.data.attachments as AttachmentInput[];
    if (!(await verifyUploadedAttachments(attachments))) {
      res.status(400).json({ error: "Um ou mais arquivos não foram enviados corretamente." });
      return;
    }

    await db.transaction(async (tx) => {
      const [complaint] = await tx
        .select()
        .from(complaintsTable)
        .where(eq(complaintsTable.processId, process.id))
        .limit(1);
      const stamp = new Date().toISOString();
      await tx
        .update(complaintsTable)
        .set({ facts: `${complaint?.facts ?? ""}\n\nInformação adicional (${stamp}):\n${parsedBody.data.message.trim()}` })
        .where(eq(complaintsTable.processId, process.id));
      if (attachments.length) {
        await tx.insert(attachmentsTable).values(
          attachments.map((attachment) => ({
            processId: process.id,
            uploaderUserId: current.id,
            originalName: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            objectPath: attachment.objectPath ?? null,
          })),
        );
      }
      await tx
        .update(processesTable)
        .set({ status: STATUSES.AWAITING_TRIAL, updatedAt: new Date() })
        .where(eq(processesTable.id, process.id));
      await tx.insert(auditLogsTable).values({
        actorUserId: current.id,
        processId: process.id,
        action: "ADDITIONAL_INFORMATION_SUBMITTED",
        details: { processNumber: process.processNumber },
      });
    });
    const view = await buildProcessView(process.id, current);
    res.status(201).json(SubmitAdditionalInformationResponse.parse(view));
  },
);

export default router;