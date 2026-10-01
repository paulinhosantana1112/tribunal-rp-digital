import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  auditLogsTable,
  notificationsTable,
  processesTable,
  complaintsTable,
  attachmentsTable,
  systemSettingsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";

export const ROLES = {
  ADMIN: "ADMINISTRADOR",
  MINISTER: "MINISTRO",
  CITIZEN: "CIDADÃO",
} as const;

export const STATUSES = {
  RECEIVED: "Recebida",
  TRIAGE: "Em triagem",
  AWAITING_TRIAL: "Aguardando julgamento",
  IN_TRIAL: "Em julgamento",
  CONCLUDED: "Julgamento concluído",
  ARCHIVED: "Arquivada",
  PROCEDENT: "Procedente",
  IMPROCEDENT: "Improcedente",
  AWAITING_INFORMATION: "Aguardando informações",
} as const;

export const VOTE_CHOICES = {
  PROCEDENT: "PROCEDENTE",
  IMPROCEDENT: "IMPROCEDENTE",
  MORE_INFORMATION: "PEDIDO_DE_MAIS_INFORMACOES",
  IMPEDIMENT: "IMPEDIMENTO",
} as const;

export type AttachmentInput = {
  objectPath?: string;
  telegramFileId?: string;
  name: string;
  contentType: string;
  size: number;
};

export type ComplaintRecordInput = {
  accusedName: string;
  category: string;
  subject: string;
  facts: string;
  attachments: AttachmentInput[];
};

export async function getDeadlineHours(): Promise<number> {
  const [setting] = await db
    .select()
    .from(systemSettingsTable)
    .where(eq(systemSettingsTable.key, "deadline_hours"))
    .limit(1);
  const parsed = Number(setting?.value ?? "48");
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 720 ? parsed : 48;
}

export async function createProcessRecord(
  userId: number,
  input: ComplaintRecordInput,
  source: "website" | "telegram",
): Promise<{ id: number; processNumber: string; deadlineAt: Date }> {
  const deadlineHours = await getDeadlineHours();
  const deadlineAt = new Date(Date.now() + deadlineHours * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    const [process] = await tx
      .insert(processesTable)
      .values({
        processNumber: `STF-PENDING-${randomUUID()}`,
        complainantUserId: userId,
        subject: input.subject.trim(),
        accusedName: input.accusedName.trim(),
        category: input.category.trim(),
        status: STATUSES.RECEIVED,
        source,
        deadlineAt,
      })
      .returning();

    const year = process.createdAt.getFullYear();
    const processNumber = `STF-RP-${String(process.id).padStart(6, "0")}/${year}`;
    await tx
      .update(processesTable)
      .set({ processNumber })
      .where(eq(processesTable.id, process.id));

    await tx.insert(complaintsTable).values({
      processId: process.id,
      facts: input.facts.trim(),
    });

    if (input.attachments.length) {
      await tx.insert(attachmentsTable).values(
        input.attachments.map((attachment) => ({
          processId: process.id,
          uploaderUserId: userId,
          originalName: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          objectPath: attachment.objectPath ?? null,
          telegramFileId: attachment.telegramFileId ?? null,
        })),
      );
    }

    await tx.insert(auditLogsTable).values({
      actorUserId: userId,
      processId: process.id,
      action: "PROCESS_CREATED",
      details: { processNumber, source },
    });

    return { id: process.id, processNumber, deadlineAt };
  });
}

export async function recordAudit(
  actorUserId: number | null,
  action: string,
  details: Record<string, unknown>,
  processId: number | null = null,
): Promise<void> {
  await db.insert(auditLogsTable).values({
    actorUserId,
    processId,
    action,
    details,
  });
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as { ok?: boolean };
    return response.ok && result.ok === true;
  } catch (error) {
    logger.warn({ err: error }, "Telegram message delivery failed");
    return false;
  }
}

export async function notifyUser(
  userId: number,
  event: string,
  title: string,
  body: string,
  processId: number | null = null,
): Promise<void> {
  const [notification] = await db
    .insert(notificationsTable)
    .values({ userId, processId, event, title, body })
    .returning();

  const [user] = await db
    .select({ telegramChatId: usersTable.telegramChatId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (user?.telegramChatId && (await sendTelegramMessage(user.telegramChatId, body))) {
    await db
      .update(notificationsTable)
      .set({ deliveryStatus: "sent", sentAt: new Date() })
      .where(eq(notificationsTable.id, notification.id));
  }
}