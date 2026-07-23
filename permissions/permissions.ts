import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("permissions", {
	migrations: "./migrations",
});

// ─── Default routes per role ──────────────────────────────────────────────────
// Returned when no explicit record exists for a user.

const DEFAULT_ROUTES: Record<string, string[]> = {
	super_admin: ["*"],
	admin: [
		"/admin/dashboards/default",
		"/admin/main/users/users-overview",
		"/admin/main/users/new-user",
		"/admin/main/users/update-employee",
		"/admin/main/users/users-reports",
		"/admin/main/expenses",
		"/admin/main/salaries",
		"/admin/main/invoices",
		"/admin/main/profit-margin",
		"/admin/main/employee-requests",
		"/admin/main/timesheet",
		"/admin/main/leave",
		"/admin/main/contracts",
		"/admin/main/applications/kanban",
		"/admin/main/applications/data-tables",
		"/admin/main/applications/calendar",
		"/admin/main/profile/overview",
		"/admin/main/profile/settings",
	],
	manager: [
		"/admin/dashboards/default",
		"/admin/main/users/users-overview",
		"/admin/main/expenses",
		"/admin/main/salaries",
		"/admin/main/invoices",
		"/admin/main/profit-margin",
		"/admin/main/employee-requests",
		"/admin/main/timesheet",
		"/admin/main/leave",
		"/admin/main/contracts",
		"/admin/main/applications/kanban",
		"/admin/main/applications/calendar",
		"/admin/main/profile/overview",
		"/admin/main/profile/settings",
	],
	finance: [
		"/admin/dashboards/default",
		"/admin/main/expenses",
		"/admin/main/salaries",
		"/admin/main/invoices",
		"/admin/main/profit-margin",
		"/admin/main/financial/dashboard",
		"/admin/main/financial/chart-of-accounts",
		"/admin/main/financial/journal-entries",
		"/admin/main/financial/trial-balance",
		"/admin/main/financial/profit-loss",
		"/admin/main/financial/balance-sheet",
		"/admin/main/financial/disbursements",
		"/admin/main/profile/overview",
		"/admin/main/profile/settings",
	],
	user: [
		"/admin/dashboards/default",
		"/admin/main/employee-requests",
		"/admin/main/timesheet",
		"/admin/main/leave",
		"/admin/main/contracts",
		"/admin/main/profile/overview",
		"/admin/main/profile/settings",
	],
	// BDMs see only Sales pages and their own profile
	bdm: [
		"/admin/dashboards/default",
		"/admin/main/sales/pipeline",
		"/admin/main/sales/deals",
		"/admin/main/sales/contacts",
		"/admin/main/sales/activities",
		"/admin/main/sales/reports",
		"/admin/main/profile/overview",
		"/admin/main/profile/settings",
	],
};

function defaultsForRole(role: string): string[] {
	return DEFAULT_ROUTES[role] ?? DEFAULT_ROUTES["user"];
}

/**
 * Effective allowed routes for a user: super_admin → all; otherwise the stored
 * grant, falling back to the role defaults when no explicit record exists.
 * Shared by the frontend `/permissions/me` and the internal endpoint the auth
 * handler uses to load grants into the auth context.
 */
