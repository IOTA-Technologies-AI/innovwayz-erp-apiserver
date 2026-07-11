import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { appMeta } from "encore.dev";
import { secret } from "encore.dev/config";
import { Topic } from "encore.dev/pubsub";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import log from "encore.dev/log";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

/** Hash a password with a given salt using scrypt. */
async function hashPassword(password: string, salt: string): Promise<string> {
	const buf = (await scrypt(password, salt, 64)) as Buffer;
	return buf.toString("hex");
}

/** Validate a plain-text password against a stored "salt:hash" value. */
async function verifyPassword(
	password: string,
	storedHash: string,
): Promise<boolean> {
	const [salt, hash] = storedHash.split(":");
	if (!salt || !hash) return false;
	const derived = await hashPassword(password, salt);
	// Constant-time comparison
	return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
}

// Landing page with setup instructions and API documentation.
export const index = api.raw(
	{ expose: true, method: "GET", path: "/" },
	async (req, resp) => {
		const baseUrl = appMeta().apiBaseUrl;
		resp.setHeader("Content-Type", "text/html");
		resp.end(landingPage.replaceAll("{{baseUrl}}", baseUrl));
	},
);

const landingPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Multi-Service SaaS Backend</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 2rem; max-width: 720px; margin: 0 auto; line-height: 1.6; }
    h1 { font-size: 1.75rem; margin-bottom: 0.5rem; color: #fff; }
    h2 { font-size: 1.1rem; margin-top: 2rem; margin-bottom: 0.75rem; color: #fff; }
    h3 { font-size: 0.95rem; margin-top: 1.5rem; margin-bottom: 0.5rem; color: #d4d4d4; }
    p { margin-bottom: 1rem; color: #a3a3a3; }
    code { background: #1a1a1a; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; color: #e5e5e5; }
    pre { background: #1a1a1a; border: 1px solid #262626; border-radius: 8px; padding: 1rem; overflow-x: auto; margin-bottom: 1rem; }
    pre code { background: none; padding: 0; }
    .endpoint { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
    .method { font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.5rem; border-radius: 4px; font-family: monospace; }
    .post { background: #1d4ed8; color: #fff; }
    .get { background: #15803d; color: #fff; }
    .path { font-family: monospace; color: #e5e5e5; }
    .desc { color: #737373; font-size: 0.9rem; margin-bottom: 1.25rem; }
    a { color: #60a5fa; }
    .badge { display: inline-block; background: #1d4ed8; color: #fff; font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 999px; margin-left: 0.5rem; font-weight: 600; vertical-align: middle; position: relative; top: -0.15em; }
  </style>
</head>
<body>
  <h1>Multi-Service SaaS <span class="badge">Encore.ts</span></h1>
  <p>A SaaS backend starter with user management, billing, and project management. Demonstrates event-driven provisioning, plan-based limits, and database-per-service architecture.</p>

  <p>Explore and test endpoints in the <a href="http://localhost:9400/">Local Dashboard</a> when running locally. When deployed to <a href="https://app.encore.cloud">Encore Cloud</a>, use the Service Catalog to call endpoints and view traces to see how requests flow between services.</p>

  <h2>Setup</h2>
  <p>No secrets or manual configuration needed. The Postgres databases are provisioned automatically when you run <code>encore run</code>. Each service gets its own database.</p>

  <h2>Architecture</h2>
  <p>When a user is created, the <strong>billing</strong> service automatically provisions a free subscription via Pub/Sub. The <strong>project</strong> service enforces plan-based limits (free: 3, pro: 25, enterprise: unlimited).</p>

  <h2>Authentication</h2>
  <p>Billing and project endpoints require authentication. This example includes a placeholder auth handler that reads the user ID from the <code>?auth_user=</code> query parameter. In a real app, you would replace this with a proper auth implementation (e.g. JWT validation, session cookies, or an auth provider like Clerk or Auth0).</p>

  <h2>Endpoints</h2>

  <h3>Users</h3>

  <div class="endpoint">
    <span class="method post">POST</span>
    <span class="path">/users</span>
    <code>user.create</code>
  </div>
  <p class="desc">Create a new user. Triggers automatic free plan provisioning.</p>
  <pre><code>curl -X POST {{baseUrl}}/users \\
  -H "Content-Type: application/json" \\
  -d '{"email": "alice@example.com", "name": "Alice"}'</code></pre>

  <div class="endpoint">
    <span class="method get">GET</span>
    <span class="path">/users/:id</span>
    <code>user.get</code>
  </div>
  <p class="desc">Get a user by ID.</p>
  <pre><code>curl {{baseUrl}}/users/&lt;user_id&gt;</code></pre>

  <div class="endpoint">
    <span class="method get">GET</span>
    <span class="path">/users</span>
    <code>user.list</code>
  </div>
  <p class="desc">List all users.</p>
  <pre><code>curl {{baseUrl}}/users</code></pre>

  <h3>Billing</h3>

  <div class="endpoint">
    <span class="method get">GET</span>
    <span class="path">/billing</span>
    <code>billing.get</code>
  </div>
  <p class="desc">Get billing info for the authenticated user. Auto-created after user signup.</p>
  <pre><code>curl "{{baseUrl}}/billing?auth_user=&lt;user_id&gt;"</code></pre>

  <div class="endpoint">
    <span class="method post">POST</span>
    <span class="path">/billing/upgrade</span>
    <code>billing.upgrade</code>
  </div>
  <p class="desc">Upgrade the authenticated user's plan. Options: free, pro, enterprise.</p>
  <pre><code>curl -X POST "{{baseUrl}}/billing/upgrade?auth_user=&lt;user_id&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"plan": "pro"}'</code></pre>

  <h3>Projects</h3>

  <div class="endpoint">
    <span class="method post">POST</span>
    <span class="path">/projects</span>
    <code>project.create</code>
  </div>
  <p class="desc">Create a project. Enforces plan-based limits (free: 3, pro: 25, enterprise: unlimited). Requires authentication.</p>
  <pre><code>curl -X POST "{{baseUrl}}/projects?auth_user=&lt;user_id&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My Project", "description": "A great project"}'</code></pre>

  <div class="endpoint">
    <span class="method get">GET</span>
    <span class="path">/projects/:id</span>
    <code>project.get</code>
  </div>
  <p class="desc">Get a project by ID.</p>
  <pre><code>curl {{baseUrl}}/projects/&lt;project_id&gt;</code></pre>

  <div class="endpoint">
    <span class="method get">GET</span>
    <span class="path">/projects</span>
    <code>project.list</code>
  </div>
  <p class="desc">List projects. Optionally filter by owner.</p>
  <pre><code>curl {{baseUrl}}/projects
curl "{{baseUrl}}/projects?owner_id=&lt;user_id&gt;"</code></pre>

</body>
</html>`;

const db = new SQLDatabase("user", {
	migrations: "./migrations",
});

export interface UserCreatedEvent {
	user_id: string;
	email: string;
	name: string;
}

export const UserCreatedTopic = new Topic<UserCreatedEvent>("user-created", {
	deliveryGuarantee: "at-least-once",
});

interface CreateUserRequest {
	email: string;
	name: string;
}

interface User {
	id: string;
	email: string;
	name: string;
	role: string;
	created_at: string;
}

// Create a new user. Publishes a UserCreated event for downstream services.
export const create = api(
	{ expose: true, auth: false, method: "POST", path: "/users" },
	async ({ email, name }: CreateUserRequest): Promise<User> => {
		const id = crypto.randomUUID();

		await db.exec`
      INSERT INTO users (id, email, name)
      VALUES (${id}, ${email}, ${name})
    `;

		await UserCreatedTopic.publish({ user_id: id, email, name });

		return {
			id,
			email,
			name,
			role: "user",
			created_at: new Date().toISOString(),
		};
	},
);

// Get a user by ID.
export const get = api(
	{ expose: true, auth: false, method: "GET", path: "/users/:id" },
	async ({ id }: { id: string }): Promise<User> => {
		const row = await db.queryRow<User>`
      SELECT id, email, name, role, created_at
      FROM users WHERE id = ${id}
    `;
		if (!row) throw APIError.notFound("user not found");
		return row;
	},
);

// List all users.
export const list = api(
	{ expose: true, auth: false, method: "GET", path: "/users" },
	async (): Promise<{ users: User[] }> => {
		const rows = db.query<User>`
      SELECT id, email, name, role, created_at
      FROM users ORDER BY created_at DESC
    `;
		const users: User[] = [];
		for await (const row of rows) {
			users.push(row);
		}
		return { users };
	},
);

// ─── Auth endpoints ──────────────────────────────────────────────────────────

interface RegisterRequest {
	email: string;
	name: string;
	password: string;
}

interface LoginRequest {
	email: string;
	password: string;
}

export interface LoginResponse {
	token: string;
	user: User;
}

/**
 * Register a new user with email + password.
 * Publishes a UserCreated event for downstream services (billing, etc.).
 */
export const register = api(
	{ expose: true, auth: false, method: "POST", path: "/auth/register" },
	async ({ email, name, password }: RegisterRequest): Promise<User> => {
		if (!email || !name || !password) {
			throw APIError.invalidArgument("email, name and password are required");
		}
		const plainPassword = await decryptPassword(password);
		if (plainPassword.length < 8) {
			throw APIError.invalidArgument("password must be at least 8 characters");
		}

		const id = crypto.randomUUID();
		const salt = crypto.randomBytes(16).toString("hex");
		const hash = await hashPassword(plainPassword, salt);
		const passwordHash = `${salt}:${hash}`;

		try {
			await db.exec`
        INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${email}, ${name}, ${passwordHash})
      `;
		} catch (err: unknown) {
			const msg = String(err);
			if (msg.includes("unique") || msg.includes("duplicate")) {
				throw APIError.alreadyExists("email already registered");
			}
			throw err;
		}

		await UserCreatedTopic.publish({ user_id: id, email, name });

		return {
			id,
			email,
			name,
			role: "user",
			created_at: new Date().toISOString(),
		};
	},
);

/**
 * Returns the RSA public key in PEM format so the frontend can encrypt
 * credentials before sending them over the wire.
 */
export const getPublicKey = api(
	{ expose: true, auth: false, method: "GET", path: "/auth/public-key" },
	async (): Promise<{ publicKey: string }> => {
		let pem: string;
		try {
			pem = rsaPrivateKeySecret();
		} catch {
			throw APIError.notFound("RSA key not configured");
		}
		const privateKey = crypto.createPrivateKey(pem);
		const pub = crypto.createPublicKey(privateKey);
		return {
			publicKey: pub.export({ type: "spki", format: "pem" }) as string,
		};
	},
);

/** Internal endpoint used by the auth handler to validate session tokens. */
export const validateToken = api(
	{ expose: false, auth: false, method: "GET", path: "/auth/validate" },
	async ({
		token,
	}: {
		token: string;
	}): Promise<{ user_id: string; role: string }> => {
		const row = await db.queryRow<{
			user_id: string;
			expires_at: string;
			last_active_at: string;
			role: string;
		}>`
      SELECT s.user_id, s.expires_at, s.last_active_at, u.role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ${token}
    `;

		if (!row) throw APIError.unauthenticated("invalid token");
		if (new Date(row.expires_at) < new Date()) {
			throw APIError.unauthenticated("token expired");
		}

		// Inactivity lock: if last activity was more than 6 hours ago
		const sixHoursMs = 6 * 60 * 60 * 1000;
		if (Date.now() - new Date(row.last_active_at).getTime() > sixHoursMs) {
			throw APIError.unauthenticated("session_inactive");
		}

		// Extend session activity timestamp on every validated request
		await db.exec`UPDATE sessions SET last_active_at = NOW() WHERE token = ${token}`;

		return { user_id: row.user_id, role: row.role };
	},
);

/**
 * Logout — invalidates the session token.
 * Requires the token to be passed in the request body.
 */
export const logout = api(
	{ expose: true, auth: false, method: "POST", path: "/auth/logout" },
	async ({ token }: { token: string }): Promise<{ ok: boolean }> => {
		await db.exec`DELETE FROM sessions WHERE token = ${token}`;
		return { ok: true };
	},
);

// ─── Session lock / inactivity OTP ───────────────────────────────────────────

/**
 * Send an OTP to the user's email when their session is locked due to
 * inactivity. The token is still present in DB (just inactive).
 */
export const sendLockOtp = api(
	{ expose: true, auth: false, method: "POST", path: "/auth/lock-otp" },
	async ({
		token,
	}: {
		token: string;
	}): Promise<{ ok: boolean; email: string }> => {
		if (!token) throw APIError.invalidArgument("token is required");

		// Find user from session — ignores last_active_at, only checks existence + expiry
		const session = await db.queryRow<{
			user_id: string;
			expires_at: string;
		}>`SELECT user_id, expires_at FROM sessions WHERE token = ${token}`;

		if (!session) throw APIError.unauthenticated("invalid token");
		if (new Date(session.expires_at) < new Date())
			throw APIError.unauthenticated(
				"session fully expired — please log in again",
			);

		const user = await db.queryRow<{ email: string; name: string }>`
			SELECT email, name FROM users WHERE id = ${session.user_id}
		`;
		if (!user) throw APIError.notFound("user not found");

		// Generate 6-digit OTP (10-minute expiry)
		const code = String(Math.floor(100000 + Math.random() * 900000));
		const otpId = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

		// Invalidate previous OTPs for this email
		await db.exec`UPDATE otp_codes SET used_at = NOW() WHERE email = ${user.email} AND used_at IS NULL`;

		await db.exec`
			INSERT INTO otp_codes (id, email, code, expires_at)
			VALUES (${otpId}, ${user.email}, ${code}, ${expiresAt.toISOString()})
		`;

		await sendEmail(
			user.email,
			"InnovWayz ERP — session verification code",
			`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:#0f172a;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
            <span style="color:#ffffff;font-size:22px;font-weight:700;">InnovWayz ERP</span>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:40px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
            <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;">Session Verification</h2>
            <p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.6;">Hi <strong>${user.name}</strong>,</p>
            <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
              Your session was locked due to inactivity. Enter this code to resume your session.
              It expires in <strong>10 minutes</strong>.
            </p>
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr><td align="center" style="padding:8px 0 12px;">
                <p style="margin:0 0 10px;color:#64748b;font-size:13px;">Copy and paste this code on the verification page:</p>
                <div style="display:inline-block;background:#f1f5f9;border-radius:12px;padding:24px 44px;border:2px dashed #c7d2fe;">
                  <span style="font-size:48px;font-weight:800;letter-spacing:14px;color:#4f46e5;font-variant-numeric:tabular-nums;font-family:'Courier New',monospace;">${code}</span>
                </div>
                <p style="margin:10px 0 0;color:#94a3b8;font-size:12px;">Select the code above, copy it, then paste it on the verification screen that is open in your browser.</p>
              </td></tr>
            </table>
            <p style="margin:24px 0 0;color:#94a3b8;font-size:13px;">If you did not request this, your account may be at risk — please contact your administrator.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} InnovWayz Technologies. All Rights Reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
		);

		return { ok: true, email: user.email };
	},
);

/**
 * Unlock a locked session using an OTP sent to the user's email.
 * Resets last_active_at so the session continues without issuing a new token.
 */
export const unlockSession = api(
	{ expose: true, auth: false, method: "POST", path: "/auth/unlock-session" },
	async ({
		token,
		email,
		code,
	}: {
		token: string;
		email: string;
		code: string;
	}): Promise<{ ok: boolean }> => {
		if (!token || !email || !code)
			throw APIError.invalidArgument("token, email and code are required");

		// Validate OTP
		const otp = await db.queryRow<{
			id: string;
			expires_at: string;
			used_at: string | null;
		}>`
			SELECT id, expires_at, used_at
			FROM otp_codes
			WHERE email = ${email} AND code = ${code}
			ORDER BY created_at DESC
			LIMIT 1
		`;

		if (!otp || otp.used_at)
			throw APIError.unauthenticated("invalid or already-used code");
		if (new Date(otp.expires_at) < new Date())
			throw APIError.unauthenticated("code has expired");

		// Validate the session still exists and isn't fully expired
		const session = await db.queryRow<{ expires_at: string }>`
			SELECT expires_at FROM sessions WHERE token = ${token}
		`;
		if (!session) throw APIError.unauthenticated("session not found");
		if (new Date(session.expires_at) < new Date())
			throw APIError.unauthenticated(
				"session fully expired — please log in again",
			);

		// Mark OTP as used
		await db.exec`UPDATE otp_codes SET used_at = NOW() WHERE id = ${otp.id}`;

		// Reset last_active_at — the session is now active again
		await db.exec`UPDATE sessions SET last_active_at = NOW() WHERE token = ${token}`;

		return { ok: true };
	},
);

// ─── Encore secrets ──────────────────────────────────────────────────────────

const resendApiKey = secret("RESEND_API_KEY");
const resendFromEmail = secret("RESEND_FROM_EMAIL");
const appUrl = secret("APP_URL");
const rsaPrivateKeySecret = secret("RSA_PRIVATE_KEY");

// ─── RSA credential decryption ────────────────────────────────────────────────

/**
 * Decrypt a base64-encoded RSA-OAEP-SHA256 ciphertext sent by the frontend.
 * Falls back to treating the value as plaintext when RSA_PRIVATE_KEY is not
 * configured (local development without secrets).
 */
async function decryptPassword(value: string): Promise<string> {
	let pem: string;
	try {
		pem = rsaPrivateKeySecret();
	} catch {
		// Secret not configured — treat value as plaintext (dev only)
		return value;
	}
	try {
		const privateKey = crypto.createPrivateKey(pem);
		const buffer = Buffer.from(value, "base64");
		const decrypted = crypto.privateDecrypt(
			{
				key: privateKey,
				padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			buffer,
		);
		return decrypted.toString("utf8");
	} catch {
		// Decryption failed — might be plaintext from a dev environment
		return value;
	}
}

// ─── Resend email helper ──────────────────────────────────────────────────────

async function sendEmail(
	to: string,
	subject: string,
	html: string,
): Promise<void> {
	const fromEmail =
		resendFromEmail() || "InnovWayz ERP <noreply@emails.innovwayz.io>";
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${resendApiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: fromEmail, to, subject, html }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Resend error ${res.status}: ${body}`);
	}
}

// ─── Invite-only registration ─────────────────────────────────────────────────

interface InviteRequest {
	email: string;
	name: string;
	role?: "super_admin" | "admin" | "manager" | "finance" | "user";
}

/**
 * Invite a new user. Creates an inactive user record and sends an invite email.
 * Requires the caller to be authenticated.
 */
export const invite = api(
	{ expose: true, auth: true, method: "POST", path: "/auth/invite" },
	async ({
		email,
		name,
		role = "user",
	}: InviteRequest): Promise<{ ok: boolean }> => {
		if (!email || !name)
			throw APIError.invalidArgument("email and name are required");

		// Restrict invitations to @innovwayz.com domain only
		const emailDomain = email.split("@")[1]?.toLowerCase();
		if (emailDomain !== "innovwayz.com")
			throw APIError.invalidArgument(
				"invitations are restricted to @innovwayz.com email addresses",
			);

		// Validate role
		const validRoles = ["super_admin", "admin", "manager", "finance", "user"];
		if (!validRoles.includes(role))
			throw APIError.invalidArgument("invalid role");

		// Check if already registered
		const existing = await db.queryRow<{ id: string }>`
      SELECT id FROM users WHERE email = ${email}
    `;
		if (existing) throw APIError.alreadyExists("email already registered");

		// Create inactive user with specified role
		const userId = crypto.randomUUID();
		await db.exec`
      INSERT INTO users (id, email, name, role, is_active)
      VALUES (${userId}, ${email}, ${name}, ${role}, FALSE)
    `;

		// Create invitation token (valid 7 days)
		const token = crypto.randomBytes(32).toString("hex");
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await db.exec`
      INSERT INTO invitations (token, email, name, expires_at)
      VALUES (${token}, ${email}, ${name}, ${expiresAt.toISOString()})
    `;

		const baseUrl = appUrl() || "https://erp.innovwayz.io";
		const inviteLink = `${baseUrl}/auth/accept-invite?token=${token}`;
		await sendEmail(
			email,
			"You're invited to InnovWayz ERP",
			`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Banner -->
        <tr>
          <td style="background:#0f172a;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
            <img src="https://innovwayz.com/images/logo/symbol.avif"
                 alt="InnovWayz"
                 height="44"
                 style="display:inline-block;vertical-align:middle;margin-right:14px;border:0;width:auto;" />
            <span style="color:#ffffff;font-size:22px;font-weight:700;vertical-align:middle;letter-spacing:-0.3px;">InnovWayz ERP</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:40px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
            <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;">You&rsquo;re Invited</h2>
            <p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.6;">Hi <strong>${name}</strong>,</p>
            <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">You&rsquo;ve been invited to access the <strong>InnovWayz ERP</strong> platform. Click the button below to set your password and get started.</p>
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr><td align="center" style="padding:8px 0 28px;">
                <a href="${inviteLink}"
                   style="display:inline-block;background:#4f46e5;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;">Accept Invitation</a>
              </td></tr>
            </table>
            <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;">This link expires in <strong>7 days</strong>. If you didn&rsquo;t expect this invitation, you can safely ignore this email.</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} InnovWayz Technologies. All Rights Reserved.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
		);

		return { ok: true };
	},
);

interface AcceptInviteRequest {
	token: string;
	password: string;
}

/**
 * Accept an invitation and set a password.
 */
export const acceptInvite = api(
	{ expose: true, auth: false, method: "POST", path: "/auth/accept-invite" },
	async ({ token, password }: AcceptInviteRequest): Promise<LoginResponse> => {
		if (!token || !password)
			throw APIError.invalidArgument("token and password are required");
		const plainPassword = await decryptPassword(password);
		if (plainPassword.length < 8)
			throw APIError.invalidArgument("password must be at least 8 characters");

		const inv = await db.queryRow<{
			email: string;
			name: string;
			expires_at: string;
			accepted_at: string | null;
		}>`
      SELECT email, name, expires_at, accepted_at FROM invitations WHERE token = ${token}
    `;

		if (!inv) throw APIError.notFound("invitation not found or already used");
		if (inv.accepted_at)
			throw APIError.failedPrecondition("invitation already accepted");
		if (new Date(inv.expires_at) < new Date())
			throw APIError.failedPrecondition("invitation has expired");

		const salt = crypto.randomBytes(16).toString("hex");
		const hash = await hashPassword(plainPassword, salt);
		const passwordHash = `${salt}:${hash}`;

		await db.exec`
      UPDATE users
      SET password_hash = ${passwordHash}, is_active = TRUE
      WHERE email = ${inv.email}
    `;

		await db.exec`
      UPDATE invitations SET accepted_at = NOW() WHERE token = ${token}
    `;

		// Auto-login after accepting invite
		const user = await db.queryRow<User>`
      SELECT id, email, name, role, created_at FROM users WHERE email = ${inv.email}
    `;
		if (!user) throw APIError.internal("user record missing");

		const sessionToken = crypto.randomBytes(32).toString("hex");
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await db.exec`
      INSERT INTO sessions (token, user_id, expires_at)
      VALUES (${sessionToken}, ${user.id}, ${expiresAt.toISOString()})
    `;

		return { token: sessionToken, user };
	},
);

// ─── List pending invitations ─────────────────────────────────────────────────

export interface InviteRecord {
	email: string;
	name: string;
	created_at: string;
	expires_at: string;
	accepted_at: string | null;
	is_expired: boolean;
}

export const listInvites = api(
	{ expose: true, auth: true, method: "GET", path: "/auth/invites" },
	async (): Promise<{ invites: InviteRecord[] }> => {
		const { role } = getAuthData()!;
		if (!["super_admin", "admin"].includes(role))
			throw APIError.permissionDenied("admin only");

		const rows = db.rawQuery<{
			email: string;
			name: string;
			created_at: string;
			expires_at: string;
			accepted_at: string | null;
		}>(
			`SELECT email, name, created_at, expires_at, accepted_at
			 FROM invitations ORDER BY created_at DESC`,
		);
		const invites: InviteRecord[] = [];
		for await (const r of rows) {
			invites.push({
				...r,
				is_expired: new Date(r.expires_at) < new Date() && !r.accepted_at,
			});
		}
		return { invites };
	},
);

// ─── Resend invitation ────────────────────────────────────────────────────────

export const resendInvite = api(
	{ expose: true, auth: true, method: "POST", path: "/auth/invites/resend" },
	async ({ email }: { email: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!["super_admin", "admin"].includes(role))
			throw APIError.permissionDenied("admin only");

		// Fetch the user name
		const userRow = await db.queryRow<{ name: string }>`
			SELECT name FROM users WHERE email = ${email} AND is_active = FALSE
		`;
		if (!userRow)
			throw APIError.notFound("pending invite not found for this email");

		// Expire old invite tokens for this email
		await db.exec`DELETE FROM invitations WHERE email = ${email}`;

		// Create a fresh token valid 7 days
		const token = crypto.randomBytes(32).toString("hex");
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await db.exec`
			INSERT INTO invitations (token, email, name, expires_at)
			VALUES (${token}, ${email}, ${userRow.name}, ${expiresAt.toISOString()})
		`;

		const baseUrl = appUrl() || "https://erp.innovwayz.io";
		const inviteLink = `${baseUrl}/auth/accept-invite?token=${token}`;
		await sendEmail(
			email,
			"Your InnovWayz ERP invitation (resent)",
			`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="background:#0f172a;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
          <span style="color:#fff;font-size:22px;font-weight:700;">InnovWayz ERP</span>
        </td></tr>
        <tr><td style="background:#fff;padding:40px;">
          <h2 style="margin:0 0 16px;color:#0f172a;">Invitation Resent</h2>
          <p style="color:#475569;font-size:15px;">Hi <strong>${userRow.name}</strong>, here is your updated invitation link:</p>
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td align="center" style="padding:16px 0;">
              <a href="${inviteLink}" style="display:inline-block;background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;">Accept Invitation</a>
            </td></tr>
          </table>
          <p style="color:#94a3b8;font-size:13px;">Expires in 7 days.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
		);

		return { ok: true };
	},
);

// ─── Cancel invitation ────────────────────────────────────────────────────────

export const cancelInvite = api(
	{ expose: true, auth: true, method: "DELETE", path: "/auth/invites/:email" },
	async ({ email }: { email: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!["super_admin", "admin"].includes(role))
			throw APIError.permissionDenied("admin only");

		await db.exec`DELETE FROM invitations WHERE email = ${email}`;
		await db.exec`DELETE FROM users WHERE email = ${email} AND is_active = FALSE`;

		return { ok: true };
	},
);

// ─── List all portal users (with active status) ───────────────────────────────

export interface PortalUser {
	id: string;
	email: string;
	name: string;
	role: string;
	is_active: boolean;
	created_at: string;
}

export const listPortalUsers = api(
	{ expose: true, auth: true, method: "GET", path: "/users/all" },
	async (): Promise<{ users: PortalUser[] }> => {
		const { role } = getAuthData()!;
		if (!["super_admin", "admin"].includes(role))
			throw APIError.permissionDenied("admin only");

		const rows = db.rawQuery<PortalUser>(
			`SELECT id, email, name, role, is_active, created_at
			 FROM users ORDER BY created_at DESC`,
		);
		const users: PortalUser[] = [];
		for await (const r of rows) users.push(r);
		return { users };
	},
);

// ─── Modified login: password check → OTP ────────────────────────────────────

/**
 * Step 1 of login: verify email + password, then send a 6-digit OTP.
 * Returns {otp_required: true} on success.
 */
export const loginWithOtp = api(
	{ expose: true, auth: false, method: "POST", path: "/auth/login" },
	async ({
		email,
		password,
	}: LoginRequest): Promise<{ otp_required: boolean; message: string }> => {
		if (!email || !password)
			throw APIError.invalidArgument("email and password are required");

		const plainPassword = await decryptPassword(password);

		const row = await db.queryRow<
			User & { password_hash: string; is_active: boolean }
		>`
      SELECT id, email, name, role, created_at, password_hash, is_active
      FROM users WHERE email = ${email}
    `;

		const valid = row
			? await verifyPassword(plainPassword, row.password_hash)
			: false;

		if (!row || !valid)
			throw APIError.unauthenticated("invalid email or password");
		if (!row.is_active)
			throw APIError.permissionDenied(
				"account not activated — check your invitation email",
			);

		// Generate 6-digit OTP
		const code = String(Math.floor(100000 + Math.random() * 900000));
		const otpId = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

		// Invalidate previous OTPs for this email
		await db.exec`
      UPDATE otp_codes SET used_at = NOW()
      WHERE email = ${email} AND used_at IS NULL
    `;

		await db.exec`
      INSERT INTO otp_codes (id, email, code, expires_at)
      VALUES (${otpId}, ${email}, ${code}, ${expiresAt.toISOString()})
    `;

		await sendEmail(
			email,
			"Your InnovWayz ERP verification code",
			`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Banner -->
        <tr>
          <td style="background:#0f172a;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
            <img src="https://innovwayz.com/images/logo/symbol.avif"
                 alt="InnovWayz"
                 height="44"
                 style="display:inline-block;vertical-align:middle;margin-right:14px;border:0;width:auto;" />
            <span style="color:#ffffff;font-size:22px;font-weight:700;vertical-align:middle;letter-spacing:-0.3px;">InnovWayz ERP</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:40px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
            <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;">Verification Code</h2>
            <p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.6;">Hi <strong>${row.name}</strong>,</p>
            <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">Enter this code in the app to complete sign in. It expires in <strong>10 minutes</strong>.</p>
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr><td align="center" style="padding:8px 0 12px;">
                <p style="margin:0 0 10px;color:#64748b;font-size:13px;">Copy and paste this code on the verification page:</p>
                <div style="display:inline-block;background:#f1f5f9;border-radius:12px;padding:24px 44px;border:2px dashed #c7d2fe;">
                  <span style="font-size:48px;font-weight:800;letter-spacing:14px;color:#4f46e5;font-variant-numeric:tabular-nums;font-family:'Courier New',monospace;">${code}</span>
                </div>
                <p style="margin:10px 0 0;color:#94a3b8;font-size:12px;">Select the code above, copy it, then paste it on the sign-in page that&rsquo;s already open in your browser.</p>
              </td></tr>
            </table>
            <p style="margin:24px 0 0;color:#94a3b8;font-size:13px;line-height:1.5;">If you didn&rsquo;t try to sign in, you can safely ignore this email.</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} InnovWayz Technologies. All Rights Reserved.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
		);

		return { otp_required: true, message: "OTP sent to your email" };
	},
);

interface VerifyOtpRequest {
	email: string;
	code: string;
}

/**
 * Step 2 of login: verify OTP, issue session token.
 */
export const verifyOtp = api(
	{ expose: true, auth: false, method: "POST", path: "/auth/verify-otp" },
	async ({ email, code }: VerifyOtpRequest): Promise<LoginResponse> => {
		if (!email || !code)
			throw APIError.invalidArgument("email and code are required");

		const otp = await db.queryRow<{
			id: string;
			expires_at: string;
			used_at: string | null;
		}>`
      SELECT id, expires_at, used_at
      FROM otp_codes
      WHERE email = ${email} AND code = ${code}
      ORDER BY created_at DESC
      LIMIT 1
    `;

		if (!otp || otp.used_at)
			throw APIError.unauthenticated("invalid or expired code");
		if (new Date(otp.expires_at) < new Date())
			throw APIError.unauthenticated("code has expired");

		// Mark OTP as used
		await db.exec`UPDATE otp_codes SET used_at = NOW() WHERE id = ${otp.id}`;

		const user = await db.queryRow<User>`
      SELECT id, email, name, role, created_at FROM users WHERE email = ${email}
    `;
		if (!user) throw APIError.notFound("user not found");

		const token = crypto.randomBytes(32).toString("hex");
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await db.exec`
      INSERT INTO sessions (token, user_id, expires_at)
      VALUES (${token}, ${user.id}, ${expiresAt.toISOString()})
    `;

		return { token, user };
	},
);

/**
 * Get current user by session token.
 */
export const me = api(
	{ expose: true, auth: false, method: "GET", path: "/auth/me" },
	async ({ token }: { token: string }): Promise<User> => {
		const session = await db.queryRow<{
			user_id: string;
			expires_at: string;
		}>`
      SELECT user_id, expires_at FROM sessions WHERE token = ${token}
    `;
		if (!session) throw APIError.unauthenticated("invalid token");
		if (new Date(session.expires_at) < new Date())
			throw APIError.unauthenticated("session expired");

		const user = await db.queryRow<User>`
      SELECT id, email, name, role, created_at FROM users WHERE id = ${session.user_id}
    `;
		if (!user) throw APIError.notFound("user not found");
		return user;
	},
);

// ─── Internal cross-service helpers ───────────────────────────────────────────

interface Recipient {
	id: string;
	email: string;
	name: string;
	role: string;
}

/**
 * Internal: list active users matching any of the given roles.
 * Used by other services (e.g. expenses) to resolve approval/notification
 * recipients such as managers, admins, or finance.
 */
export const listByRoles = api(
	{
		expose: false,
		auth: false,
		method: "POST",
		path: "/internal/users/by-roles",
	},
	async ({ roles }: { roles: string[] }): Promise<{ users: Recipient[] }> => {
		const users: Recipient[] = [];
		if (!roles || roles.length === 0) return { users };
		const rows = db.query<Recipient>`
      SELECT id, email, name, role
      FROM users
      WHERE is_active = TRUE AND role = ANY(${roles})
      ORDER BY name
    `;
		for await (const row of rows) users.push(row);
		return { users };
	},
);

/**
 * Internal: get a single user's contact details by id.
 */
export const getContact = api(
	{
		expose: false,
		auth: false,
		method: "GET",
		path: "/internal/users/:id/contact",
	},
	async ({ id }: { id: string }): Promise<Recipient> => {
		const row = await db.queryRow<Recipient>`
      SELECT id, email, name, role FROM users WHERE id = ${id}
    `;
		if (!row) throw APIError.notFound("user not found");
		return row;
	},
);

/**
 * Internal: send a notification email via Resend.
 * Exposed to other services so email sending stays centralized in the user service.
 */
export const sendNotification = api(
	{ expose: false, auth: false, method: "POST", path: "/internal/notify" },
	async ({
		to,
		subject,
		html,
	}: {
		to: string;
		subject: string;
		html: string;
	}): Promise<{ ok: boolean }> => {
		try {
			await sendEmail(to, subject, html);
			return { ok: true };
		} catch (err) {
			log.error("failed to send notification email", {
				to,
				subject,
				error: String(err),
			});
			return { ok: false };
		}
	},
);
/**
 * Internal: delete all active sessions for a user.
 * Called by the permissions service when access rights change.
 */
export const invalidateSessionsForUser = api(
	{
		expose: false,
		auth: false,
		method: "POST",
		path: "/internal/invalidate-sessions",
	},
	async ({ user_id }: { user_id: string }): Promise<{ ok: boolean }> => {
		await db.exec`DELETE FROM sessions WHERE user_id = ${user_id}`;
		// Write audit entry for the session flush
		void writeAuditLog({
			user_id,
			action: "session_flushed",
			resource: "/internal/invalidate-sessions",
			details: { reason: "permission_change" },
			result: "success",
			log_level: "info",
		}).catch(() => {
			/* non-critical */
		});
		return { ok: true };
	},
);

// ─── Audit Log helpers & endpoints ───────────────────────────────────────────

/** Internal helper: check current log level from system_settings. */
async function getAuditLogLevel(): Promise<"production" | "debug" | "verbose"> {
	try {
		const row = await db.queryRow<{ value: string }>`
      SELECT value FROM system_settings WHERE key = 'audit_log_level'
    `;
		const v = row?.value ?? "production";
		if (v === "debug" || v === "verbose" || v === "production") return v;
		return "production";
	} catch {
		return "production";
	}
}

/**
 * Internal helper: write an audit log entry.
 * Respects the configured log level:
 *   production → only 'info' events written
 *   debug      → 'info' + 'debug' events
 *   verbose    → all events
 */
export async function writeAuditLog(params: {
	user_id?: string;
	user_email?: string;
	user_name?: string;
	action: string;
	resource?: string;
	details?: Record<string, unknown>;
	ip_address?: string;
	user_agent?: string;
	result?: string;
	log_level?: string;
}): Promise<void> {
	const level = (params.log_level ?? "info") as string;
	const currentLevel = await getAuditLogLevel();

	// Skip events that are too verbose for current log level
	if (currentLevel === "production" && level !== "info") return;
	if (currentLevel === "debug" && level === "verbose") return;

	const id = crypto.randomUUID();
	await db.exec`
    INSERT INTO audit_log
      (id, user_id, user_email, user_name, action, resource, details,
       ip_address, user_agent, result, log_level)
    VALUES (
      ${id},
      ${params.user_id ?? null},
      ${params.user_email ?? null},
      ${params.user_name ?? null},
      ${params.action},
      ${params.resource ?? null},
      ${params.details ? JSON.stringify(params.details) : null},
      ${params.ip_address ?? null},
      ${params.user_agent ?? null},
      ${params.result ?? "success"},
      ${level}
    )
  `;
}

export interface AuditLogEntry {
	id: string;
	user_id: string | null;
	user_email: string | null;
	user_name: string | null;
	action: string;
	resource: string | null;
	details: string | null;
	ip_address: string | null;
	user_agent: string | null;
	result: string;
	log_level: string;
	created_at: string;
}

/**
 * Internal: write audit event — callable by other Encore services.
 */
export const writeAuditEvent = api(
	{ expose: false, auth: false, method: "POST", path: "/internal/audit/write" },
	async (params: {
		user_id?: string;
		user_email?: string;
		user_name?: string;
		action: string;
		resource?: string;
		details?: Record<string, unknown>;
		ip_address?: string;
		user_agent?: string;
		result?: string;
		log_level?: string;
	}): Promise<{ ok: boolean }> => {
		await writeAuditLog(params);
		return { ok: true };
	},
);

/**
 * POST /auth/audit — public endpoint the Next.js middleware can call
 * to log page_access_denied events (no auth required — user may not have session).
 */
export const logPageDenied = api(
	{
		expose: true,
		auth: false,
		method: "POST",
		path: "/auth/audit/page-denied",
	},
	async (req: {
		user_id?: string;
		user_email?: string;
		user_name?: string;
		resource: string;
		ip_address?: string;
		user_agent?: string;
	}): Promise<{ ok: boolean }> => {
		await writeAuditLog({
			...req,
			action: "page_access_denied",
			result: "denied",
			log_level: "info",
		});
		return { ok: true };
	},
);

/** GET /audit-log — admin/super_admin only. */
export const listAuditLog = api(
	{ expose: true, auth: true, method: "GET", path: "/audit-log" },
	async (req: {
		limit?: number;
		offset?: number;
		action?: string;
		result?: string;
		user_id?: string;
	}): Promise<{ entries: AuditLogEntry[]; total: number }> => {
		const { role } = getAuthData()!;
		if (!["super_admin", "admin"].includes(role.trim()))
			throw APIError.permissionDenied("admin only");

		const limit = Math.min(req.limit ?? 100, 500);
		const offset = req.offset ?? 0;

		type CountRow = { count: number };
		const countRow = await db.rawQueryRow<CountRow>(
			`SELECT COUNT(*)::int AS count FROM audit_log`,
		);
		const total = countRow?.count ?? 0;

		const rows = db.rawQuery<AuditLogEntry>(
			`SELECT id, user_id, user_email, user_name, action, resource, details,
       ip_address, user_agent, result, log_level, created_at
       FROM audit_log
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
			limit,
			offset,
		);
		const entries: AuditLogEntry[] = [];
		for await (const row of rows) entries.push(row);
		return { entries, total };
	},
);

/** GET /audit-log/settings — get current audit log level (admin). */
export const getAuditSettings = api(
	{ expose: true, auth: true, method: "GET", path: "/audit-log/settings" },
	async (): Promise<{ log_level: string }> => {
		const { role } = getAuthData()!;
		if (!["super_admin", "admin"].includes(role.trim()))
			throw APIError.permissionDenied("admin only");
		return { log_level: await getAuditLogLevel() };
	},
);

/** POST /audit-log/settings — update log level (super_admin only). */
export const setAuditSettings = api(
	{ expose: true, auth: true, method: "POST", path: "/audit-log/settings" },
	async (req: { log_level: string }): Promise<{ ok: boolean }> => {
		const { userID, role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");
		const valid = ["production", "debug", "verbose"];
		if (!valid.includes(req.log_level))
			throw APIError.invalidArgument(
				`log_level must be one of: ${valid.join(", ")}`,
			);
		await db.exec`
      INSERT INTO system_settings (key, value, updated_by, updated_at)
      VALUES ('audit_log_level', ${req.log_level}, ${userID}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `;
		await writeAuditLog({
			user_id: userID,
			action: "audit_settings_changed",
			resource: "/audit-log/settings",
			details: { new_level: req.log_level },
			result: "success",
			log_level: "info",
		});
		return { ok: true };
	},
);
