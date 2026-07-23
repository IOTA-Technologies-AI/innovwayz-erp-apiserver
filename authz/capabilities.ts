// ─────────────────────────────────────────────────────────────────────────────
// Shared authorization helpers.
//
// Access is granted two ways that this module unifies:
//   1. Role — the coarse role string (super_admin, admin, manager, finance, …).
//   2. Module grant — a per-user list of allowed frontend routes (from the
//      permissions service) loaded into the auth context as `allowedRoutes`.
//
// A user "has access to a module" if their role already privileges them OR the
// module's route was granted to them. Pure functions only — no Encore
// resources — so any service can import this directly.
// ─────────────────────────────────────────────────────────────────────────────

/** The frontend route that represents each capability-gated module. */
export const MODULE_ROUTES = {
	invoices: "/admin/main/invoices",
	expenses: "/admin/main/expenses",
	salaries: "/admin/main/salaries",
	profitMargin: "/admin/main/profit-margin",
	financial: "/admin/main/financial",
} as const;

export type ModuleRoute = (typeof MODULE_ROUTES)[keyof typeof MODULE_ROUTES];

/** Minimal auth shape these helpers need (a subset of AuthData). */
export interface AuthLike {
	role: string;
	/** Effective allowed routes; `["*"]` means everything. */
	allowedRoutes?: string[] | null;
}

/**
 * True when the user was granted the given module route. A grant matches when
 * it equals the module route, is nested under it, or the module route is nested
 * under the grant — the last case lets a Corp-Finance sub-route (e.g.
 * `/admin/main/financial/journal-entries`) satisfy the `financial` module.
 */
export function hasRouteGrant(
	allowedRoutes: string[] | null | undefined,
	route: string,
): boolean {
	if (!allowedRoutes || allowedRoutes.length === 0) return false;
	if (allowedRoutes.includes("*")) return true;
	return allowedRoutes.some(
		(r) =>
			r === route ||
			route.startsWith(`${r}/`) ||
			r.startsWith(`${route}/`),
	);
}

/**
 * True when the user may view/create/edit within a module — either because
 * their role already privileges them, or because the module route was granted.
 * super_admin always passes. Callers keep enforcing role-only checks for
 * sensitive terminal actions (delete, approvals, money movement, ledger posting).
 */
export function canAccessModule(
	auth: AuthLike,
	moduleRoute: string,
	privilegedRoles: string[] = [],
): boolean {
	if (auth.role === "super_admin") return true;
	if (privilegedRoles.includes(auth.role)) return true;
	return hasRouteGrant(auth.allowedRoutes, moduleRoute);
}
