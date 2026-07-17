import { api, APIError, Header } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user, billing } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";
import { sendOtp, verifyOtp, type OtpChannel } from "./authentica";
import {
	sniffType,
	ocrAndCompare,
	MAX_ATTACHMENT_BYTES,
} from "./attachment";

const db = new SQLDatabase("timesheet", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected";

export interface Timesheet {
	id: string;
	reference: string;
	employee_id: string | null;
	employee_name: string;
	customer_id: string | null;
	customer_name: string | null;
	period_month: number;
	period_year: number;
	total_working_days: number;
	days_present: number;
	leave_days: number;
	sick_leave_days: number;
	public_holidays: number;
	absent_days: number;
	overtime_hours: number;
	notes: string | null;
	file_url: string | null;
	status: TimesheetStatus;
	created_by: string;
	created_by_name: string | null;
	submitted_by: string | null;
	submitted_at: string | null;
	approved_by: string | null;
	approved_at: string | null;
	rejected_by: string | null;
	rejected_at: string | null;
	rejection_reason: string | null;
	created_at: string;
	updated_at: string;
	// Employee portal / attachment
	source: string;
	attachment_name: string | null;
	attachment_type: string | null;
	ocr_status: string | null;
	ocr_flags: string | null; // JSON array string
}

export interface TimesheetEvent {
	id: string;
	timesheet_id: string;
	action: string;
	performed_by: string;
	note: string | null;
	created_at: string;
}

// ─── Role helpers ─────────────────────────────────────────────────────────────

function isManager(role: string): boolean {
	return ["manager", "admin", "super_admin"].includes(role);
}
function isAdmin(role: string): boolean {
	return ["admin", "super_admin"].includes(role);
}

// ─── SQL helpers ──────────────────────────────────────────────────────────────

const TS_COLS = `
	id, reference,
	employee_id, employee_name, customer_id, customer_name,
	period_month, period_year,
	total_working_days, days_present, leave_days, sick_leave_days,
	public_holidays, absent_days, overtime_hours::float8 AS overtime_hours,
	notes, file_url, status,
	created_by, created_by_name, submitted_by, submitted_at,
	approved_by, approved_at, rejected_by, rejected_at, rejection_reason,
	created_at, updated_at,
	source, attachment_name, attachment_type, ocr_status, ocr_flags
`;

async function fetchTS(id: string): Promise<Timesheet> {
	const row = await db.rawQueryRow<Timesheet>(
		`SELECT ${TS_COLS} FROM timesheets WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("timesheet not found");
	return row;
}

async function nextRef(year: number): Promise<string> {
	const r = await db.rawQueryRow<{ ref: string }>(
		`SELECT 'TS-' || $1::TEXT || '-' || LPAD(NEXTVAL('timesheet_ref_seq')::TEXT, 6, '0') AS ref`,
		year,
	);
	return r!.ref;
}

async function logEvent(
	tsId: string,
	action: string,
	actorId: string,
	note?: string,
): Promise<void> {
	await db.exec`
		INSERT INTO timesheet_events (id, timesheet_id, action, performed_by, note)
		VALUES (${crypto.randomUUID()}, ${tsId}, ${action}, ${actorId}, ${note ?? null})
	`;
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notifyRoles(
	roles: string[],
	subject: string,
	html: string,
): Promise<void> {
	try {
		const { users } = await user.listByRoles({ roles });
		await Promise.all(
			users.map((u) => user.sendNotification({ to: u.email, subject, html })),
		);
	} catch (err) {
		log.error("failed to notify roles", { roles, error: String(err) });
	}
}

async function notifyUser(
	userId: string,
	subject: string,
	html: string,
): Promise<void> {
	try {
		const contact = await user.getContact({ id: userId });
		await user.sendNotification({ to: contact.email, subject, html });
	} catch (err) {
		log.error("failed to notify user", { userId, error: String(err) });
	}
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

function emailShell(heading: string, bodyRows: string): string {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#0f172a;border-radius:12px 12px 0 0;padding:24px 40px;text-align:center;">
        <span style="color:#fff;font-size:20px;font-weight:700;">InnovWayz ERP</span>
      </td></tr>
      <tr><td style="background:#fff;border-radius:0 0 12px 12px;padding:32px 40px;">
        <h2 style="margin:0 0 20px;color:#0f172a;font-size:18px;">${heading}</h2>
        <table width="100%" cellpadding="0" cellspacing="0">${bodyRows}</table>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function erow(label: string, value: string): string {
	return `<tr>
    <td style="padding:6px 0;color:#64748b;font-size:13px;width:45%;">${label}</td>
    <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${value}</td>
  </tr>`;
}

// ─── Create ───────────────────────────────────────────────────────────────────

interface CreateTimesheetInput {
	employee_id?: string;
	employee_name: string;
	customer_id?: string;
	customer_name?: string;
	period_month: number;
	period_year: number;
	total_working_days: number;
	days_present: number;
	leave_days?: number;
	sick_leave_days?: number;
	public_holidays?: number;
	absent_days?: number;
	overtime_hours?: number;
	notes?: string;
	file_url?: string;
}

interface TimesheetResponse {
	timesheet: Timesheet;
}

export const createTimesheet = api(
	{ expose: true, method: "POST", path: "/timesheets", auth: true },
	async (input: CreateTimesheetInput): Promise<TimesheetResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		if (input.period_month < 1 || input.period_month > 12)
			throw APIError.invalidArgument("period_month must be 1–12");

		let creatorName: string | null = null;
		try {
			creatorName = (await user.getContact({ id: userID })).name;
		} catch {
			/* non-fatal */
		}

		const id = crypto.randomUUID();
		const ref = await nextRef(input.period_year);

		await db.exec`
			INSERT INTO timesheets (
				id, reference, employee_id, employee_name, customer_id, customer_name,
				period_month, period_year,
				total_working_days, days_present, leave_days, sick_leave_days,
				public_holidays, absent_days, overtime_hours,
				notes, file_url, status, created_by, created_by_name
			) VALUES (
				${id}, ${ref},
				${input.employee_id ?? null}, ${input.employee_name},
				${input.customer_id ?? null}, ${input.customer_name ?? null},
				${input.period_month}, ${input.period_year},
				${input.total_working_days}, ${input.days_present},
				${input.leave_days ?? 0}, ${input.sick_leave_days ?? 0},
				${input.public_holidays ?? 0}, ${input.absent_days ?? 0},
				${input.overtime_hours ?? 0},
				${input.notes ?? null}, ${input.file_url ?? null},
				'draft', ${userID}, ${creatorName}
			)
		`;
		await logEvent(id, "created", userID);
		return { timesheet: await fetchTS(id) };
	},
);

// ─── List ─────────────────────────────────────────────────────────────────────

interface ListTimesheetsInput {
	status?: TimesheetStatus;
	employee_id?: string;
	employee_name?: string;
	period_month?: number;
	period_year?: number;
	mine?: boolean;
	limit?: number;
	offset?: number;
}

interface ListTimesheetsResponse {
	timesheets: Timesheet[];
	total: number;
}

export const listTimesheets = api(
	{ expose: true, method: "GET", path: "/timesheets", auth: true },
	async (input: ListTimesheetsInput): Promise<ListTimesheetsResponse> => {
		const { userID, role } = getAuthData()!;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		if (!isManager(role) || input.mine) add("created_by = $?", userID);
		if (input.status) add("status = $?", input.status);
		if (input.employee_id) add("employee_id = $?", input.employee_id);
		if (input.employee_name)
			add("UPPER(employee_name) LIKE UPPER($?)", `%${input.employee_name}%`);
		if (input.period_month) add("period_month = $?", input.period_month);
		if (input.period_year) add("period_year = $?", input.period_year);

		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

		const countRow = await db.rawQueryRow<{ n: string }>(
			`SELECT COUNT(*)::TEXT AS n FROM timesheets ${where}`,
			...args,
		);
		const total = parseInt(countRow?.n ?? "0", 10);

		const limit = Math.min(input.limit ?? 200, 500);
		const offset = input.offset ?? 0;
		const pagedArgs = [...args, limit, offset];
		const li = args.length + 1;
		const oi = args.length + 2;

		const rows = db.rawQuery<Timesheet>(
			`SELECT ${TS_COLS} FROM timesheets ${where}
			 ORDER BY period_year DESC, period_month DESC, employee_name ASC
			 LIMIT $${li} OFFSET $${oi}`,
			...pagedArgs,
		);
		const timesheets: Timesheet[] = [];
		for await (const r of rows) timesheets.push(r);
		return { timesheets, total };
	},
);

// ─── Get ──────────────────────────────────────────────────────────────────────

export const getTimesheet = api(
	{ expose: true, method: "GET", path: "/timesheets/:id", auth: true },
	async ({ id }: { id: string }): Promise<TimesheetResponse> => {
		const { userID, role } = getAuthData()!;
		const ts = await fetchTS(id);
		if (!isManager(role) && ts.created_by !== userID)
			throw APIError.permissionDenied("access denied");
		return { timesheet: ts };
	},
);

// ─── Update ───────────────────────────────────────────────────────────────────

interface UpdateTimesheetInput extends Partial<CreateTimesheetInput> {
	id: string;
}

export const updateTimesheet = api(
	{ expose: true, method: "PUT", path: "/timesheets/:id", auth: true },
	async (input: UpdateTimesheetInput): Promise<TimesheetResponse> => {
		const { userID, role } = getAuthData()!;
		const ts = await fetchTS(input.id);

		if (!isManager(role) && ts.created_by !== userID)
			throw APIError.permissionDenied("access denied");
		if (!["draft", "submitted"].includes(ts.status))
			throw APIError.failedPrecondition(`cannot edit a ${ts.status} timesheet`);

		await db.exec`
			UPDATE timesheets SET
				employee_name       = COALESCE(${input.employee_name ?? null}, employee_name),
				customer_name       = COALESCE(${input.customer_name ?? null}, customer_name),
				total_working_days  = COALESCE(${input.total_working_days ?? null}, total_working_days),
				days_present        = COALESCE(${input.days_present ?? null}, days_present),
				leave_days          = COALESCE(${input.leave_days ?? null}, leave_days),
				sick_leave_days     = COALESCE(${input.sick_leave_days ?? null}, sick_leave_days),
				public_holidays     = COALESCE(${input.public_holidays ?? null}, public_holidays),
				absent_days         = COALESCE(${input.absent_days ?? null}, absent_days),
				overtime_hours      = COALESCE(${input.overtime_hours ?? null}, overtime_hours),
				notes               = CASE WHEN ${input.notes !== undefined} THEN ${input.notes ?? null} ELSE notes END,
				file_url            = CASE WHEN ${input.file_url !== undefined} THEN ${input.file_url ?? null} ELSE file_url END,
				updated_at          = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "updated", userID);
		return { timesheet: await fetchTS(input.id) };
	},
);

