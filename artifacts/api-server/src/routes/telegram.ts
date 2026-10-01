import { timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, or } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  ministersTable,
  processesTable,
  systemSettingsTable,
  telegramSessionsTable,
  usersTable,
  votesTable,
} from "@workspace/db";
import { createProcessRecord, type AttachmentInput } from "../lib/tribunal";
import { STATUSES, VOTE_CHOICES, ROLES } from "../lib/tribunal";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type TelegramUser = { id: number; first_name?: string; last_name?: string };
type TelegramFile = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};
type TelegramMessage = {
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
  document?: TelegramFile;
  video?: TelegramFile;
  photo?: Array<TelegramFile>;
};
type TelegramCallback = {
  id: string;
  data?: string;
  from: TelegramUser;
  message?: { chat: { id: number; type?: string } };
};
type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
};
type Session = {
  chatId: string;
  userId: number;
  state: string;
  data: Record<string, unknown>;
};

const menu = {
  inline_keyboard: [
    [{ text: "Registrar denúncia", callback_data: "new" }],
    [
      { text: "Consultar processo", callback_data: "track" },
      { text: "Meus processos", callback_data: "mine" },
    ],
    [{ text: "Acompanhar julgamento", callback_data: "judgment" }],
    [
      { text: "Constituição", callback_data: "constitution" },
      { text: "Sobre o bot", callback_data: "about" },
    ],
  ],
};

function authorizedSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function telegramCall<T>(method: string, payload: Record<string, unknown>): Promise<T | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as { ok?: boolean; result?: T };
    return response.ok && result.ok ? result.result ?? null : null;
  } catch (error) {
    logger.warn({ err: error, method }, "Telegram Bot API request failed");
    return null;
  }
}

async function say(chatId: string, text: string, replyMarkup?: Record<string, unknown>) {
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(id: string): Promise<void> {
  await telegramCall("answerCallbackQuery", { callback_query_id: id });
}

async function getOrCreateUser(
  chatId: string,
  identity?: TelegramUser,
): Promise<{ id: number; name: string } | null> {
  const [existing] = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.telegramChatId, chatId))
    .limit(1);
  if (existing) return existing;

  const name =
    [identity?.first_name, identity?.last_name].filter(Boolean).join(" ").trim() ||
    "Cidadão do RP";
  const [created] = await db
    .insert(usersTable)
    .values({
      telegramChatId: chatId,
      name,
      role: ROLES.CITIZEN,
    })
    .onConflictDoNothing()
    .returning({ id: usersTable.id, name: usersTable.name });
  if (created) return created;
  const [raced] = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.telegramChatId, chatId))
    .limit(1);
  return raced ?? null;
}

async function getSession(chatId: string): Promise<Session | null> {
  const [session] = await db
    .select()
    .from(telegramSessionsTable)
    .where(eq(telegramSessionsTable.chatId, chatId))
    .limit(1);
  return session
    ? {
        chatId: session.chatId,
        userId: session.userId,
        state: session.state,
        data: session.data,
      }
    : null;
}

async function saveSession(session: Session): Promise<void> {
  await db
    .insert(telegramSessionsTable)
    .values({
      chatId: session.chatId,
      userId: session.userId,
      state: session.state,
      data: session.data,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: telegramSessionsTable.chatId,
      set: {
        userId: session.userId,
        state: session.state,
        data: session.data,
        updatedAt: new Date(),
      },
    });
}

async function clearSession(chatId: string): Promise<void> {
  await db
    .delete(telegramSessionsTable)
    .where(eq(telegramSessionsTable.chatId, chatId));
}

function sessionText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sessionAttachments(data: Record<string, unknown>): AttachmentInput[] {
  return Array.isArray(data.attachments)
    ? (data.attachments as AttachmentInput[]).slice(0, 8)
    : [];
}

async function showMenu(chatId: string, intro = "Olá. Este bot atende ao portal de roleplay do STF do Estado Federal do RP.") {
  await say(chatId, `${intro}\n\nEscolha uma opção:`, menu);
}

