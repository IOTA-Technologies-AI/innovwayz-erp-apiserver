import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("leave", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type LeaveType =
	| "annual"
	| "sick"
	| "emergency"
	| "maternity"
	| "paternity"
	| "unpaid"
	| "compensatory"
	| "other";

export type LeaveStatus =
	| "draft"
	| "submitted"
	| "approved"
	| "rejected"
	| "cancelled";

export interface LeaveBalance {
	id: string;
	employee_id: string | null;
	employee_name: string;
	customer_id: string | null;
	customer_name: string | null;
	year: number;
	leave_type: LeaveType;
	entitled_days: number;
	used_days: number;
	carry_forward_days: number;
	remaining_days: number; // computed: entitled + carry_forward - used
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export interface LeaveRequest {
	id: string;
	reference: string;
	employee_id: string | null;
	employee_name: string;
	customer_id: string | null;
	customer_name: string | null;
	leave_type: LeaveType;
	start_date: string;
	end_date: string;
	total_days: number;
	reason: string | null;
	notes: string | null;
	file_url: string | null;
	status: LeaveStatus;
	created_by: string;
	created_by_name: string | null;
	submitted_by: string | null;
	submitted_at: string | null;
	approved_by: string | null;
	approved_at: string | null;
	rejected_by: string | null;
	rejected_at: string | null;
	rejection_reason: string | null;
	cancelled_by: string | null;
	cancelled_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface LeaveRequestEvent {
	id: string;
	request_id: string;
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

const BALANCE_COLS = `
	id, employee_id, employee_name, customer_id, customer_name,
	year, leave_type,
	entitled_days::float8   AS entitled_days,
	used_days::float8       AS used_days,
	carry_forward_days::float8 AS carry_forward_days,
	(entitled_days + carry_forward_days - used_days)::float8 AS remaining_days,
	notes, created_at, updated_at
`;

const REQUEST_COLS = `
	id, reference,
	employee_id, employee_name, customer_id, customer_name,
	leave_type,
	start_date::TEXT AS start_date,
	end_date::TEXT   AS end_date,
	total_days::float8 AS total_days,
	reason, notes, file_url, status,
	created_by, created_by_name,
	submitted_by, submitted_at,
	approved_by, approved_at,
	rejected_by, rejected_at, rejection_reason,
	cancelled_by, cancelled_at,
	created_at, updated_at
`;

async function fetchRequest(id: string): Promise<LeaveRequest> {
	const row = await db.rawQueryRow<LeaveRequest>(
		`SELECT ${REQUEST_COLS} FROM leave_requests WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("leave request not found");
	return row;
}

async function nextRef(year: number): Promise<string> {
	const r = await db.rawQueryRow<{ ref: string }>(
		`SELECT 'LV-' || $1::TEXT || '-' || LPAD(NEXTVAL('leave_ref_seq')::TEXT, 6, '0') AS ref`,
		year,
	);
	return r!.ref;
}

async function logEvent(
	requestId: string,
	action: string,
	actorId: string,
	note?: string,
): Promise<void> {
	await db.exec`
		INSERT INTO leave_request_events (id, request_id, action, performed_by, note)
		VALUES (${crypto.randomUUID()}, ${requestId}, ${action}, ${actorId}, ${note ?? null})
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
		log.error("notify roles failed", { roles, error: String(err) });
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
		log.error("notify user failed", { userId, error: String(err) });
	}
}

const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
	annual: "Annual Leave",
	sick: "Sick Leave",
	emergency: "Emergency Leave",
	maternity: "Maternity Leave",
	paternity: "Paternity Leave",
	unpaid: "Unpaid Leave",
	compensatory: "Compensatory Leave",
	other: "Other",
};

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

// ─── Leave Balance endpoints ──────────────────────────────────────────────────

interface UpsertBalanceInput {
	employee_id?: string;
	employee_name: string;
	customer_id?: string;
	customer_name?: string;
	year: number;
	leave_type: LeaveType;
	entitled_days: number;
	carry_forward_days?: number;
	notes?: string;
}

export const upsertLeaveBalance = api(
	{ expose: true, method: "POST", path: "/leave-balances", auth: true },
	async (input: UpsertBalanceInput): Promise<{ balance: LeaveBalance }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const existing = await db.rawQueryRow<{ id: string; used_days: string }>(
			`SELECT id, used_days::float8 AS used_days FROM leave_balances
			 WHERE employee_id = $1 AND leave_type = $2 AND year = $3`,
			input.employee_id ?? null,
			input.leave_type,
			input.year,
		);

		if (existing) {
			await db.exec`
				UPDATE leave_balances SET
					employee_name       = ${input.employee_name},
					customer_id         = ${input.customer_id ?? null},
					customer_name       = ${input.customer_name ?? null},
					entitled_days       = ${input.entitled_days},
					carry_forward_days  = ${input.carry_forward_days ?? 0},
					notes               = ${input.notes ?? null},
					updated_by          = ${userID},
					updated_at          = NOW()
				WHERE id = ${existing.id}
			`;
			const updated = await db.rawQueryRow<LeaveBalance>(
				`SELECT ${BALANCE_COLS} FROM leave_balances WHERE id = $1`,
				existing.id,
			);
			return { balance: updated! };
		}

		const id = crypto.randomUUID();
		await db.exec`
			INSERT INTO leave_balances (
				id, employee_id, employee_name, customer_id, customer_name,
				year, leave_type, entitled_days, carry_forward_days, notes,
				created_by, updated_by
			) VALUES (
				${id},
				${input.employee_id ?? null}, ${input.employee_name},
				${input.customer_id ?? null}, ${input.customer_name ?? null},
				${input.year}, ${input.leave_type}, ${input.entitled_days},
				${input.carry_forward_days ?? 0},
				${input.notes ?? null},
				${userID}, ${userID}
			)
		`;
		const created = await db.rawQueryRow<LeaveBalance>(
			`SELECT ${BALANCE_COLS} FROM leave_balances WHERE id = $1`,
			id,
		);
		return { balance: created! };
	},
);

interface ListBalancesInput {
	employee_id?: string;
	employee_name?: string;
	year?: number;
	leave_type?: LeaveType;
}

export const listLeaveBalances = api(
	{ expose: true, method: "GET", path: "/leave-balances", auth: true },
	async (input: ListBalancesInput): Promise<{ balances: LeaveBalance[] }> => {
		getAuthData()!;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		if (input.employee_id) add("employee_id = $?", input.employee_id);
		if (input.employee_name)
			add("UPPER(employee_name) LIKE UPPER($?)", `%${input.employee_name}%`);
		if (input.year) add("year = $?", input.year);
		if (input.leave_type) add("leave_type = $?", input.leave_type);

		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = db.rawQuery<LeaveBalance>(
			`SELECT ${BALANCE_COLS} FROM leave_balances ${where}
			 ORDER BY year DESC, employee_name ASC, leave_type ASC`,
			...args,
		);
		const balances: LeaveBalance[] = [];
		for await (const r of rows) balances.push(r);
		return { balances };
	},
);

// ─── Leave Request: Create ────────────────────────────────────────────────────

interface CreateLeaveRequestInput {
	employee_id?: string;
	employee_name: string;
	customer_id?: string;
	customer_name?: string;
	leave_type: LeaveType;
	start_date: string; // YYYY-MM-DD
	end_date: string;
	total_days: number;
	reason?: string;
	notes?: string;
	file_url?: string;
}

export const createLeaveRequest = api(
	{ expose: true, method: "POST", path: "/leave-requests", auth: true },
	async (
		input: CreateLeaveRequestInput,
	): Promise<{ request: LeaveRequest }> => {
		const { userID, role } = getAuthData()!;

		let creatorName: string | null = null;
		try {
			creatorName = (await user.getContact({ id: userID })).name;
		} catch {
			/* non-fatal */
		}

		const year = new Date(input.start_date).getFullYear();
		const id = crypto.randomUUID();
		const ref = await nextRef(year);

		await db.exec`
			INSERT INTO leave_requests (
				id, reference,
				employee_id, employee_name, customer_id, customer_name,
				leave_type, start_date, end_date, total_days,
				reason, notes, file_url,
				status, created_by, created_by_name
			) VALUES (
				${id}, ${ref},
				${input.employee_id ?? null}, ${input.employee_name},
				${input.customer_id ?? null}, ${input.customer_name ?? null},
				${input.leave_type}, ${input.start_date}, ${input.end_date}, ${input.total_days},
				${input.reason ?? null}, ${input.notes ?? null}, ${input.file_url ?? null},
				'draft', ${userID}, ${creatorName}
			)
		`;
		await logEvent(id, "created", userID);
		return { request: await fetchRequest(id) };
	},
);

// ─── List ─────────────────────────────────────────────────────────────────────

interface ListLeaveRequestsInput {
	status?: LeaveStatus;
	leave_type?: LeaveType;
	employee_id?: string;
	employee_name?: string;
	year?: number;
	month?: number;
	mine?: boolean;
	limit?: number;
	offset?: number;
}

export const listLeaveRequests = api(
	{ expose: true, method: "GET", path: "/leave-requests", auth: true },
	async (
		input: ListLeaveRequestsInput,
	): Promise<{ requests: LeaveRequest[]; total: number }> => {
		const { userID, role } = getAuthData()!;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		if (!isManager(role) || input.mine) add("created_by = $?", userID);
		if (input.status) add("status = $?", input.status);
		if (input.leave_type) add("leave_type = $?", input.leave_type);
		if (input.employee_id) add("employee_id = $?", input.employee_id);
		if (input.employee_name)
			add("UPPER(employee_name) LIKE UPPER($?)", `%${input.employee_name}%`);
		if (input.year) add("EXTRACT(YEAR FROM start_date) = $?", input.year);
		if (input.month) add("EXTRACT(MONTH FROM start_date) = $?", input.month);

		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const countRow = await db.rawQueryRow<{ n: string }>(
			`SELECT COUNT(*)::TEXT AS n FROM leave_requests ${where}`,
			...args,
		);
		const total = parseInt(countRow?.n ?? "0", 10);

		const limit = Math.min(input.limit ?? 200, 500);
		const offset = input.offset ?? 0;
		const li = args.length + 1;
		const oi = args.length + 2;
		const pagedArgs = [...args, limit, offset];

		const rows = db.rawQuery<LeaveRequest>(
			`SELECT ${REQUEST_COLS} FROM leave_requests ${where}
			 ORDER BY created_at DESC
			 LIMIT $${li} OFFSET $${oi}`,
			...pagedArgs,
		);
		const requests: LeaveRequest[] = [];
		for await (const r of rows) requests.push(r);
		return { requests, total };
	},
);

// ─── Get ──────────────────────────────────────────────────────────────────────

export const getLeaveRequest = api(
	{ expose: true, method: "GET", path: "/leave-requests/:id", auth: true },
	async ({ id }: { id: string }): Promise<{ request: LeaveRequest }> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(id);
		if (!isManager(role) && req.created_by !== userID)
			throw APIError.permissionDenied("access denied");
		return { request: req };
	},
);

// ─── Update ───────────────────────────────────────────────────────────────────

interface UpdateLeaveRequestInput extends Partial<CreateLeaveRequestInput> {
	id: string;
}

export const updateLeaveRequest = api(
	{ expose: true, method: "PUT", path: "/leave-requests/:id", auth: true },
	async (
		input: UpdateLeaveRequestInput,
	): Promise<{ request: LeaveRequest }> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(input.id);
		if (!isManager(role) && req.created_by !== userID)
			throw APIError.permissionDenied("access denied");
		if (!["draft", "submitted"].includes(req.status))
			throw APIError.failedPrecondition(`cannot edit a ${req.status} request`);

		await db.exec`
			UPDATE leave_requests SET
				employee_name   = COALESCE(${input.employee_name ?? null}, employee_name),
				customer_name   = COALESCE(${input.customer_name ?? null}, customer_name),
				leave_type      = COALESCE(${input.leave_type ?? null}, leave_type),
				start_date      = COALESCE(${input.start_date ?? null}, start_date),
				end_date        = COALESCE(${input.end_date ?? null}, end_date),
				total_days      = COALESCE(${input.total_days ?? null}, total_days),
				reason          = CASE WHEN ${input.reason !== undefined} THEN ${input.reason ?? null} ELSE reason END,
				notes           = CASE WHEN ${input.notes !== undefined} THEN ${input.notes ?? null} ELSE notes END,
				file_url        = CASE WHEN ${input.file_url !== undefined} THEN ${input.file_url ?? null} ELSE file_url END,
				updated_at      = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "updated", userID);
		return { request: await fetchRequest(input.id) };
	},
);

// ─── Submit ───────────────────────────────────────────────────────────────────

export const submitLeaveRequest = api(
	{
		expose: true,
		method: "POST",
		path: "/leave-requests/:id/submit",
		auth: true,
	},
	async ({ id }: { id: string }): Promise<{ request: LeaveRequest }> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(id);
		if (!isManager(role) && req.created_by !== userID)
			throw APIError.permissionDenied("access denied");
		if (req.status !== "draft")
			throw APIError.failedPrecondition(
				`cannot submit a ${req.status} request`,
			);

		await db.exec`
			UPDATE leave_requests
			SET status = 'submitted', submitted_by = ${userID}, submitted_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "submitted", userID);

		const typeLabel = LEAVE_TYPE_LABELS[req.leave_type];
		const html = emailShell(
			`Leave Request Submitted`,
			erow("Reference", req.reference) +
				erow("Employee", req.employee_name) +
				erow("Type", typeLabel) +
				erow("From", req.start_date) +
				erow("To", req.end_date) +
				erow("Days", String(req.total_days)),
		);
		notifyRoles(
			["manager", "admin"],
			`[Leave] Submitted — ${req.employee_name} (${typeLabel})`,
			html,
		);

		return { request: await fetchRequest(id) };
	},
);

