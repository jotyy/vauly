import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { session, user } from "./auth";

// Everything named `encrypted*`, `wrapped*` or `data` is ciphertext produced by
// @vauly/crypto on a client. The server can store and return it, never read it.

const createdAt = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull();

export type Role = "owner" | "admin" | "member";

/** Workspace-wide plaintext settings, such as its name. */
export const setting = sqliteTable("setting", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

/** A person in the workspace, with the keys only their master password opens. */
export const member = sqliteTable("member", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	role: text("role").$type<Role>().notNull(),
	kdfSalt: text("kdf_salt").notNull(),
	/**
	 * How the master password becomes the master key: Argon2id, or PBKDF2 for accounts made
	 * before it, until their next unlock moves them. Iterations are PBKDF2's rounds, and
	 * stay at 600,000 for Argon2id, so an app from before it derives slowly and fails;
	 * passes and memory (in KiB) are Argon2's.
	 */
	kdf: text("kdf").$type<"pbkdf2" | "argon2id">().notNull().default("pbkdf2"),
	kdfIterations: integer("kdf_iterations").notNull(),
	kdfPasses: integer("kdf_passes"),
	kdfMemory: integer("kdf_memory"),
	publicKey: text("public_key").notNull(),
	encryptedPrivateKey: text("encrypted_private_key").notNull(),
	/**
	 * Two-step login: the setup key the server checks codes against, the last time step
	 * used (so a code works once), and SHA-256 hashes of the unused recovery codes.
	 */
	totpSecret: text("totp_secret"),
	totpPending: text("totp_pending"),
	totpStep: integer("totp_step"),
	recoveryCodes: text("recovery_codes", { mode: "json" }).$type<string[]>(),
	/**
	 * Wrong codes and master passwords given in a row, and the moment the next try is
	 * checked again (packages/auth/src/pace.ts).
	 */
	wrongTries: integer("wrong_tries").notNull().default(0),
	nextTryAt: integer("next_try_at", { mode: "timestamp_ms" }),
	lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
	createdAt: createdAt(),
});

export const invite = sqliteTable("invite", {
	id: text("id").primaryKey(),
	email: text("email").notNull(),
	role: text("role").$type<Exclude<Role, "owner">>().notNull(),
	tokenHash: text("token_hash").notNull().unique(),
	invitedBy: text("invited_by").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
	createdAt: createdAt(),
});

export const vault = sqliteTable("vault", {
	id: text("id").primaryKey(),
	/** Sealed with the vault key: { name, description, tone }. */
	encryptedMeta: text("encrypted_meta").notNull(),
	/** Set for a person's private vault; nobody else can be added to it. */
	personalFor: text("personal_for"),
	createdBy: text("created_by").notNull(),
	createdAt: createdAt(),
});

/**
 * What someone can do in a vault they can open. The server enforces it; the key itself
 * can't tell reading from writing.
 * - view: open, reveal, copy and fill items
 * - edit: also add, change, delete and restore items, and share them by link or with agents
 * - manage: also choose who can open the vault and what they can do, rename and delete it
 */
export type VaultRole = "view" | "edit" | "manage";

/** Who can open a vault: the vault key wrapped to that person's public key. */
export const vaultAccess = sqliteTable(
	"vault_access",
	{
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => member.userId, { onDelete: "cascade" }),
		wrappedKey: text("wrapped_key").notNull(),
		// Whoever creates a vault manages it, as does everyone who could open one before
		// roles existed. Sharing always says which role.
		role: text("role").$type<VaultRole>().notNull().default("manage"),
		grantedBy: text("granted_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		primaryKey({ columns: [table.vaultId, table.userId] }),
		index("vault_access_user_idx").on(table.userId),
	],
);

export const item = sqliteTable(
	"item",
	{
		id: text("id").primaryKey(),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		/** The item key, wrapped with the vault key. */
		wrappedKey: text("wrapped_key").notNull(),
		/** Sealed with the item key: kind, name, username, secret, url, notes, … */
		data: text("data").notNull(),
		revision: integer("revision").notNull().default(1),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
		createdAt: createdAt(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
		/** Set when moved to Recently deleted; the row is removed for good 30 days later. */
		deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
		deletedBy: text("deleted_by"),
	},
	(table) => [index("item_vault_idx").on(table.vaultId)],
);

export const favorite = sqliteTable(
	"favorite",
	{
		userId: text("user_id").notNull(),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.userId, table.itemId] })],
);

/**
 * A link that shows one item to someone outside the workspace. `data` is a copy of the
 * item sealed with a key that only travels in the link's #fragment, so it never reaches
 * the server.
 */
export const shareLink = sqliteTable(
	"share_link",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
		data: text("data").notNull(),
		createdBy: text("created_by").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		/** Null when the link can be opened any number of times before it expires. */
		maxViews: integer("max_views"),
		views: integer("views").notNull().default(0),
		createdAt: createdAt(),
	},
	(table) => [index("share_link_item_idx").on(table.itemId)],
);

/**
 * A file attached to an item. `meta` holds its name, type, size and key, sealed with the
 * item key, and is null until the upload finishes; uploads left unfinished go after a
 * day. `size` and `chunks` stay readable so the server can check uploads against its
 * limits, as it sees the size of any ciphertext.
 */