async function computeAllowedRoutes(
	userId: string,
	role: string,
): Promise<string[]> {
	if (role === "super_admin") return ["*"];
	const row = await db.rawQueryRow<{ allowed_routes: string[] }>(
		`SELECT allowed_routes FROM user_permissions WHERE user_id = $1`,
		userId,
	);
	return row ? row.allowed_routes : defaultsForRole(role);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserPermissionRecord {
	user_id: string;
	allowed_routes: string[];
	updated_by: string | null;
	updated_at: string;
}

// ─── GET /permissions/me ──────────────────────────────────────────────────────
// Returns the allowed_routes for the currently logged-in user.

export const getMyPermissions = api(
	{ expose: true, method: "GET", path: "/permissions/me", auth: true },
	async (): Promise<{ allowed_routes: string[]; is_default: boolean }> => {
		const { userID, role } = getAuthData()!;

		if (role === "super_admin") {
			return { allowed_routes: ["*"], is_default: true };
		}

		const row = await db.rawQueryRow<{ allowed_routes: string[] }>(
			`SELECT allowed_routes FROM user_permissions WHERE user_id = $1`,
			userID,
		);

		if (!row) {
			return { allowed_routes: defaultsForRole(role), is_default: true };
		}
		return { allowed_routes: row.allowed_routes, is_default: false };
	},
);

// ─── Internal: effective routes for the auth context ──────────────────────────
// Called by the auth handler on each request to load a user's module grants into
// AuthData. Internal + unauthenticated (the auth handler runs before auth data
// exists); the caller passes the already-validated user_id and role.

export const getEffectiveRoutes = api(
	{ expose: false, auth: false, method: "POST", path: "/internal/permissions/effective-routes" },
	async ({
		user_id,
		role,
	}: {
		user_id: string;
		role: string;
	}): Promise<{ allowed_routes: string[] }> => {
		return { allowed_routes: await computeAllowedRoutes(user_id, role) };
	},
);

// ─── GET /permissions/:userId ─────────────────────────────────────────────────
// Super admin only: get permissions for any user.

export const getUserPermissions = api(
	{ expose: true, method: "GET", path: "/permissions/:userId", auth: true },
	async ({
		userId,
	}: {
		userId: string;
	}): Promise<{
		allowed_routes: string[];
		is_default: boolean;
		role: string;
	}> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");

		// Fetch user's role from user service
		let targetRole = "user";
		try {
			const contact = await user.getContact({ id: userId });
			targetRole = contact.role ?? "user";
		} catch {
			/* non-fatal */
		}

		const row = await db.rawQueryRow<{ allowed_routes: string[] }>(
			`SELECT allowed_routes FROM user_permissions WHERE user_id = $1`,
			userId,
		);

		if (!row) {
			return {
				allowed_routes: defaultsForRole(targetRole),
				is_default: true,
				role: targetRole,
			};
		}
		return {
			allowed_routes: row.allowed_routes,
			is_default: false,
			role: targetRole,
		};
	},
);

// ─── PUT /permissions/:userId ─────────────────────────────────────────────────
// Super admin only: update route permissions for a user.
// After saving, the user's sessions are invalidated → forced re-login.

export const setUserPermissions = api(
	{ expose: true, method: "PUT", path: "/permissions/:userId", auth: true },
	async ({
		userId,
		allowed_routes,
	}: {
		userId: string;
		allowed_routes: string[];
	}): Promise<{ ok: boolean }> => {
		const { userID, role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");
		if (!Array.isArray(allowed_routes))
			throw APIError.invalidArgument("allowed_routes must be an array");

		const existing = await db.rawQueryRow<{ id: string }>(
			`SELECT id FROM user_permissions WHERE user_id = $1`,
			userId,
		);

		if (existing) {
			await db.exec`
				UPDATE user_permissions
				SET allowed_routes = ${allowed_routes},
				    updated_by = ${userID},
				    updated_at = NOW()
				WHERE user_id = ${userId}
			`;
		} else {
			await db.exec`
				INSERT INTO user_permissions (id, user_id, allowed_routes, updated_by)
				VALUES (${crypto.randomUUID()}, ${userId}, ${allowed_routes}, ${userID})
			`;
		}

		// Invalidate user's sessions → they must re-login
		void user
			.invalidateSessionsForUser({ user_id: userId })
			.catch((err: unknown) => {
				log.error("failed to invalidate sessions", {
					userId,
					error: String(err),
				});
			});

		return { ok: true };
	},
);

// ─── DELETE /permissions/:userId ──────────────────────────────────────────────
// Super admin only: reset a user back to role-based defaults.

export const resetUserPermissions = api(
	{ expose: true, method: "DELETE", path: "/permissions/:userId", auth: true },
	async ({ userId }: { userId: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");

		await db.exec`DELETE FROM user_permissions WHERE user_id = ${userId}`;

		void user
			.invalidateSessionsForUser({ user_id: userId })
			.catch((err: unknown) => {
				log.error("failed to invalidate sessions", {
					userId,
					error: String(err),
				});
			});

		return { ok: true };
	},
);