async function processLookup(
  chatId: string,
  userId: number,
  processNumber: string,
  judgmentOnly: boolean,
): Promise<void> {
  const cleaned = processNumber.trim().toUpperCase();
  const numericId = /^\d+$/.test(cleaned) ? Number(cleaned) : -1;
  const [process] = await db
    .select()
    .from(processesTable)
    .where(
      or(
        eq(processesTable.processNumber, cleaned),
        ...(numericId > 0 ? [eq(processesTable.id, numericId)] : []),
      ),
    )
    .limit(1);
  if (!process || process.complainantUserId !== userId) {
    await say(chatId, "Não encontrei um processo disponível para esta conta. Confira o número ou consulte “Meus processos”.", menu);
    return;
  }

  const [owner] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, process.complainantUserId))
    .limit(1);
  const lines = [
    `Processo ${process.processNumber}`,
    process.subject,
    `Situação: ${process.status}`,
    `Prazo: ${process.deadlineAt?.toLocaleString("pt-BR") ?? "Não definido"}`,
  ];
  if (process.status === STATUSES.IN_TRIAL) {
    const [votes] = await db
      .select({ total: count() })
      .from(votesTable)
      .where(
        and(
          eq(votesTable.processId, process.id),
          eq(votesTable.round, process.voteRound),
        ),
      );
    const [seats] = await db
      .select({ total: count() })
      .from(ministersTable)
      .where(eq(ministersTable.active, true));
    lines.push(
      `Progresso dos votos: ${Math.min(votes?.total ?? 0, 5)}/${Math.min(seats?.total ?? 5, 5)} ministros registraram voto.`,
      "Conteúdo e fundamentos dos votos permanecem reservados durante a votação.",
    );
  }
  if (process.result) {
    const result =
      process.result === VOTE_CHOICES.PROCEDENT
        ? "Procedente"
        : process.result === VOTE_CHOICES.IMPROCEDENT
          ? "Improcedente"
          : "Empate";
    lines.push(`Resultado colegiado: ${result}.`);
  }
  if (judgmentOnly && process.status !== STATUSES.IN_TRIAL) {
    lines.push("Este processo não está em votação neste momento.");
  }
  if (process.complainantUserId === userId && owner?.name) {
    lines.push(`Denunciante: ${owner.name}`);
  }
  await say(chatId, lines.join("\n"), menu);
}

async function listMyProcesses(chatId: string, userId: number): Promise<void> {
  const rows = await db
    .select({
      processNumber: processesTable.processNumber,
      subject: processesTable.subject,
      status: processesTable.status,
      deadlineAt: processesTable.deadlineAt,
    })
    .from(processesTable)
    .where(eq(processesTable.complainantUserId, userId))
    .orderBy(desc(processesTable.createdAt))
    .limit(10);
  if (!rows.length) {
    await say(chatId, "Você ainda não protocolou processos por este bot.", menu);
    return;
  }
  await say(
    chatId,
    rows
      .map(
        (row) =>
          `${row.processNumber} · ${row.subject}\nSituação: ${row.status} · Prazo: ${row.deadlineAt?.toLocaleString("pt-BR") ?? "—"}`,
      )
      .join("\n\n"),
    menu,
  );
}

async function startSession(
  chatId: string,
  userId: number,
  state: string,
  prompt: string,
): Promise<void> {
  await saveSession({ chatId, userId, state, data: {} });
  await say(chatId, prompt, {
    inline_keyboard: [[{ text: "Cancelar", callback_data: "cancel" }]],
  });
}

async function goToConfirmation(session: Session): Promise<void> {
  session.state = "confirm";
  await saveSession(session);
  const data = session.data;
  await say(
    session.chatId,
    [
      "Confira a denúncia antes de protocolar:",
      `Denunciado: ${sessionText(data.accusedName)}`,
      `Categoria: ${sessionText(data.category)}`,
      `Assunto: ${sessionText(data.subject)}`,
      `Relato: ${sessionText(data.facts)}`,
      `Anexos: ${sessionAttachments(data).length}`,
      "",
      "Ao confirmar, o registro será enviado ao portal de roleplay.",
    ].join("\n"),
    {
      inline_keyboard: [
        [
          { text: "Confirmar protocolo", callback_data: "confirm" },
          { text: "Cancelar", callback_data: "cancel" },
        ],
      ],
    },
  );
}