export const attachment = sqliteTable(
	"attachment",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
		meta: text("meta"),
		size: integer("size").notNull(),
		chunks: integer("chunks").notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [index("attachment_item_idx").on(table.itemId)],
);

/**
 * A file's contents, a chunk a row, sealed with the file key. It's base64 text rather
 * than a BLOB because D1 hands a BLOB back as an array of numbers, which costs a Worker
 * more CPU to read than the free plan gives a request.
 */
export const attachmentChunk = sqliteTable(
	"attachment_chunk",
	{
		attachmentId: text("attachment_id")
			.notNull()
			.references(() => attachment.id, { onDelete: "cascade" }),
		index: integer("index").notNull(),
		data: text("data").notNull(),
	},
	(table) => [primaryKey({ columns: [table.attachmentId, table.index] })],
);

export type AgentKind = "mcp" | "cli" | "ci";

export const agent = sqliteTable("agent", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	kind: text("kind").$type<AgentKind>().notNull(),
	ownerId: text("owner_id").notNull(),
	publicKey: text("public_key").notNull(),
	secretHash: text("secret_hash").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	host: text("host"),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
	lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
	/** When its requests last sent notifications: at most once every few minutes. */
	notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
	createdAt: createdAt(),
});

/** An item key wrapped to an agent's public key: the agent can decrypt that one item. */
export const agentGrant = sqliteTable(
	"agent_grant",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
		wrappedKey: text("wrapped_key").notNull(),
		/** `once` grants are removed after their first use. */
		once: integer("once", { mode: "boolean" }).notNull().default(false),
		/**
		 * Whether the agent may download the item's files too: those the item had when it
		 * was granted (`createdAt`, renewed by each approval).
		 */
		files: integer("files", { mode: "boolean" }).notNull().default(false),
		/**
		 * The newest file the person saw when they gave the agent the item's files: it gets
		 * that one and older ones, never a file finished later. Files are dated when their
		 * upload finishes.
		 */
		filesThrough: integer("files_through", { mode: "timestamp_ms" }),
		/**
		 * A one-time grant that was used with files is kept, used up, until the passes its
		 * run got expire, so the run can finish its downloads and no later.
		 */
		filesUntil: integer("files_until", { mode: "timestamp_ms" }),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		grantedBy: text("granted_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("agent_grant_pair_idx").on(table.agentId, table.itemId),
	],
);

export type RequestStatus = "pending" | "approved" | "denied";

export const accessRequest = sqliteTable(
	"access_request",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
		command: text("command").notNull(),
		/** Whether the agent asked for the item's files too, for a reference to one. */
		files: integer("files", { mode: "boolean" }).notNull().default(false),
		status: text("status").$type<RequestStatus>().notNull().default("pending"),
		decidedBy: text("decided_by"),
		decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
	},
	(table) => [index("access_request_status_idx").on(table.status)],
);

export type EventAction =
	| "created"
	| "updated"
	| "deleted"
	| "revealed"
	| "copied"
	| "injected"
	| "requested"
	| "approved"
	| "denied"
	| "granted"
	| "revoked"
	| "shared"
	| "joined"
	| "invited"
	| "imported"
	| "exported"
	| "restored"
	| "filled"
	| "linked"
	| "opened"
	// A file on an item; `detail` is `file:<id>`, its name being encrypted.
	| "attached"
	| "downloaded"
	| "renamed"
	| "removed"
	// Someone's role in a vault changed; `detail` holds the new role ("owner" for the
	// workspace's owner, without a vault).
	| "changed"
	// Someone deleted their own account; `detail` keeps their name.
	| "left";

/** Append-only audit log. `detail` is plaintext: never put a secret in it. */
export const event = sqliteTable(
	"event",
	{
		id: text("id").primaryKey(),
		/** `link` is someone outside the workspace opening a share link; `actorId` is the link. */
		actorType: text("actor_type")
			.$type<"member" | "agent" | "link">()
			.notNull(),
		actorId: text("actor_id").notNull(),
		action: text("action").$type<EventAction>().notNull(),
		itemId: text("item_id"),
		vaultId: text("vault_id"),
		subjectId: text("subject_id"),
		detail: text("detail"),
		createdAt: createdAt(),
	},
	(table) => [index("event_created_idx").on(table.createdAt)],
);

/**
 * A device that gets notifications: where its browser's push service takes them, and the
 * keys they're encrypted to (RFC 8291). It belongs to the session that turned them on,
 * one per session, so signing out, here or from another device, removes it.
 */
export const pushSubscription = sqliteTable(
	"push_subscription",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		sessionId: text("session_id")
			.notNull()
			.references(() => session.id, { onDelete: "cascade" }),
		endpoint: text("endpoint").notNull().unique(),
		/** The browser's P-256 public key and its auth secret, both base64url. */
		p256dh: text("p256dh").notNull(),
		auth: text("auth").notNull(),
		/** Sends that failed in a row; a few and the device is forgotten. */
		failures: integer("failures").notNull().default(0),
		createdAt: createdAt(),
	},
	(table) => [
		index("push_subscription_user_idx").on(table.userId),
		uniqueIndex("push_subscription_session_idx").on(table.sessionId),
	],
);
