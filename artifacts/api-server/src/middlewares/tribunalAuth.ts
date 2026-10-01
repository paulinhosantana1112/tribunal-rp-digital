import { clerkClient, getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      tribunalUser?: User;
    }
  }
}

const ADMIN_ROLE = "ADMINISTRADOR";
const CITIZEN_ROLE = "CIDADÃO";

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Entre na sua conta para continuar." });
    return;
  }

  try {
    const identity = await clerkClient.users.getUser(userId);
    const primaryEmail = identity.primaryEmailAddress;
    const email = primaryEmail?.emailAddress?.trim().toLowerCase();
    if (!email || primaryEmail?.verification?.status !== "verified") {
      res.status(403).json({ error: "Confirme um e-mail antes de acessar o tribunal." });
      return;
    }

    const name =
      [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim() ||
      email.split("@")[0] ||
      "Cidadão";
    const configuredAdminEmail = process.env.STF_ADMIN_EMAIL?.trim().toLowerCase();
    const [adminCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(eq(usersTable.role, ADMIN_ROLE));
    const shouldBootstrapAdmin =
      email === configuredAdminEmail && (adminCount?.count ?? 0) === 0;

    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkId, userId))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(usersTable)
        .set({
          email,
          name,
          ...(shouldBootstrapAdmin && existing.role === CITIZEN_ROLE
            ? { role: ADMIN_ROLE }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, existing.id))
        .returning();
      req.tribunalUser = updated;
    } else {
      const [created] = await db
        .insert(usersTable)
        .values({
          clerkId: userId,
          email,
          name,
          role: shouldBootstrapAdmin ? ADMIN_ROLE : CITIZEN_ROLE,
        })
        .returning();
      req.tribunalUser = created;
    }

    next();
  } catch (error) {
    req.log?.error({ err: error }, "Unable to synchronize signed-in tribunal user");
    res.status(503).json({ error: "Não foi possível validar sua conta agora." });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.tribunalUser) {
      res.status(401).json({ error: "Entre na sua conta para continuar." });
      return;
    }
    if (!roles.includes(req.tribunalUser.role)) {
      res.status(403).json({ error: "Você não tem permissão para acessar esta área." });
      return;
    }
    next();
  };
}