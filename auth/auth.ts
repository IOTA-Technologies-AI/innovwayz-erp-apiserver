import { APIError, Gateway, Header } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { validateToken } from "../user/user";

// AuthParams reads a Bearer token from the Authorization header.
interface AuthParams {
	authorization: Header<"Authorization">;
}

// AuthData is available to all downstream services via auth.data().
interface AuthData {
	userID: string;
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

		const { user_id } = await validateToken({ token });
		return { userID: user_id };
	},
);

export const gw = new Gateway({
	authHandler: auth,
	cors: {
		allowOriginsWithCredentials: [
			"https://erp.innovwayz.io",
			// Allow local dev origins
			"http://localhost:3000",
			"http://localhost:3001",
		],
		allowOriginsWithoutCredentials: ["*"],
		allowHeaders: ["Authorization", "Content-Type"],
		exposeHeaders: ["Content-Type"],
	},
});