// ─── Approve ──────────────────────────────────────────────────────────────────

export const approveLeaveRequest = api(
	{
		expose: true,
		method: "POST",
		path: "/leave-requests/:id/approve",
		auth: true,
	},
	async ({ id }: { id: string }): Promise<{ request: LeaveRequest }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const req = await fetchRequest(id);
		if (!["draft", "submitted"].includes(req.status))
			throw APIError.failedPrecondition(
				`cannot approve a ${req.status} request`,
			);

		await db.exec`
			UPDATE leave_requests
			SET status = 'approved', approved_by = ${userID}, approved_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "approved", userID);

		// Update leave balance: increment used_days
		const year = new Date(req.start_date).getFullYear();
		await db.exec`
			UPDATE leave_balances
			SET used_days = used_days + ${req.total_days}, updated_at = NOW()
			WHERE employee_id = ${req.employee_id ?? null}
			  AND leave_type = ${req.leave_type}
			  AND year = ${year}
		`;

		const typeLabel = LEAVE_TYPE_LABELS[req.leave_type];
		const html = emailShell(
			`Your leave request has been approved`,
			erow("Reference", req.reference) +
				erow("Type", typeLabel) +
				erow("From", req.start_date) +
				erow("To", req.end_date) +
				erow("Days", String(req.total_days)) +
				erow("Status", "Approved"),
		);
		notifyUser(req.created_by, `[Leave] Approved — ${typeLabel}`, html);

		return { request: await fetchRequest(id) };
	},
);

// ─── Reject ───────────────────────────────────────────────────────────────────

interface RejectLeaveInput {
	id: string;
	reason?: string;
}

export const rejectLeaveRequest = api(
	{
		expose: true,
		method: "POST",
		path: "/leave-requests/:id/reject",
		auth: true,
	},
	async (input: RejectLeaveInput): Promise<{ request: LeaveRequest }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const req = await fetchRequest(input.id);
		if (!["draft", "submitted"].includes(req.status))
			throw APIError.failedPrecondition(
				`cannot reject a ${req.status} request`,
			);

		await db.exec`
			UPDATE leave_requests
			SET status = 'rejected',
			    rejected_by = ${userID},
			    rejected_at = NOW(),
			    rejection_reason = ${input.reason ?? null},
			    updated_at = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "rejected", userID, input.reason);

		const typeLabel = LEAVE_TYPE_LABELS[req.leave_type];
		const html = emailShell(
			`Leave request rejected`,
			erow("Reference", req.reference) +
				erow("Type", typeLabel) +
				erow("From", req.start_date) +
				erow("To", req.end_date) +
				(input.reason ? erow("Reason", input.reason) : ""),
		);
		notifyUser(req.created_by, `[Leave] Rejected — ${typeLabel}`, html);

		return { request: await fetchRequest(input.id) };
	},
);

