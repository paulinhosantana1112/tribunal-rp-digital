import { and, eq } from "drizzle-orm";
import {
  db,
  attachmentsTable,
  complaintsTable,
  decisionsTable,
  ministersTable,
  processesTable,
  usersTable,
  votesTable,
  type Attachment,
  type User,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { VOTE_CHOICES, type AttachmentInput } from "./tribunal";

const storage = new ObjectStorageService();

export async function verifyUploadedAttachments(
  attachments: AttachmentInput[],
): Promise<boolean> {
  if (attachments.length > 8) return false;

  for (const attachment of attachments) {
    if (
      !attachment.objectPath ||
      !/^\/objects\/uploads\/[a-f0-9-]{36}$/i.test(attachment.objectPath) ||
      attachment.size < 1 ||
      attachment.size > 25_000_000
    ) {
      return false;
    }
    try {
      const file = await storage.getObjectEntityFile(attachment.objectPath);
      const [metadata] = await file.getMetadata();
      if (
        Number(metadata.size) !== attachment.size ||
        (metadata.contentType &&
          metadata.contentType !== attachment.contentType)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export async function buildProcessView(
  processId: number,
  actor: User,
): Promise<Record<string, unknown> | null> {
  const [process] = await db
    .select()
    .from(processesTable)
    .where(eq(processesTable.id, processId))
    .limit(1);
  if (!process) return null;

  if (
    actor.role === "CIDADÃO" &&
    process.complainantUserId !== actor.id
  ) {
    return null;
  }

  const [[complaint], [complainant], attachments, seats, roundVotes, [decision]] =
    await Promise.all([
      db
        .select()
        .from(complaintsTable)
        .where(eq(complaintsTable.processId, processId))
        .limit(1),
      db
        .select({ name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.id, process.complainantUserId))
        .limit(1),
      db
        .select()
        .from(attachmentsTable)
        .where(eq(attachmentsTable.processId, processId))
        .orderBy(attachmentsTable.id),
      db
        .select({
          seat: ministersTable.seat,
          userId: ministersTable.userId,
          name: usersTable.name,
        })
        .from(ministersTable)
        .leftJoin(usersTable, eq(usersTable.id, ministersTable.userId))
        .where(eq(ministersTable.active, true))
        .orderBy(ministersTable.seat),
      db
        .select()
        .from(votesTable)
        .where(
          and(
            eq(votesTable.processId, processId),
            eq(votesTable.round, process.voteRound),
          ),
        ),
      db
        .select()
        .from(decisionsTable)
        .where(eq(decisionsTable.processId, processId))
        .limit(1),
    ]);

  const activeSeats = seats.filter((seat) => seat.userId !== null);
  const voteByMinister = new Map(roundVotes.map((vote) => [vote.ministerUserId, vote]));
  const voteProgress = seats.map((seat) => {
    const vote = seat.userId ? voteByMinister.get(seat.userId) : undefined;
    return {
      ministerUserId: seat.userId ?? -seat.seat,
      ministerName: seat.name ?? `Ministro ${seat.seat}`,
      seat: seat.seat,
      hasVoted: Boolean(vote),
      votedAt: vote?.createdAt.toISOString() ?? null,
    };
  });

  const allFinalVotes =
    activeSeats.length === 5 &&
    roundVotes.length === 5 &&
    roundVotes.every(
      (vote) =>
        vote.choice === VOTE_CHOICES.PROCEDENT ||
        vote.choice === VOTE_CHOICES.IMPROCEDENT,
    );
  const voteTally = allFinalVotes
    ? {
        procedente: roundVotes.filter(
          (vote) => vote.choice === VOTE_CHOICES.PROCEDENT,
        ).length,
        improcedente: roundVotes.filter(
          (vote) => vote.choice === VOTE_CHOICES.IMPROCEDENT,
        ).length,
      }
    : null;
  const ownVote =
    actor.role === "MINISTRO"
      ? roundVotes.find((vote) => vote.ministerUserId === actor.id)
      : undefined;
  const visibleDecision = decision?.publishedAt ? decision : undefined;

  const result: Record<string, unknown> = {
    id: process.id,
    processNumber: process.processNumber,
    subject: process.subject,
    accusedName: process.accusedName,
    category: process.category,
    complainantName: complainant?.name ?? "Cidadão",
    status: process.status,
    createdAt: process.createdAt.toISOString(),
    deadlineAt: process.deadlineAt?.toISOString() ?? null,
    result: process.result,
    voteRound: process.voteRound,
    voteProgress,
    facts: complaint?.facts ?? "",
    attachments: attachments.map((attachment: Attachment) => ({
      id: attachment.id,
      name: attachment.originalName,
      contentType: attachment.contentType,
      size: attachment.size,
      url: `/api/processes/${process.id}/attachments/${attachment.id}`,
    })),
    voteTally,
    myVote: ownVote
      ? {
          choice: ownVote.choice,
          rationale: ownVote.rationale,
      createdAt: ownVote.createdAt.toISOString(),
        }
      : null,
    decisionSummary: visibleDecision?.summary ?? null,
    publishedAt: visibleDecision?.publishedAt?.toISOString() ?? null,
  };

  return result;
}