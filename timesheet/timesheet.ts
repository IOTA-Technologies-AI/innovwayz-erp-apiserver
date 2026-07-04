import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";

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
	created_at, updated_at
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