// ─── Submit ───────────────────────────────────────────────────────────────────

export const submitTimesheet = api(
	{ expose: true, method: "POST", path: "/timesheets/:id/submit", auth: true },
	async ({ id }: { id: string }): Promise<TimesheetResponse> => {
		const { userID, role } = getAuthData()!;
		const ts = await fetchTS(id);
		if (!isManager(role) && ts.created_by !== userID)
			throw APIError.permissionDenied("access denied");
		if (ts.status !== "draft")
			throw APIError.failedPrecondition(
				`cannot submit a ${ts.status} timesheet`,
			);

		await db.exec`
			UPDATE timesheets
			SET status = 'submitted', submitted_by = ${userID}, submitted_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "submitted", userID);

		const monthName = MONTH_NAMES[ts.period_month - 1];
		const html = emailShell(
			`Timesheet Submitted for Review`,
			erow("Reference", ts.reference) +
				erow("Employee", ts.employee_name) +
				erow("Period", `${monthName} ${ts.period_year}`) +
				erow("Days Present", String(ts.days_present)) +
				erow("Leave Days", String(ts.leave_days)),
		);
		notifyRoles(
			["manager", "admin"],
			`[Timesheet] Submitted — ${ts.employee_name} ${monthName} ${ts.period_year}`,
			html,
		);

		return { timesheet: await fetchTS(id) };
	},
);

// ─── Approve ──────────────────────────────────────────────────────────────────

export const approveTimesheet = api(
	{ expose: true, method: "POST", path: "/timesheets/:id/approve", auth: true },
	async ({ id }: { id: string }): Promise<TimesheetResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const ts = await fetchTS(id);
		if (!["draft", "submitted"].includes(ts.status))
			throw APIError.failedPrecondition(
				`cannot approve a ${ts.status} timesheet`,
			);

		await db.exec`
			UPDATE timesheets
			SET status = 'approved', approved_by = ${userID}, approved_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "approved", userID);

		const monthName = MONTH_NAMES[ts.period_month - 1];
		const html = emailShell(
			`Your timesheet has been approved`,
			erow("Reference", ts.reference) +
				erow("Period", `${monthName} ${ts.period_year}`) +
				erow("Days Present", String(ts.days_present)) +
				erow("Status", "Approved"),
		);
		notifyUser(
			ts.created_by,
			`[Timesheet] Approved — ${monthName} ${ts.period_year}`,
			html,
		);

		return { timesheet: await fetchTS(id) };
	},
);