async function processMessage(
  chatId: string,
  message: TelegramMessage,
  userId: number,
): Promise<void> {
  const text = message.text?.trim() ?? "";
  const session = await getSession(chatId);
  if (!session) {
    await showMenu(chatId, "Use o menu para consultar ou registrar um processo.");
    return;
  }
  if (text.toLowerCase() === "/cancelar" || text.toLowerCase() === "cancelar") {
    await clearSession(chatId);
    await showMenu(chatId, "A operação foi cancelada.");
    return;
  }

  if (session.state === "track" || session.state === "judgment") {
    await clearSession(chatId);
    await processLookup(chatId, userId, text, session.state === "judgment");
    return;
  }

  if (session.state === "accused") {
    if (text.length < 2 || text.length > 200) {
      await say(chatId, "Informe um nome entre 2 e 200 caracteres.");
      return;
    }
    session.data.accusedName = text;
    session.state = "subject";
    await saveSession(session);
    await say(chatId, "Qual é o assunto da denúncia? Resuma em uma frase.");
    return;
  }
  if (session.state === "subject") {
    if (text.length < 3 || text.length > 200) {
      await say(chatId, "Informe um assunto entre 3 e 200 caracteres.");
      return;
    }
    session.data.subject = text;
    session.state = "category";
    await saveSession(session);
    await say(chatId, "Qual é a categoria? Responda: Constitucional, Administrativa, Eleitoral, Penal, Cível ou Outra.");
    return;
  }
  if (session.state === "category") {
    const categories = ["Constitucional", "Administrativa", "Eleitoral", "Penal", "Cível", "Outra"];
    const category = categories.find((item) => item.toLowerCase() === text.toLowerCase());
    if (!category) {
      await say(chatId, "Escolha uma das categorias informadas: Constitucional, Administrativa, Eleitoral, Penal, Cível ou Outra.");
      return;
    }
    session.data.category = category;
    session.state = "facts";
    await saveSession(session);
    await say(chatId, "Descreva os fatos com pelo menos 20 caracteres. Inclua apenas informações ficcionais do RP.");
    return;
  }
  if (session.state === "facts") {
    if (text.length < 20 || text.length > 10000) {
      await say(chatId, "O relato precisa ter entre 20 e 10.000 caracteres.");
      return;
    }
    session.data.facts = text;
    session.state = "evidence";
    await saveSession(session);
    await say(chatId, "Envie fotos ou documentos como anexos. Quando terminar, toque em “Finalizar anexos”.", {
      inline_keyboard: [[{ text: "Finalizar anexos", callback_data: "finish_evidence" }], [{ text: "Cancelar", callback_data: "cancel" }]],
    });
    return;
  }
  if (session.state === "evidence") {
    const file = message.document ?? message.video ?? message.photo?.at(-1);
    if (file) {
      const attachments = sessionAttachments(session.data);
      if (attachments.length >= 8) {
        await say(chatId, "O limite é de oito anexos. Toque em “Finalizar anexos” para continuar.");
        return;
      }
      const mime = file.mime_type ?? (message.photo ? "image/jpeg" : "application/octet-stream");
      if (
        !/^(image\/(jpeg|png|webp)|application\/pdf|text\/plain|video\/mp4)$/.test(mime) ||
        (file.file_size ?? 1) > 25_000_000
      ) {
        await say(chatId, "Este tipo ou tamanho de arquivo não é permitido. Use JPEG, PNG, WebP, PDF, texto simples ou MP4, até 25 MB.");
        return;
      }
      attachments.push({
        telegramFileId: file.file_id,
        name: (file.file_name ?? (message.photo ? "foto.jpg" : "anexo")).slice(0, 255),
        contentType: mime,
        size: Math.max(1, file.file_size ?? 1),
      });
      session.data.attachments = attachments;
      await saveSession(session);
      await say(chatId, `Anexo recebido (${attachments.length}/8). Envie outro ou finalize os anexos.`, {
        inline_keyboard: [[{ text: "Finalizar anexos", callback_data: "finish_evidence" }], [{ text: "Cancelar", callback_data: "cancel" }]],
      });
      return;
    }
    if (["finalizar", "finalizar anexos", "pronto", "pular"].includes(text.toLowerCase())) {
      await goToConfirmation(session);
      return;
    }
    await say(chatId, "Envie um arquivo compatível ou toque em “Finalizar anexos”.");
    return;
  }

  await showMenu(chatId);
}

