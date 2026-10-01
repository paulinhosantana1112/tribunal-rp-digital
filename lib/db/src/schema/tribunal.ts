import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    clerkId: text("clerk_id").unique(),
    email: text("email").unique(),
    name: text("name").notNull(),
    role: text("role").notNull().default("CIDADÃO"),
    telegramChatId: text("telegram_chat_id").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [index("users_role_idx").on(table.role)],
);

export const ministersTable = pgTable(
  "ministers",
  {
    id: serial("id").primaryKey(),
    seat: integer("seat").notNull(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    appointedAt: timestamp("appointed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ministers_seat_unique").on(table.seat),
    uniqueIndex("ministers_user_unique").on(table.userId),
  ],
);

export const processesTable = pgTable(
  "processes",
  {
    id: serial("id").primaryKey(),
    processNumber: text("process_number").notNull().unique(),
    complainantUserId: integer("complainant_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
    subject: text("subject").notNull(),
    accusedName: text("accused_name").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("Recebida"),
    source: text("source").notNull().default("website"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    voteRound: integer("vote_round").notNull().default(1),
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index("processes_status_created_idx").on(table.status, table.createdAt),
    index("processes_complainant_idx").on(table.complainantUserId),
  ],
);

export const complaintsTable = pgTable(
  "complaints",
  {
    id: serial("id").primaryKey(),
    processId: integer("process_id").notNull().references(() => processesTable.id, { onDelete: "cascade" }).unique(),
    facts: text("facts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("complaints_process_idx").on(table.processId)],
);

export const attachmentsTable = pgTable(
  "attachments",
  {
    id: serial("id").primaryKey(),
    processId: integer("process_id").notNull().references(() => processesTable.id, { onDelete: "cascade" }),
    uploaderUserId: integer("uploader_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    objectPath: text("object_path"),
    telegramFileId: text("telegram_file_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("attachments_process_idx").on(table.processId)],
);

export const votesTable = pgTable(
  "votes",
  {
    id: serial("id").primaryKey(),
    processId: integer("process_id").notNull().references(() => processesTable.id, { onDelete: "cascade" }),
    ministerUserId: integer("minister_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
    round: integer("round").notNull(),
    choice: text("choice").notNull(),
    rationale: text("rationale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("votes_process_round_minister_unique").on(table.processId, table.round, table.ministerUserId),
    index("votes_process_round_idx").on(table.processId, table.round),
  ],
);

export const decisionsTable = pgTable(
  "decisions",
  {
    id: serial("id").primaryKey(),
    processId: integer("process_id").notNull().references(() => processesTable.id, { onDelete: "cascade" }).unique(),
    outcome: text("outcome").notNull(),
    summary: text("summary").notNull(),
    publishedByUserId: integer("published_by_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    processId: integer("process_id").references(() => processesTable.id, { onDelete: "set null" }),
    event: text("event").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("notifications_user_created_idx").on(table.userId, table.createdAt)],
);

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    processId: integer("process_id").references(() => processesTable.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_logs_created_idx").on(table.createdAt)],
);

export const systemSettingsTable = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const telegramSessionsTable = pgTable("telegram_sessions", {
  chatId: text("chat_id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;
export type Minister = typeof ministersTable.$inferSelect;
export type Process = typeof processesTable.$inferSelect;
export type Complaint = typeof complaintsTable.$inferSelect;
export type Attachment = typeof attachmentsTable.$inferSelect;
export type Vote = typeof votesTable.$inferSelect;
export type Decision = typeof decisionsTable.$inferSelect;
export type Notification = typeof notificationsTable.$inferSelect;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type SystemSetting = typeof systemSettingsTable.$inferSelect;
export type TelegramSession = typeof telegramSessionsTable.$inferSelect;