// ─── Cancel ───────────────────────────────────────────────────────────────────

export const cancelLeaveRequest = api(
	{
		expose: true,
		method: "POST",
		path: "/leave-requests/:id/cancel",
		auth: true,
	},
	async ({ id }: { id: string }): Promise<{ request: LeaveRequest }> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(id);
		if (!isManager(role) && req.created_by !== userID)
			throw APIError.permissionDenied("access denied");
		if (req.status === "cancelled")
			throw APIError.failedPrecondition("already cancelled");

		const wasApproved = req.status === "approved";

		await db.exec`
			UPDATE leave_requests
			SET status = 'cancelled', cancelled_by = ${userID}, cancelled_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "cancelled", userID);

		// Revert used_days if it was already approved
		if (wasApproved) {
			const year = new Date(req.start_date).getFullYear();
			await db.exec`
				UPDATE leave_balances
				SET used_days = GREATEST(0, used_days - ${req.total_days}), updated_at = NOW()
				WHERE employee_id = ${req.employee_id ?? null}
				  AND leave_type = ${req.leave_type}
				  AND year = ${year}
			`;
		}

		return { request: await fetchRequest(id) };
	},
);

// ─── Delete ───────────────────────────────────────────────────────────────────

export const deleteLeaveRequest = api(
	{ expose: true, method: "DELETE", path: "/leave-requests/:id", auth: true },
	async ({ id }: { id: string }): Promise<{ success: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");
		await db.exec`DELETE FROM leave_requests WHERE id = ${id}`;
		return { success: true };
	},
);

// ─── Events ───────────────────────────────────────────────────────────────────

export const listLeaveEvents = api(
	{
		expose: true,
		method: "GET",
		path: "/leave-requests/:id/events",
		auth: true,
	},
	async ({ id }: { id: string }): Promise<{ events: LeaveRequestEvent[] }> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(id);
		if (!isManager(role) && req.created_by !== userID)
			throw APIError.permissionDenied("access denied");

		const rows = db.rawQuery<LeaveRequestEvent>(
			`SELECT id, request_id, action, performed_by, note, created_at
			 FROM leave_request_events WHERE request_id = $1 ORDER BY created_at ASC`,
			id,
		);
		const events: LeaveRequestEvent[] = [];
		for await (const r of rows) events.push(r);
		return { events };
	},
);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface LeaveStatsResponse {
	total: number;
	draft: number;
	submitted: number;
	approved: number;
	rejected: number;
	cancelled: number;
	total_days_taken: number;
}

export const leaveStats = api(
	{ expose: true, method: "GET", path: "/leave-stats", auth: true },
	async (): Promise<LeaveStatsResponse> => {
		const { userID, role } = getAuthData()!;
		const scope = isManager(role) ? "" : `WHERE created_by = '${userID}'`;

		const r = await db.rawQueryRow<{
			total: string;
			draft: string;
			submitted: string;
			approved: string;
			rejected: string;
			cancelled: string;
			total_days_taken: string;
		}>(
			`SELECT
				COUNT(*)::TEXT                                            AS total,
				COUNT(*) FILTER (WHERE status='draft')::TEXT             AS draft,
				COUNT(*) FILTER (WHERE status='submitted')::TEXT         AS submitted,
				COUNT(*) FILTER (WHERE status='approved')::TEXT          AS approved,
				COUNT(*) FILTER (WHERE status='rejected')::TEXT          AS rejected,
				COUNT(*) FILTER (WHERE status='cancelled')::TEXT         AS cancelled,
				COALESCE(SUM(total_days) FILTER (WHERE status='approved'),0)::TEXT AS total_days_taken
			FROM leave_requests ${scope}`,
		);

		return {
			total: parseInt(r!.total, 10),
			draft: parseInt(r!.draft, 10),
			submitted: parseInt(r!.submitted, 10),
			approved: parseInt(r!.approved, 10),
			rejected: parseInt(r!.rejected, 10),
			cancelled: parseInt(r!.cancelled, 10),
			total_days_taken: parseFloat(r!.total_days_taken),
		};
	},
);