async function processCallback(
  chatId: string,
  callback: TelegramCallback,
  userId: number,
): Promise<void> {
  const action = callback.data ?? "";
  if (action === "cancel") {
    await clearSession(chatId);
    await showMenu(chatId, "A operação foi cancelada.");
  } else if (action === "new") {
    await startSession(chatId, userId, "accused", "Informe o nome da pessoa denunciada dentro do roleplay.");
  } else if (action === "track" || action === "judgment") {
    await startSession(
      chatId,
      userId,
      action,
      action === "track"
        ? "Digite o número do processo que você protocolou por este bot."
        : "Digite o número do processo cujo progresso de julgamento deseja consultar.",
    );
  } else if (action === "mine") {
    await listMyProcesses(chatId, userId);
  } else if (action === "constitution") {
    const [constitution] = await db
      .select()
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, "constitution_text"))
      .limit(1);
    await say(chatId, constitution?.value ?? "A Constituição fictícia ainda não foi cadastrada pela administração.", menu);
  } else if (action === "about") {
    await say(chatId, "Bot oficial do portal de roleplay do STF do Estado Federal do RP. Denúncias e decisões são ficcionais e não têm validade fora do jogo. Ministros votam por conta própria; o bot não vota nem determina resultados.", menu);
  } else if (action === "finish_evidence") {
    const session = await getSession(chatId);
    if (session?.state === "evidence") await goToConfirmation(session);
    else await showMenu(chatId);
  } else if (action === "confirm") {
    const session = await getSession(chatId);
    if (!session || session.state !== "confirm") {
      await showMenu(chatId, "A sessão expirou. Recomece pelo menu.");
      return;
    }
    const created = await createProcessRecord(
      session.userId,
      {
        accusedName: sessionText(session.data.accusedName),
        subject: sessionText(session.data.subject),
        category: sessionText(session.data.category),
        facts: sessionText(session.data.facts),
        attachments: sessionAttachments(session.data),
      },
      "telegram",
    );
    await clearSession(chatId);
    await showMenu(chatId, `Denúncia protocolada. Número: ${created.processNumber}. Prazo inicial: ${created.deadlineAt.toLocaleString("pt-BR")}.`);
  } else {
    await showMenu(chatId);
  }
}

router.post("/telegram/webhook", async (req: Request, res: Response): Promise<void> => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    res.status(503).json({ error: "Webhook do Telegram não configurado." });
    return;
  }
  if (!authorizedSecret(req.get("x-telegram-bot-api-secret-token"), expected)) {
    res.status(401).json({ error: "Webhook não autorizado." });
    return;
  }

  const update = req.body as TelegramUpdate;
  try {
    const message = update.message;
    const callback = update.callback_query;
    const chatId = message
      ? String(message.chat.id)
      : callback?.message
        ? String(callback.message.chat.id)
        : callback
          ? String(callback.from.id)
          : null;
    const identity = message?.from ?? callback?.from;
    if (!chatId || !identity) {
      res.status(200).json({ ok: true });
      return;
    }
    const chatType = message?.chat.type ?? callback?.message?.chat.type;
    if (chatType && chatType !== "private") {
      res.status(200).json({ ok: true });
      return;
    }
    const user = await getOrCreateUser(chatId, identity);
    if (!user) {
      res.status(503).json({ error: "Não foi possível iniciar a sessão." });
      return;
    }

    if (callback) {
      await answerCallback(callback.id);
      await processCallback(chatId, callback, user.id);
    } else if (message?.text?.startsWith("/start")) {
      await clearSession(chatId);
      await showMenu(chatId);
    } else if (message) {
      await processMessage(chatId, message, user.id);
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, "Telegram update processing failed");
    res.status(200).json({ ok: true });
  }
});

export default router;