// ─── Reject ───────────────────────────────────────────────────────────────────

interface RejectTimesheetInput {
	id: string;
	reason?: string;
}

export const rejectTimesheet = api(
	{ expose: true, method: "POST", path: "/timesheets/:id/reject", auth: true },
	async (input: RejectTimesheetInput): Promise<TimesheetResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const ts = await fetchTS(input.id);
		if (!["draft", "submitted"].includes(ts.status))
			throw APIError.failedPrecondition(
				`cannot reject a ${ts.status} timesheet`,
			);

		await db.exec`
			UPDATE timesheets
			SET status = 'rejected',
			    rejected_by = ${userID},
			    rejected_at = NOW(),
			    rejection_reason = ${input.reason ?? null},
			    updated_at = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "rejected", userID, input.reason);

		const monthName = MONTH_NAMES[ts.period_month - 1];
		const html = emailShell(
			`Timesheet rejected`,
			erow("Reference", ts.reference) +
				erow("Period", `${monthName} ${ts.period_year}`) +
				(input.reason ? erow("Reason", input.reason) : ""),
		);
		notifyUser(
			ts.created_by,
			`[Timesheet] Rejected — ${monthName} ${ts.period_year}`,
			html,
		);

		return { timesheet: await fetchTS(input.id) };
	},
);

// ─── Delete ───────────────────────────────────────────────────────────────────

export const deleteTimesheet = api(
	{ expose: true, method: "DELETE", path: "/timesheets/:id", auth: true },
	async ({ id }: { id: string }): Promise<{ success: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");
		await db.exec`DELETE FROM timesheets WHERE id = ${id}`;
		return { success: true };
	},
);

// ─── Events ───────────────────────────────────────────────────────────────────

export const listTimesheetEvents = api(
	{ expose: true, method: "GET", path: "/timesheets/:id/events", auth: true },
	async ({ id }: { id: string }): Promise<{ events: TimesheetEvent[] }> => {
		const { userID, role } = getAuthData()!;
		const ts = await fetchTS(id);
		if (!isManager(role) && ts.created_by !== userID)
			throw APIError.permissionDenied("access denied");

		const rows = db.rawQuery<TimesheetEvent>(
			`SELECT id, timesheet_id, action, performed_by, note, created_at
			 FROM timesheet_events WHERE timesheet_id = $1 ORDER BY created_at ASC`,
			id,
		);
		const events: TimesheetEvent[] = [];
		for await (const r of rows) events.push(r);
		return { events };
	},
);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface TimesheetStatsResponse {
	total: number;
	draft: number;
	submitted: number;
	approved: number;
	rejected: number;
	total_days_present: number;
	total_leave_days: number;
	total_overtime_hours: number;
}

export const timesheetStats = api(
	{ expose: true, method: "GET", path: "/timesheets-stats", auth: true },
	async (): Promise<TimesheetStatsResponse> => {
		const { userID, role } = getAuthData()!;
		const scope = isManager(role) ? "" : `WHERE created_by = '${userID}'`;

		const r = await db.rawQueryRow<{
			total: string;
			draft: string;
			submitted: string;
			approved: string;
			rejected: string;
			total_days_present: string;
			total_leave_days: string;
			total_overtime_hours: string;
		}>(
			`SELECT
				COUNT(*)::TEXT                                        AS total,
				COUNT(*) FILTER (WHERE status='draft')::TEXT          AS draft,
				COUNT(*) FILTER (WHERE status='submitted')::TEXT      AS submitted,
				COUNT(*) FILTER (WHERE status='approved')::TEXT       AS approved,
				COUNT(*) FILTER (WHERE status='rejected')::TEXT       AS rejected,
				COALESCE(SUM(days_present),0)::TEXT                  AS total_days_present,
				COALESCE(SUM(leave_days),0)::TEXT                    AS total_leave_days,
				COALESCE(SUM(overtime_hours),0)::TEXT                AS total_overtime_hours
			FROM timesheets ${scope}`,
		);

		return {
			total: parseInt(r!.total, 10),
			draft: parseInt(r!.draft, 10),
			submitted: parseInt(r!.submitted, 10),
			approved: parseInt(r!.approved, 10),
			rejected: parseInt(r!.rejected, 10),
			total_days_present: parseInt(r!.total_days_present, 10),
			total_leave_days: parseInt(r!.total_leave_days, 10),
			total_overtime_hours: parseFloat(r!.total_overtime_hours),
		};
	},
);

// ─── Attachment download (ERP approvers) ──────────────────────────────────────

export const downloadTimesheetAttachment = api.raw(
	{ expose: true, auth: true, method: "GET", path: "/timesheets/:id/attachment" },
	async (req, resp) => {
		const { role } = getAuthData()!;
		const id = /\/timesheets\/([^/]+)\/attachment/.exec(req.url ?? "")?.[1];
		if (!id) {
			resp.writeHead(400, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "invalid id" }));
			return;
		}
		const row = await db.rawQueryRow<{
			created_by: string;
			attachment_name: string | null;
			attachment_type: string | null;
			attachment_data: string | null;
		}>(
			`SELECT created_by, attachment_name, attachment_type, attachment_data
			 FROM timesheets WHERE id = $1`,
			id,
		);
		if (!row?.attachment_data) {
			resp.writeHead(404, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "no attachment" }));
			return;
		}
		if (!isManager(role)) {
			resp.writeHead(403, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "managers only" }));
			return;
		}
		const buf = Buffer.from(row.attachment_data, "base64");
		resp.writeHead(200, {
			"Content-Type": row.attachment_type ?? "application/octet-stream",
			"Content-Disposition": `inline; filename="${row.attachment_name ?? "timesheet"}"`,
			"Content-Length": buf.length,
		});
		resp.end(buf);
	},
);

// ═════════════════════════════════════════════════════════════════════════════
// SELF-SERVICE EMPLOYEE PORTAL (public — OTP auth, not ERP auth)
// ═════════════════════════════════════════════════════════════════════════════

const PORTAL_SESSION_HOURS = 2;

function normalizeMobile(m: string): string {
	return m.replace(/[\s-]/g, "");
}

function maskTarget(s: string): string {
	if (s.includes("@")) {
		const [u, d] = s.split("@");
		return `${u.slice(0, 2)}***@${d}`;
	}
	return `${s.slice(0, 4)}••••${s.slice(-2)}`;
}

interface PortalSession {
	token: string;
	employee_id: string;
	employee_name: string;
	customer_id: string | null;
	customer_name: string | null;
	mobile_number: string | null;
}

async function authEmployee(token: string | undefined): Promise<PortalSession> {
	if (!token) throw APIError.unauthenticated("sign in required");
	const row = await db.rawQueryRow<PortalSession & { expires_at: string }>(
		`SELECT token, employee_id, employee_name, customer_id, customer_name, mobile_number,
		        expires_at::TEXT AS expires_at
		 FROM employee_sessions WHERE token = $1`,
		token,
	);
	if (!row) throw APIError.unauthenticated("your session is invalid — please sign in again");
	if (new Date(row.expires_at) < new Date()) {
		await db.exec`DELETE FROM employee_sessions WHERE token = ${token}`;
		throw APIError.unauthenticated("your session has expired — please sign in again");
	}
	return row;
}

/** current + previous month, as {month,year}. */
function allowedPeriods(): Array<{ month: number; year: number }> {
	const now = new Date();
	const cur = { month: now.getMonth() + 1, year: now.getFullYear() };
	const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const prev = { month: prevDate.getMonth() + 1, year: prevDate.getFullYear() };
	return [cur, prev];
}

// ─── Request OTP ──────────────────────────────────────────────────────────────

interface RequestOtpInput {
	mobile: string;
	channel?: OtpChannel;
}

export const requestPortalOtp = api(
	{ expose: true, auth: false, method: "POST", path: "/portal/request-otp" },
	async (input: RequestOtpInput): Promise<{ ok: boolean; channel: OtpChannel; target: string }> => {
		const mobile = normalizeMobile(input.mobile ?? "");
		if (!mobile) throw APIError.invalidArgument("mobile number is required");

		let emp: { name: string; mobile_number: string | null; email: string | null };
		try {
			emp = await billing.getEmployeeByMobile({ mobile });
		} catch {
			throw APIError.notFound("no employee is registered with that mobile number");
		}

		const channel: OtpChannel = input.channel ?? "sms";
		try {
			if (channel === "email") {
				if (!emp.email) {
					throw APIError.failedPrecondition(
						"no email is on file for this employee — use SMS or WhatsApp instead",
					);
				}
				await sendOtp({ channel, email: emp.email });
				return { ok: true, channel, target: maskTarget(emp.email) };
			}
			await sendOtp({ channel, phone: emp.mobile_number ?? mobile });
			return { ok: true, channel, target: maskTarget(emp.mobile_number ?? mobile) };
		} catch (err) {
			if (err instanceof APIError) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			log.error("portal otp send failed", { channel, error: msg });
			if (msg.includes("not configured")) {
				throw APIError.unavailable(
					"the SMS/OTP service is not configured yet — please contact your administrator",
				);
			}
			if (msg.includes("timed out")) {
				throw APIError.deadlineExceeded(
					"the verification service did not respond in time — please try again",
				);
			}
			throw APIError.unavailable(
				"could not send the verification code — please try again",
			);
		}
	},
);

// ─── Verify OTP → issue session ───────────────────────────────────────────────

interface VerifyOtpInput {
	mobile: string;
	otp: string;
	channel?: OtpChannel;
}

interface PortalLoginResponse {
	token: string;
	employee: {
		id: string;
		name: string;
		customer_name: string;
	};
	expires_at: string;
}

export const verifyPortalOtp = api(
	{ expose: true, auth: false, method: "POST", path: "/portal/verify-otp" },
	async (input: VerifyOtpInput): Promise<PortalLoginResponse> => {
		const mobile = normalizeMobile(input.mobile ?? "");
		if (!mobile || !input.otp?.trim()) {
			throw APIError.invalidArgument("mobile number and code are required");
		}

		let emp: {
			id: string;
			name: string;
			customer_id: string;
			customer_name: string;
			mobile_number: string | null;
			email: string | null;
		};
		try {
			emp = await billing.getEmployeeByMobile({ mobile });
		} catch {
			throw APIError.notFound("no employee is registered with that mobile number");
		}

		const channel: OtpChannel = input.channel ?? "sms";
		const verified =
			channel === "email"
				? await verifyOtp({ otp: input.otp.trim(), email: emp.email ?? undefined })
				: await verifyOtp({ otp: input.otp.trim(), phone: emp.mobile_number ?? mobile });
		if (!verified) throw APIError.unauthenticated("the code is incorrect or has expired");

		const token = crypto.randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.now() + PORTAL_SESSION_HOURS * 3600 * 1000);
		// One active session per employee — clear older ones.
		await db.exec`DELETE FROM employee_sessions WHERE employee_id = ${emp.id}`;
		await db.exec`
			INSERT INTO employee_sessions (token, employee_id, employee_name, customer_id, customer_name, mobile_number, expires_at)
			VALUES (${token}, ${emp.id}, ${emp.name}, ${emp.customer_id}, ${emp.customer_name}, ${emp.mobile_number}, ${expiresAt.toISOString()})
		`;

		return {
			token,
			employee: { id: emp.id, name: emp.name, customer_name: emp.customer_name },
			expires_at: expiresAt.toISOString(),
		};
	},
);

// ─── Portal context (me + allowed periods + existing submissions) ─────────────

interface PortalPeriod {
	month: number;
	year: number;
	label: string;
	status: TimesheetStatus | null; // existing submission status, if any
	reference: string | null;
}

interface PortalContextResponse {
	employee: { id: string; name: string; customer_name: string | null };
	periods: PortalPeriod[];
}

export const portalContext = api(
	{ expose: true, auth: false, method: "GET", path: "/portal/me" },
	async ({ token }: { token?: Header<"X-Portal-Token"> }): Promise<PortalContextResponse> => {
		const s = await authEmployee(token);
		const periods: PortalPeriod[] = [];
		for (const p of allowedPeriods()) {
			const existing = await db.rawQueryRow<{ status: TimesheetStatus; reference: string }>(
				`SELECT status, reference FROM timesheets
				 WHERE employee_id = $1 AND period_month = $2 AND period_year = $3`,
				s.employee_id, p.month, p.year,
			);
			periods.push({
				month: p.month,
				year: p.year,
				label: `${MONTH_NAMES[p.month - 1]} ${p.year}`,
				status: existing?.status ?? null,
				reference: existing?.reference ?? null,
			});
		}
		return {
			employee: { id: s.employee_id, name: s.employee_name, customer_name: s.customer_name },
			periods,
		};
	},
);

// ─── Submit timesheet (with attachment + OCR) ─────────────────────────────────

interface SubmitPortalInput {
	token?: Header<"X-Portal-Token">;
	period_month: number;
	period_year: number;
	total_working_days: number;
	days_present: number;
	leave_days?: number;
	sick_leave_days?: number;
	public_holidays?: number;
	absent_days?: number;
	overtime_hours?: number;
	notes?: string;
	attachment_base64: string; // may include a data: URL prefix
	attachment_name: string;
}

interface SubmitPortalResponse {
	ok: boolean;
	reference: string;
	ocr_status: string;
	ocr_flags: string[];
}

export const submitPortalTimesheet = api(
	{ expose: true, auth: false, method: "POST", path: "/portal/timesheet" },
	async (input: SubmitPortalInput): Promise<SubmitPortalResponse> => {
		const s = await authEmployee(input.token);

		// Period must be the current or previous month.
		const allowed = allowedPeriods().some(
			(p) => p.month === input.period_month && p.year === input.period_year,
		);
		if (!allowed) {
			throw APIError.invalidArgument(
				"you can only submit a timesheet for the current or previous month",
			);
		}

		// Can't overwrite an already-approved submission.
		const existing = await db.rawQueryRow<{ id: string; status: TimesheetStatus }>(
			`SELECT id, status FROM timesheets
			 WHERE employee_id = $1 AND period_month = $2 AND period_year = $3`,
			s.employee_id, input.period_month, input.period_year,
		);
		if (existing?.status === "approved") {
			throw APIError.failedPrecondition(
				"your timesheet for this period has already been approved",
			);
		}

		// Decode + validate the attachment.
		if (!input.attachment_base64?.trim()) {
			throw APIError.invalidArgument("a manager-signed timesheet attachment is required");
		}
		const b64 = input.attachment_base64.includes(",")
			? input.attachment_base64.slice(input.attachment_base64.indexOf(",") + 1)
			: input.attachment_base64;
		let buf: Buffer;
		try {
			buf = Buffer.from(b64, "base64");
		} catch {
			throw APIError.invalidArgument("the attachment could not be read");
		}
		if (buf.length === 0) throw APIError.invalidArgument("the attachment is empty");
		if (buf.length > MAX_ATTACHMENT_BYTES) {
			throw APIError.invalidArgument("the attachment exceeds the 10 MB limit");
		}
		const type = sniffType(buf);
		if (!type) {
			throw APIError.invalidArgument(
				"unsupported file type — please upload a PDF, JPG or PNG",
			);
		}

		// Best-effort OCR verification (never blocks).
		const ocr = await ocrAndCompare(buf, type, {
			employeeName: s.employee_name,
			totalWorkingDays: input.total_working_days,
			daysPresent: input.days_present,
			overtimeHours: input.overtime_hours ?? 0,
			monthName: MONTH_NAMES[input.period_month - 1],
			year: input.period_year,
		});

		const actor = `employee:${s.employee_id}`;
		const flagsJson = JSON.stringify(ocr.flags);

		let tsId: string;
		let reference: string;
		if (existing) {
			tsId = existing.id;
			const ref = await db.rawQueryRow<{ reference: string }>(
				`SELECT reference FROM timesheets WHERE id = $1`, tsId,
			);
			reference = ref!.reference;
			await db.exec`
				UPDATE timesheets SET
					total_working_days = ${input.total_working_days},
					days_present       = ${input.days_present},
					leave_days         = ${input.leave_days ?? 0},
					sick_leave_days    = ${input.sick_leave_days ?? 0},
					public_holidays    = ${input.public_holidays ?? 0},
					absent_days        = ${input.absent_days ?? 0},
					overtime_hours     = ${input.overtime_hours ?? 0},
					notes              = ${input.notes ?? null},
					attachment_name    = ${input.attachment_name},
					attachment_type    = ${type},
					attachment_data    = ${buf.toString("base64")},
					ocr_status         = ${ocr.status},
					ocr_text           = ${ocr.text},
					ocr_flags          = ${flagsJson},
					status             = 'submitted',
					submitted_by       = ${actor},
					submitted_at       = NOW(),
					updated_at         = NOW()
				WHERE id = ${tsId}
			`;
		} else {
			tsId = crypto.randomUUID();
			reference = await nextRef(input.period_year);
			await db.exec`
				INSERT INTO timesheets (
					id, reference, employee_id, employee_name, customer_id, customer_name,
					period_month, period_year, total_working_days, days_present,
					leave_days, sick_leave_days, public_holidays, absent_days, overtime_hours,
					notes, status, created_by, created_by_name, submitted_by, submitted_at,
					source, attachment_name, attachment_type, attachment_data,
					ocr_status, ocr_text, ocr_flags
				) VALUES (
					${tsId}, ${reference}, ${s.employee_id}, ${s.employee_name}, ${s.customer_id}, ${s.customer_name},
					${input.period_month}, ${input.period_year}, ${input.total_working_days}, ${input.days_present},
					${input.leave_days ?? 0}, ${input.sick_leave_days ?? 0}, ${input.public_holidays ?? 0}, ${input.absent_days ?? 0}, ${input.overtime_hours ?? 0},
					${input.notes ?? null}, 'submitted', ${actor}, ${s.employee_name}, ${actor}, NOW(),
					'employee_portal', ${input.attachment_name}, ${type}, ${buf.toString("base64")},
					${ocr.status}, ${ocr.text}, ${flagsJson}
				)
			`;
		}
		await logEvent(tsId, "submitted_via_portal", actor, `OCR: ${ocr.status}, ${ocr.flags.length} flag(s)`);

		// Notify ERP verifiers (managers + admin).
		const periodLabel = `${MONTH_NAMES[input.period_month - 1]} ${input.period_year}`;
		const html = emailShell(
			"Employee timesheet submitted for verification",
			erow("Employee", s.employee_name) +
				erow("Client", s.customer_name ?? "—") +
				erow("Period", periodLabel) +
				erow("Reference", reference) +
				erow("Days present", String(input.days_present)) +
				erow("OCR check", ocr.flags.length ? `${ocr.flags.length} discrepancy flag(s)` : "no discrepancies") +
				erow("Attachment", input.attachment_name),
		);
		notifyRoles(["manager", "admin", "super_admin"], `[Timesheet] ${s.employee_name} — ${periodLabel}`, html);

		return { ok: true, reference, ocr_status: ocr.status, ocr_flags: ocr.flags };
	},
);
