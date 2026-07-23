import { APIError, Gateway, Header } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import log from "encore.dev/log";
import { permissions } from "~encore/clients";
import { validateToken } from "../user/user";

// AuthParams reads a Bearer token from the Authorization header.
interface AuthParams {
	authorization: Header<"Authorization">;
}

// AuthData is available to all downstream services via auth.data().
interface AuthData {
	userID: string;
	role: string;
	/**
	 * Effective module-access routes granted to this user (["*"] = all).
	 * Loaded from the permissions service so services can authorize by module
	 * grant, not just role. Empty on a permissions-service outage (degrades to
	 * role-based checks).
	 */
	allowedRoutes: string[];
}

/**
 * Auth handler — validates a session token issued by /auth/login.
 * Clients must send:  Authorization: Bearer <token>
 */
export const auth = authHandler<AuthParams, AuthData>(
	async (params): Promise<AuthData> => {
		const header = params.authorization ?? "";
		if (!header.startsWith("Bearer ")) {
			throw APIError.unauthenticated(
				"missing or malformed Authorization header",
			);
		}

		const token = header.slice("Bearer ".length).trim();
		if (!token) {
			throw APIError.unauthenticated("empty token");
		}

		const { user_id, role } = await validateToken({ token });

		// Load the user's module grants so downstream services can authorize by
		// module, not just role. Best-effort: a permissions outage must not break
		// authentication — fall back to empty (role-based checks still apply).
		let allowedRoutes: string[] = [];
		try {
			const res = await permissions.getEffectiveRoutes({ user_id, role });
			allowedRoutes = res.allowed_routes;
		} catch (err) {
			log.error("failed to load permissions for auth context", {
				user_id,
				error: String(err),
			});
		}

		return { userID: user_id, role, allowedRoutes };
	},
);

export const gw = new Gateway({
	authHandler: auth,
});
