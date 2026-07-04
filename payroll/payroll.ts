import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user, billing } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("payroll", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

type SalaryStatus =
	| "pending_manager"
	| "pending_admin"
	| "approved"
	| "processing"
	| "paid"
	| "rejected"
	| "cancelled";

export interface SalaryPayment {
	id: string;
	reference: string;
	employee_id: string;
	employee_name: string;
	position: string | null;
	customer_id: string | null;
	customer_name: string | null;
	period_month: number;
	period_year: number;
	base_amount: number;
	additions: number;
	deductions: number;
	net_amount: number;
	currency: string;
	notes: string | null;
	payment_method: string | null;
	status: SalaryStatus;
	created_by: string;
	created_by_name: string | null;
	manager_approved_by: string | null;
	manager_approved_at: string | null;
	admin_approved_by: string | null;
	admin_approved_at: string | null;
	rejected_by: string | null;
	rejected_at: string | null;
	rejection_reason: string | null;
	processed_by: string | null;
	processed_at: string | null;
	payment_reference: string | null;
	paid_amount: number | null;
	paid_at: string | null;
	created_at: string;
	updated_at: string;
}

// ─── Role helpers ─────────────────────────────────────────────────────────────

function isManager(role: string): boolean {
	return ["manager", "admin", "super_admin"].includes(role);
}
function isAdmin(role: string): boolean {
	return ["admin", "super_admin"].includes(role);
}
function isFinance(role: string): boolean {
	return ["finance", "super_admin"].includes(role);
}

const SALARY_COLUMNS = `
  id, reference, employee_id, employee_name, position, customer_id, customer_name,
  period_month, period_year, base_amount, additions, deductions, net_amount,
  currency, notes, payment_method, status,
  created_by, created_by_name,
  manager_approved_by, manager_approved_at, admin_approved_by, admin_approved_at,
  rejected_by, rejected_at, rejection_reason,
  processed_by, processed_at, payment_reference, paid_amount, paid_at,
  created_at, updated_at
`;

const MONTHS = [
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

function monthLabel(m: number, y: number): string {
	return `${MONTHS[m - 1] ?? m} ${y}`;
}

async function fetchSalary(id: string): Promise<SalaryPayment> {
	const row = await db.rawQueryRow<SalaryPayment>(
		`SELECT ${SALARY_COLUMNS} FROM salary_payments WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("salary payment not found");
	return row;
}

async function logEvent(
	salaryId: string,
	action: string,
	actorId: string,
	actorName: string | null,
	note?: string,
): Promise<void> {
	await db.exec`
    INSERT INTO salary_payment_events (id, salary_id, action, actor_id, actor_name, note)
    VALUES (${crypto.randomUUID()}, ${salaryId}, ${action}, ${actorId}, ${actorName ?? null}, ${note ?? null})
  `;
}

async function actorNameOf(userID: string): Promise<string | null> {
	try {
		return (await user.getContact({ id: userID })).name;
	} catch {
		return null;
	}
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

const SAR = (n: number) =>
	new Intl.NumberFormat("en-SA", {
		style: "currency",
		currency: "SAR",
		maximumFractionDigits: 2,
	}).format(n);

function emailShell(
	heading: string,
	bodyRows: string,
	ctaLabel?: string,
): string {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#0f172a;border-radius:12px 12px 0 0;padding:24px 40px;text-align:center;">
        <span style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">InnovWayz ERP</span>
      </td></tr>
      <tr><td style="background:#fff;padding:32px 40px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
        <h2 style="margin:0 0 20px;color:#0f172a;font-size:20px;font-weight:700;">${heading}</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#475569;">${bodyRows}</table>
        ${ctaLabel ? `<p style="margin:24px 0 0;color:#94a3b8;font-size:13px;">${ctaLabel}</p>` : ""}
      </td></tr>
      <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:18px 40px;text-align:center;">
        <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} InnovWayz Technologies. All Rights Reserved.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function salaryRows(s: SalaryPayment): string {
	const row = (label: string, value: string) =>
		`<tr><td style="padding:6px 0;color:#94a3b8;width:170px;">${label}</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${value}</td></tr>`;
	return [
		row("Reference", s.reference),
		row("Employee", s.employee_name),
		s.customer_name ? row("Client", s.customer_name) : "",
		row("Period", monthLabel(s.period_month, s.period_year)),
		row("Base salary", SAR(Number(s.base_amount))),
		Number(s.additions) ? row("Additions", SAR(Number(s.additions))) : "",
		Number(s.deductions) ? row("Deductions", SAR(Number(s.deductions))) : "",
		row("Net payable", SAR(Number(s.net_amount))),
		row("Raised by", s.created_by_name ?? "—"),
	].join("");
}

// ─── Reference generation ─────────────────────────────────────────────────────

async function nextReference(): Promise<string> {
	const row = await db.queryRow<{ n: number }>`
    SELECT nextval('salary_reference_seq') AS n
  `;
	const year = new Date().getFullYear();
	return `SAL-${year}-${String(row!.n).padStart(6, "0")}`;
}

function computeNet(base: number, additions: number, deductions: number) {
	return Math.round((base + additions - deductions) * 100) / 100;
}

// ─── Create a single salary payment ───────────────────────────────────────────

interface CreateSalaryRequest {
	employee_id: string;
	employee_name: string;
	position?: string;
	customer_id?: string;
	customer_name?: string;
	period_month: number;
	period_year: number;
	base_amount: number;
	additions?: number;
	deductions?: number;
	currency?: string;
	notes?: string;
	payment_method?: string;
}

export const createSalaryPayment = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll" },
	async (req: CreateSalaryRequest): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role) && !isFinance(role))
			throw APIError.permissionDenied(
				"only managers, admins or finance can raise salary payments",
			);
		if (!req.employee_id || !req.employee_name)
			throw APIError.invalidArgument("employee is required");
		if (
			!req.period_month ||
			req.period_month < 1 ||
			req.period_month > 12 ||
			!req.period_year
		)
			throw APIError.invalidArgument("a valid period month/year is required");
		if (req.base_amount === undefined || req.base_amount < 0)
			throw APIError.invalidArgument("base_amount must be a positive number");

		const additions = req.additions ?? 0;
		const deductions = req.deductions ?? 0;
		const net = computeNet(req.base_amount, additions, deductions);

		const creatorName = await actorNameOf(userID);
		const id = crypto.randomUUID();
		const reference = await nextReference();

		try {
			await db.exec`
        INSERT INTO salary_payments (
          id, reference, employee_id, employee_name, position, customer_id, customer_name,
          period_month, period_year, base_amount, additions, deductions, net_amount,
          currency, notes, payment_method, status, created_by, created_by_name
        ) VALUES (
          ${id}, ${reference}, ${req.employee_id}, ${req.employee_name}, ${req.position ?? null},
          ${req.customer_id ?? null}, ${req.customer_name ?? null},
          ${req.period_month}, ${req.period_year}, ${req.base_amount}, ${additions}, ${deductions}, ${net},
          ${req.currency ?? "SAR"}, ${req.notes ?? null}, ${req.payment_method ?? null},
          'pending_manager', ${userID}, ${creatorName}
        )
      `;
		} catch (err) {
			if (/unique|duplicate/i.test(String(err)))
				throw APIError.alreadyExists(
					"a salary payment for this employee and period already exists",
				);
			throw err;
		}

		await logEvent(id, "created", userID, creatorName);
		const created = await fetchSalary(id);

		void notifyRoles(
			["manager", "admin", "super_admin"],
			`New salary pending approval — ${created.reference}`,
			emailShell(
				"New Salary Awaiting Approval",
				salaryRows(created),
				"Please review this salary payment in the InnovWayz ERP portal.",
			),
		);

		return created;
	},
);

// ─── Bulk-generate a monthly payroll run ──────────────────────────────────────

interface GenerateMonthlyRequest {
	period_month: number;
	period_year: number;
}

interface GenerateMonthlyResponse {
	created: number;
	skipped: number;
	total_net: number;
}

export const generateMonthlyPayroll = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/generate" },
	async (req: GenerateMonthlyRequest): Promise<GenerateMonthlyResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role) && !isFinance(role))
			throw APIError.permissionDenied(
				"only managers, admins or finance can generate payroll",
			);
		if (
			!req.period_month ||
			req.period_month < 1 ||
			req.period_month > 12 ||
			!req.period_year
		)
			throw APIError.invalidArgument("a valid period month/year is required");

		const creatorName = await actorNameOf(userID);
		const { employees } = await billing.listEmployees();

		let created = 0;
		let skipped = 0;
		let totalNet = 0;

		for (const e of employees) {
			const base = Number(e.monthly_salary) || 0;
			if (base <= 0) {
				skipped++;
				continue;
			}
			const id = crypto.randomUUID();
			const reference = await nextReference();
			const net = computeNet(base, 0, 0);
			const res = await db.rawQueryRow<{ id: string }>(
				`INSERT INTO salary_payments (
          id, reference, employee_id, employee_name, position, customer_id, customer_name,
          period_month, period_year, base_amount, additions, deductions, net_amount,
          currency, status, created_by, created_by_name
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, $11, 'SAR', 'pending_manager', $12, $13
        )
        ON CONFLICT (employee_id, period_month, period_year) DO NOTHING
        RETURNING id`,
				id,
				reference,
				e.id,
				e.name,
				e.position ?? null,
				e.customer_id ?? null,
				e.customer_name ?? null,
				req.period_month,
				req.period_year,
				base,
				net,
				userID,
				creatorName,
			);
			if (res) {
				created++;
				totalNet += net;
				await logEvent(id, "created", userID, creatorName);
			} else {
				skipped++;
			}
		}

		if (created > 0) {
			void notifyRoles(
				["manager", "admin", "super_admin"],
				`Payroll generated for ${monthLabel(req.period_month, req.period_year)} — ${created} salaries`,
				emailShell(
					"Monthly Payroll Generated",
					`<tr><td style="padding:6px 0;color:#94a3b8;width:170px;">Period</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${monthLabel(req.period_month, req.period_year)}</td></tr>
           <tr><td style="padding:6px 0;color:#94a3b8;">Salaries created</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${created}</td></tr>
           <tr><td style="padding:6px 0;color:#94a3b8;">Total net</td><td style="padding:6px 0;color:#0f172a;font-weight:700;">${SAR(totalNet)}</td></tr>`,
					"These salary payments are awaiting manager approval.",
				),
			);
		}

		return {
			created,
			skipped,
			total_net: Math.round(totalNet * 100) / 100,
		};
	},
);

// ─── List / Get ───────────────────────────────────────────────────────────────

interface ListSalaryParams {
	status?: string;
	period_month?: number;
	period_year?: number;
	employee_id?: string;
	mine?: boolean;
}

export const listSalaryPayments = api(
	{ expose: true, auth: true, method: "GET", path: "/payroll" },
	async (p: ListSalaryParams): Promise<{ salaries: SalaryPayment[] }> => {
		const { userID, role } = getAuthData()!;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		// Only managers/finance see everyone; others see nothing unless it's theirs.
		if (!isManager(role) && !isFinance(role)) {
			add("created_by = $?", userID);
		} else if (p.mine) {
			add("created_by = $?", userID);
		}
		if (p.status) add("status = $?", p.status);
		if (p.period_month) add("period_month = $?", p.period_month);
		if (p.period_year) add("period_year = $?", p.period_year);
		if (p.employee_id) add("employee_id = $?", p.employee_id);

		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = db.rawQuery<SalaryPayment>(
			`SELECT ${SALARY_COLUMNS} FROM salary_payments ${where}
       ORDER BY period_year DESC, period_month DESC, employee_name ASC`,
			...args,
		);
		const salaries: SalaryPayment[] = [];
		for await (const row of rows) salaries.push(row);
		return { salaries };
	},
);

export const getSalaryPayment = api(
	{ expose: true, auth: true, method: "GET", path: "/payroll/:id" },
	async ({ id }: { id: string }): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		const s = await fetchSalary(id);
		if (!isManager(role) && !isFinance(role) && s.created_by !== userID)
			throw APIError.permissionDenied(
				"not allowed to view this salary payment",
			);
		return s;
	},
);

// ─── Update ───────────────────────────────────────────────────────────────────

interface UpdateSalaryRequest {
	id: string;
	base_amount?: number;
	additions?: number;
	deductions?: number;
	notes?: string | null;
	payment_method?: string | null;
}

export const updateSalaryPayment = api(
	{ expose: true, auth: true, method: "PUT", path: "/payroll/:id" },
	async ({ id, ...req }: UpdateSalaryRequest): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		const current = await fetchSalary(id);

		const creatorEditable =
			current.created_by === userID && current.status === "pending_manager";
		const managerEditable =
			isManager(role) &&
			["pending_manager", "pending_admin"].includes(current.status);
		if (!creatorEditable && !managerEditable)
			throw APIError.permissionDenied(
				"not allowed to edit this salary payment",
			);

		const base = req.base_amount ?? Number(current.base_amount);
		const additions = req.additions ?? Number(current.additions);
		const deductions = req.deductions ?? Number(current.deductions);
		const net = computeNet(base, additions, deductions);

		await db.exec`
      UPDATE salary_payments SET
        base_amount    = ${base},
        additions      = ${additions},
        deductions     = ${deductions},
        net_amount     = ${net},
        notes          = ${req.notes !== undefined ? req.notes : current.notes},
        payment_method = ${req.payment_method !== undefined ? req.payment_method : current.payment_method},
        updated_at     = NOW()
      WHERE id = ${id}
    `;
		await logEvent(id, "updated", userID, current.created_by_name);
		return fetchSalary(id);
	},
);

// ─── Delete (super_admin only) ────────────────────────────────────────────────

export const deleteSalaryPayment = api(
	{ expose: true, auth: true, method: "DELETE", path: "/payroll/:id" },
	async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied(
				"only super admins can delete salary payments",
			);
		const existing = await db.queryRow<{ id: string }>`
      SELECT id FROM salary_payments WHERE id = ${id}
    `;
		if (!existing) throw APIError.notFound("salary payment not found");
		await db.exec`DELETE FROM salary_payments WHERE id = ${id}`;
		return { ok: true };
	},
);

// ─── Approvals ────────────────────────────────────────────────────────────────

export const approveSalaryPayment = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/:id/approve" },
	async ({ id }: { id: string }): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		const s = await fetchSalary(id);
		const actorName = await actorNameOf(userID);

		if (s.status === "pending_manager") {
			if (!isManager(role))
				throw APIError.permissionDenied("manager approval required");
			await db.exec`
        UPDATE salary_payments SET
          status = 'pending_admin',
          manager_approved_by = ${userID},
          manager_approved_at = NOW(),
          updated_at = NOW()
        WHERE id = ${id}
      `;
			await logEvent(id, "manager_approved", userID, actorName);
			const updated = await fetchSalary(id);
			void notifyRoles(
				["admin", "super_admin"],
				`Salary awaiting admin approval — ${updated.reference}`,
				emailShell(
					"Salary Awaiting Admin Approval",
					salaryRows(updated),
					"Manager approval complete. Admin sign-off is required to proceed.",
				),
			);
			return updated;
		}

		if (s.status === "pending_admin") {
			if (!isAdmin(role))
				throw APIError.permissionDenied("admin approval required");
			await db.exec`
        UPDATE salary_payments SET
          status = 'approved',
          admin_approved_by = ${userID},
          admin_approved_at = NOW(),
          updated_at = NOW()
        WHERE id = ${id}
      `;
			await logEvent(id, "admin_approved", userID, actorName);
			const updated = await fetchSalary(id);
			void notifyRoles(
				["finance", "super_admin"],
				`Salary approved — ready for processing — ${updated.reference}`,
				emailShell(
					"Salary Approved — Ready for Processing",
					salaryRows(updated),
					"This salary payment has been fully approved and is ready for finance processing.",
				),
			);
			return updated;
		}

		throw APIError.failedPrecondition(
			`salary cannot be approved from status '${s.status}'`,
		);
	},
);

interface RejectSalaryRequest {
	id: string;
	reason?: string;
}

export const rejectSalaryPayment = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/:id/reject" },
	async ({ id, reason }: RejectSalaryRequest): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		const s = await fetchSalary(id);
		if (!["pending_manager", "pending_admin"].includes(s.status))
			throw APIError.failedPrecondition(
				`salary cannot be rejected from status '${s.status}'`,
			);
		if (!isManager(role))
			throw APIError.permissionDenied("only managers or admins can reject");

		const actorName = await actorNameOf(userID);
		await db.exec`
      UPDATE salary_payments SET
        status = 'rejected',
        rejected_by = ${userID},
        rejected_at = NOW(),
        rejection_reason = ${reason ?? null},
        updated_at = NOW()
      WHERE id = ${id}
    `;
		await logEvent(id, "rejected", userID, actorName, reason);
		const updated = await fetchSalary(id);
		void notifyUser(
			updated.created_by,
			`Salary payment rejected — ${updated.reference}`,
			emailShell(
				"Salary Payment Rejected",
				salaryRows(updated) +
					(reason
						? `<tr><td style="padding:6px 0;color:#94a3b8;">Reason</td><td style="padding:6px 0;color:#dc2626;font-weight:600;">${reason}</td></tr>`
						: ""),
				"Please review the feedback and resubmit if appropriate.",
			),
		);
		return updated;
	},
);

// ─── Finance processing (supports partial payment) ────────────────────────────

interface ProcessSalaryRequest {
	id: string;
	action: "start" | "pay";
	payment_reference?: string;
	paid_amount?: number;
}

export const processSalaryPayment = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/:id/process" },
	async ({
		id,
		action,
		payment_reference,
		paid_amount,
	}: ProcessSalaryRequest): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role))
			throw APIError.permissionDenied("only finance can process salaries");
		const s = await fetchSalary(id);
		const actorName = await actorNameOf(userID);

		if (action === "start") {
			if (s.status !== "approved")
				throw APIError.failedPrecondition("salary must be approved first");
			await db.exec`
        UPDATE salary_payments SET status = 'processing', updated_at = NOW() WHERE id = ${id}
      `;
			await logEvent(id, "processing_started", userID, actorName);
			return fetchSalary(id);
		}

		if (action === "pay") {
			if (!["approved", "processing"].includes(s.status))
				throw APIError.failedPrecondition(
					"salary must be approved or processing to mark paid",
				);
			const paid = paid_amount ?? Number(s.net_amount);
			await db.exec`
        UPDATE salary_payments SET
          status = 'paid',
          processed_by = ${userID},
          processed_at = NOW(),
          paid_at = NOW(),
          payment_reference = ${payment_reference ?? null},
          paid_amount = ${paid},
          updated_at = NOW()
        WHERE id = ${id}
      `;
			await logEvent(
				id,
				"paid",
				userID,
				actorName,
				payment_reference ?? undefined,
			);
			const updated = await fetchSalary(id);
			void notifyUser(
				updated.created_by,
				`Salary paid — ${updated.reference}`,
				emailShell(
					"Salary Paid",
					salaryRows(updated) +
						`<tr><td style="padding:6px 0;color:#94a3b8;">Paid amount</td><td style="padding:6px 0;color:#16a34a;font-weight:700;">${SAR(Number(updated.paid_amount ?? updated.net_amount))}</td></tr>` +
						(updated.payment_reference
							? `<tr><td style="padding:6px 0;color:#94a3b8;">Payment ref</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${updated.payment_reference}</td></tr>`
							: ""),
					"This salary payment has been processed and paid.",
				),
			);
			return updated;
		}

		throw APIError.invalidArgument("action must be 'start' or 'pay'");
	},
);

// ─── Events / audit trail ─────────────────────────────────────────────────────

interface SalaryEvent {
	id: string;
	salary_id: string;
	action: string;
	actor_id: string | null;
	actor_name: string | null;
	note: string | null;
	created_at: string;
}

export const listSalaryEvents = api(
	{ expose: true, auth: true, method: "GET", path: "/payroll/:id/events" },
	async ({ id }: { id: string }): Promise<{ events: SalaryEvent[] }> => {
		const rows = db.query<SalaryEvent>`
      SELECT id, salary_id, action, actor_id, actor_name, note, created_at
      FROM salary_payment_events WHERE salary_id = ${id}
      ORDER BY created_at ASC
    `;
		const events: SalaryEvent[] = [];
		for await (const row of rows) events.push(row);
		return { events };
	},
);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface SalaryStats {
	total_count: number;
	total_net: number;
	pending_count: number;
	pending_net: number;
	approved_count: number;
	approved_net: number;
	paid_count: number;
	paid_amount: number;
}

export const salaryStats = api(
	{ expose: true, auth: true, method: "GET", path: "/payroll-stats" },
	async (): Promise<SalaryStats> => {
		const row = await db.queryRow<SalaryStats>`
      SELECT
        COUNT(*)::int AS total_count,
        COALESCE(SUM(net_amount), 0) AS total_net,
        COUNT(*) FILTER (WHERE status IN ('pending_manager', 'pending_admin'))::int AS pending_count,
        COALESCE(SUM(net_amount) FILTER (WHERE status IN ('pending_manager', 'pending_admin')), 0) AS pending_net,
        COUNT(*) FILTER (WHERE status IN ('approved', 'processing'))::int AS approved_count,
        COALESCE(SUM(net_amount) FILTER (WHERE status IN ('approved', 'processing')), 0) AS approved_net,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
        COALESCE(SUM(COALESCE(paid_amount, net_amount)) FILTER (WHERE status = 'paid'), 0) AS paid_amount
      FROM salary_payments
    `;
		return row!;
	},
);
