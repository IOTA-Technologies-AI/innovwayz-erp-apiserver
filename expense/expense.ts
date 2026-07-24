import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user, financial, billing } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";
import { canAccessModule, MODULE_ROUTES } from "../authz/capabilities";

const db = new SQLDatabase("expense", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

type ExpenseStatus =
	| "draft"
	| "pending_manager"
	| "pending_admin"
	| "approved"
	| "processing"
	| "paid"
	| "rejected"
	| "cancelled";

export interface Expense {
	id: string;
	reference: string;
	category: string; // 'employee' | 'company'
	expense_class: string; // petty | infrastructure | management | operational | employee | other
	expense_type_code: string | null;
	expense_type_name: string;
	employee_id: string | null;
	employee_name: string | null;
	customer_id: string | null;
	customer_name: string | null;
	title: string;
	description: string | null;
	amount: number;
	currency: string;
	expense_date: string;
	vendor: string | null;
	payment_method: string | null;
	attachment_url: string | null;
	status: ExpenseStatus;
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
	recurring_id: string | null;
	period_month: number | null;
	period_year: number | null;
	posted_by: string | null;
	posted_at: string | null;
	created_at: string;
	updated_at: string;
}

interface ExpenseType {
	id: string;
	code: string;
	name: string;
	applies_to: string;
	is_active: boolean;
	sort_order: number;
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

/**
 * Expense view/create/edit capability: a manager/finance role, OR a user
 * granted the Expenses module route. Sensitive actions (approve, process/pay,
 * delete, ledger reconcile) keep their own role checks.
 */
function canManageExpenses(): boolean {
	const auth = getAuthData()!;
	return (
		isManager(auth.role) ||
		isFinance(auth.role) ||
		canAccessModule(auth, MODULE_ROUTES.expenses)
	);
}

// Cash-basis ledger posting: only PAID expenses post, at payment time, as
// Dr <expense account> / Cr 11100 Cash. Approved-but-unpaid expenses stay off
// the books; historical (pre-go-live) expenses are the opening balance and are
// not backfilled unless explicitly reconciled with a `paid_since` cutoff.
const EXPENSE_CASH_ACCOUNT = "11100"; // Corporate Operating Account (SAR)

const EXPENSE_COLUMNS = `
  id, reference, category, expense_class, expense_type_code, expense_type_name,
  employee_id, employee_name, customer_id, customer_name,
  title, description, amount, currency, expense_date, vendor, payment_method, attachment_url,
  status, created_by, created_by_name,
  manager_approved_by, manager_approved_at, admin_approved_by, admin_approved_at,
  rejected_by, rejected_at, rejection_reason,
  processed_by, processed_at, payment_reference, paid_amount,
  recurring_id, period_month, period_year, posted_by, posted_at,
  created_at, updated_at
`;

async function fetchExpense(id: string): Promise<Expense> {
	const row = await db.rawQueryRow<Expense>(
		`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("expense not found");
	return row;
}

async function logEvent(
	expenseId: string,
	action: string,
	actorId: string,
	actorName: string | null,
	note?: string,
): Promise<void> {
	await db.exec`
    INSERT INTO expense_events (id, expense_id, action, actor_id, actor_name, note)
    VALUES (${crypto.randomUUID()}, ${expenseId}, ${action}, ${actorId}, ${actorName ?? null}, ${note ?? null})
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

function expenseRows(e: Expense): string {
	const row = (label: string, value: string) =>
		`<tr><td style="padding:6px 0;color:#94a3b8;width:170px;">${label}</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${value}</td></tr>`;
	return [
		row("Reference", e.reference),
		row("Title", e.title),
		row("Type", e.expense_type_name),
		row("Category", e.category === "employee" ? "Employee" : "Company"),
		e.employee_name ? row("Employee", e.employee_name) : "",
		row("Amount", SAR(Number(e.amount))),
		row("Date", e.expense_date),
		row("Raised by", e.created_by_name ?? "—"),
	].join("");
}

// ─── Reference generation ─────────────────────────────────────────────────────

async function nextReference(): Promise<string> {
	const row = await db.queryRow<{ n: number }>`
    SELECT nextval('expense_reference_seq') AS n
  `;
	const year = new Date().getFullYear();
	return `EXP-${year}-${String(row!.n).padStart(6, "0")}`;
}

// ─── Expense Types ────────────────────────────────────────────────────────────

export const listExpenseTypes = api(
	{ expose: true, auth: true, method: "GET", path: "/expense-types" },
	async (): Promise<{ types: ExpenseType[] }> => {
		const rows = db.query<ExpenseType>`
      SELECT id, code, name, applies_to, is_active, sort_order
      FROM expense_types
      WHERE is_active = TRUE
      ORDER BY sort_order, name
    `;
		const types: ExpenseType[] = [];
		for await (const row of rows) types.push(row);
		return { types };
	},
);

interface CreateExpenseTypeRequest {
	code: string;
	name: string;
	applies_to?: string;
	sort_order?: number;
}

export const createExpenseType = api(
	{ expose: true, auth: true, method: "POST", path: "/expense-types" },
	async (req: CreateExpenseTypeRequest): Promise<ExpenseType> => {
		const { role } = getAuthData()!;
		if (!isAdmin(role))
			throw APIError.permissionDenied("only admins can manage expense types");
		if (!req.code || !req.name)
			throw APIError.invalidArgument("code and name are required");
		const applies = req.applies_to ?? "both";
		if (!["employee", "company", "both"].includes(applies))
			throw APIError.invalidArgument("invalid applies_to");
		const id = crypto.randomUUID();
		try {
			await db.exec`
        INSERT INTO expense_types (id, code, name, applies_to, sort_order)
        VALUES (${id}, ${req.code}, ${req.name}, ${applies}, ${req.sort_order ?? 100})
      `;
		} catch (err) {
			if (/unique|duplicate/i.test(String(err)))
				throw APIError.alreadyExists("expense type code already exists");
			throw err;
		}
		const row = await db.queryRow<ExpenseType>`
      SELECT id, code, name, applies_to, is_active, sort_order
      FROM expense_types WHERE id = ${id}
    `;
		return row!;
	},
);

// ─── Create expense ───────────────────────────────────────────────────────────

interface CreateExpenseRequest {
	category: string; // 'employee' | 'company'
	expense_class?: string;
	expense_type_code?: string;
	expense_type_name: string;
	employee_id?: string;
	employee_name?: string;
	customer_id?: string;
	customer_name?: string;
	title: string;
	description?: string;
	amount: number;
	currency?: string;
	expense_date?: string;
	vendor?: string;
	payment_method?: string;
	attachment_url?: string;
	period_month?: number;
	period_year?: number;
	// When true the expense is saved as an editable draft instead of being
	// submitted straight into the approval workflow.
	as_draft?: boolean;
}

export const createExpense = api(
	{ expose: true, auth: true, method: "POST", path: "/expenses" },
	async (req: CreateExpenseRequest): Promise<Expense> => {
		const { userID } = getAuthData()!;

		if (!req.title) throw APIError.invalidArgument("title is required");
		if (!req.expense_type_name)
			throw APIError.invalidArgument("expense_type_name is required");
		if (req.amount === undefined || req.amount === null || req.amount < 0)
			throw APIError.invalidArgument("amount must be a positive number");
		const category = req.category === "employee" ? "employee" : "company";
		const expenseClass =
			req.expense_class ??
			(category === "employee" ? "employee" : "operational");
		if (
			![
				"petty",
				"infrastructure",
				"management",
				"operational",
				"employee",
				"other",
			].includes(expenseClass)
		)
			throw APIError.invalidArgument("invalid expense_class");
		if (category === "employee" && !req.employee_id)
			throw APIError.invalidArgument(
				"employee_id is required for employee expenses",
			);

		let creatorName: string | null = null;
		try {
			const contact = await user.getContact({ id: userID });
			creatorName = contact.name;
		} catch {
			creatorName = null;
		}

		const id = crypto.randomUUID();
		const reference = await nextReference();
		const status = req.as_draft ? "draft" : "pending_manager";

		await db.exec`
      INSERT INTO expenses (
        id, reference, category, expense_class, expense_type_code, expense_type_name,
        employee_id, employee_name, customer_id, customer_name,
        title, description, amount, currency, expense_date, vendor, payment_method, attachment_url,
        status, created_by, created_by_name, period_month, period_year
      ) VALUES (
        ${id}, ${reference}, ${category}, ${expenseClass}, ${req.expense_type_code ?? null}, ${req.expense_type_name},
        ${req.employee_id ?? null}, ${req.employee_name ?? null}, ${req.customer_id ?? null}, ${req.customer_name ?? null},
        ${req.title}, ${req.description ?? null}, ${req.amount}, ${req.currency ?? "SAR"},
        ${req.expense_date ?? new Date().toISOString().slice(0, 10)}, ${req.vendor ?? null},
        ${req.payment_method ?? null}, ${req.attachment_url ?? null},
        ${status}, ${userID}, ${creatorName}, ${req.period_month ?? null}, ${req.period_year ?? null}
      )
    `;

		await logEvent(
			id,
			req.as_draft ? "created_draft" : "created",
			userID,
			creatorName,
		);

		const created = await fetchExpense(id);

		// Notify managers & admins only once the expense is actually submitted.
		if (!req.as_draft) {
			void notifyRoles(
				["manager", "admin", "super_admin"],
				`New expense pending approval — ${created.reference}`,
				emailShell(
					"New Expense Awaiting Approval",
					expenseRows(created),
					"Please review this expense in the InnovWayz ERP portal.",
				),
			);
		}

		return created;
	},
);

// ─── List / Get ───────────────────────────────────────────────────────────────

interface ListExpensesParams {
	status?: string;
	category?: string;
	employee_id?: string;
	customer_id?: string;
	customer_name?: string;
	created_by?: string;
	year?: number;
	month?: number; // 1-12
	quarter?: number; // 1-4
	date_from?: string; // YYYY-MM-DD (inclusive)
	date_to?: string; // YYYY-MM-DD (inclusive)
	mine?: boolean;
	limit?: number; // default 100, max 100
	offset?: number;
}

interface ListExpensesResponse {
	expenses: Expense[];
	total: number;
	limit: number;
	offset: number;
}

export const listExpenses = api(
	{ expose: true, auth: true, method: "GET", path: "/expenses" },
	async (p: ListExpensesParams): Promise<ListExpensesResponse> => {
		const { userID, role } = getAuthData()!;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		// BDMs see ONLY expenses of employees tagged to them (employee_id IN …,
		// which also excludes company expenses with a NULL employee_id).
		if (role === "bdm") {
			const { employee_ids } = await billing.getBdmEmployeeIds({
				bdm_user_id: userID,
			});
			if (employee_ids.length === 0)
				return { expenses: [], total: 0, limit: Number(p.limit) || 100, offset: Number(p.offset) || 0 };
			const ph = employee_ids.map((id) => {
				args.push(id);
				return `$${args.length}`;
			});
			clauses.push(`employee_id IN (${ph.join(", ")})`);
		} else if (!canManageExpenses() || !!p.mine) {
			// Plain users only see their own expenses; managers/finance can opt into 'mine'.
			add("created_by = $?", userID);
		}
		if (p.status) add("status = $?", p.status);
		if (p.category) add("category = $?", p.category);
		if (p.employee_id) add("employee_id = $?", p.employee_id);
		if (p.customer_id) add("customer_id = $?", p.customer_id);
		if (p.customer_name) add("customer_name = $?", p.customer_name);
		if (p.created_by) add("created_by = $?", p.created_by);
		if (p.year) add("EXTRACT(YEAR FROM expense_date) = $?", p.year);
		if (p.month) add("EXTRACT(MONTH FROM expense_date) = $?", p.month);
		if (p.quarter) add("EXTRACT(QUARTER FROM expense_date) = $?", p.quarter);
		if (p.date_from) add("expense_date >= $?", p.date_from);
		if (p.date_to) add("expense_date <= $?", p.date_to);

		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

		// Total (before pagination) so the UI can render page controls.
		const countRow = await db.rawQueryRow<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM expenses ${where}`,
			...args,
		);
		const total = countRow?.n ?? 0;

		// Pagination — cap at 100 rows per request; newest first by default.
		const limit = Math.min(Math.max(Number(p.limit) || 100, 1), 100);
		const offset = Math.max(Number(p.offset) || 0, 0);
		const pagedArgs = [...args, limit, offset];
		const limitIdx = args.length + 1;
		const offsetIdx = args.length + 2;

		const rows = db.rawQuery<Expense>(
			`SELECT ${EXPENSE_COLUMNS} FROM expenses ${where}
       ORDER BY expense_date DESC, created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
			...pagedArgs,
		);
		const expenses: Expense[] = [];
		for await (const row of rows) expenses.push(row);
		return { expenses, total, limit, offset };
	},
);

// ─── Filter option values (for dropdowns) ─────────────────────────────────────

interface ExpenseFilterOptions {
	customers: string[];
	creators: { id: string; name: string | null }[];
	years: number[];
}

export const expenseFilterOptions = api(
	{ expose: true, auth: true, method: "GET", path: "/expenses-filters" },
	async (): Promise<ExpenseFilterOptions> => {
		const customers: string[] = [];
		const cRows = db.query<{ customer_name: string }>`
      SELECT DISTINCT customer_name FROM expenses
      WHERE customer_name IS NOT NULL AND customer_name <> ''
      ORDER BY customer_name
    `;
		for await (const r of cRows) customers.push(r.customer_name);

		const creators: { id: string; name: string | null }[] = [];
		const uRows = db.query<{
			created_by: string;
			created_by_name: string | null;
		}>`
      SELECT created_by, MAX(created_by_name) AS created_by_name
      FROM expenses
      GROUP BY created_by
      ORDER BY created_by_name NULLS LAST
    `;
		for await (const r of uRows)
			creators.push({ id: r.created_by, name: r.created_by_name });

		const years: number[] = [];
		const yRows = db.query<{ y: number }>`
      SELECT DISTINCT EXTRACT(YEAR FROM expense_date)::int AS y
      FROM expenses ORDER BY y DESC
    `;
		for await (const r of yRows) years.push(r.y);

		return { customers, creators, years };
	},
);

export const getExpense = api(
	{ expose: true, auth: true, method: "GET", path: "/expenses/:id" },
	async ({ id }: { id: string }): Promise<Expense> => {
		const { userID } = getAuthData()!;
		const e = await fetchExpense(id);
		if (!canManageExpenses() && e.created_by !== userID)
			throw APIError.permissionDenied("not allowed to view this expense");
		return e;
	},
);

// ─── Update ───────────────────────────────────────────────────────────────────

interface UpdateExpenseRequest {
	id: string;
	category?: string;
	expense_class?: string;
	expense_type_code?: string;
	expense_type_name?: string;
	employee_id?: string | null;
	employee_name?: string | null;
	customer_id?: string | null;
	customer_name?: string | null;
	title?: string;
	description?: string | null;
	amount?: number;
	currency?: string;
	expense_date?: string;
	vendor?: string | null;
	payment_method?: string | null;
	attachment_url?: string | null;
}

export const updateExpense = api(
	{ expose: true, auth: true, method: "PUT", path: "/expenses/:id" },
	async ({ id, ...req }: UpdateExpenseRequest): Promise<Expense> => {
		const { userID, role } = getAuthData()!;
		const current = await fetchExpense(id);

		// Creator may edit while the record is a draft or still pending initial
		// (manager) approval. Admins/super_admins may edit until processed/paid.
		const creatorEditable =
			current.created_by === userID &&
			["draft", "pending_manager"].includes(current.status);
		const adminEditable =
			(isAdmin(role) || canManageExpenses()) &&
			!["paid", "cancelled"].includes(current.status);
		if (!creatorEditable && !adminEditable)
			throw APIError.permissionDenied("not allowed to edit this expense");

		await db.exec`
      UPDATE expenses SET
        category          = COALESCE(${req.category ?? null}, category),
        expense_class     = COALESCE(${req.expense_class ?? null}, expense_class),
        expense_type_code = COALESCE(${req.expense_type_code ?? null}, expense_type_code),
        expense_type_name = COALESCE(${req.expense_type_name ?? null}, expense_type_name),
        employee_id       = ${req.employee_id !== undefined ? req.employee_id : current.employee_id},
        employee_name     = ${req.employee_name !== undefined ? req.employee_name : current.employee_name},
        customer_id       = ${req.customer_id !== undefined ? req.customer_id : current.customer_id},
        customer_name     = ${req.customer_name !== undefined ? req.customer_name : current.customer_name},
        title             = COALESCE(${req.title ?? null}, title),
        description       = ${req.description !== undefined ? req.description : current.description},
        amount            = COALESCE(${req.amount ?? null}, amount),
        currency          = COALESCE(${req.currency ?? null}, currency),
        expense_date      = COALESCE(${req.expense_date ?? null}, expense_date),
        vendor            = ${req.vendor !== undefined ? req.vendor : current.vendor},
        payment_method    = ${req.payment_method !== undefined ? req.payment_method : current.payment_method},
        attachment_url    = ${req.attachment_url !== undefined ? req.attachment_url : current.attachment_url},
        updated_at        = NOW()
      WHERE id = ${id}
    `;
		await logEvent(id, "updated", userID, current.created_by_name);
		return fetchExpense(id);
	},
);

// ─── Delete (super_admin only) ────────────────────────────────────────────────

export const deleteExpense = api(
	{ expose: true, auth: true, method: "DELETE", path: "/expenses/:id" },
	async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("only super admins can delete expenses");
		const existing = await db.queryRow<{ id: string }>`
      SELECT id FROM expenses WHERE id = ${id}
    `;
		if (!existing) throw APIError.notFound("expense not found");
		await db.exec`DELETE FROM expenses WHERE id = ${id}`;
		return { ok: true };
	},
);

// ─── Post (submit a draft for approval) ───────────────────────────────────────

export const postExpense = api(
	{ expose: true, auth: true, method: "POST", path: "/expenses/:id/post" },
	async ({ id }: { id: string }): Promise<Expense> => {
		const { userID, role } = getAuthData()!;
		const e = await fetchExpense(id);
		if (e.status !== "draft")
			throw APIError.failedPrecondition("only draft expenses can be posted");
		if (e.created_by !== userID && !isManager(role) && !isFinance(role))
			throw APIError.permissionDenied("not allowed to post this expense");

		let actorName: string | null = null;
		try {
			actorName = (await user.getContact({ id: userID })).name;
		} catch {
			actorName = null;
		}

		await db.exec`
      UPDATE expenses SET
        status = 'pending_manager', posted_by = ${userID}, posted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
		await logEvent(id, "submitted", userID, actorName);
		const updated = await fetchExpense(id);
		void notifyRoles(
			["manager", "admin", "super_admin"],
			`Expense submitted for approval — ${updated.reference}`,
			emailShell(
				"Expense Submitted for Approval",
				expenseRows(updated),
				"Please review this expense in the InnovWayz ERP portal.",
			),
		);
		return updated;
	},
);

// ─── Approvals ────────────────────────────────────────────────────────────────

export const approveExpense = api(
	{ expose: true, auth: true, method: "POST", path: "/expenses/:id/approve" },
	async ({ id, amount }: { id: string; amount?: number }): Promise<Expense> => {
		const { userID, role } = getAuthData()!;
		let e = await fetchExpense(id);

		let actorName: string | null = null;
		try {
			actorName = (await user.getContact({ id: userID })).name;
		} catch {
			actorName = null;
		}

		// Approver may amend the amount (up or down) before signing off.
		if (
			amount !== undefined &&
			amount !== null &&
			Number(amount) !== Number(e.amount)
		) {
			if (amount < 0) throw APIError.invalidArgument("amount must be positive");
			const prev = Number(e.amount);
			await db.exec`UPDATE expenses SET amount = ${amount}, updated_at = NOW() WHERE id = ${id}`;
			await logEvent(
				id,
				"amount_amended",
				userID,
				actorName,
				`${SAR(prev)} → ${SAR(Number(amount))}`,
			);
			e = await fetchExpense(id);
		}

		if (e.status === "pending_manager") {
			if (!isManager(role))
				throw APIError.permissionDenied("manager approval required");
			await db.exec`
        UPDATE expenses SET
          status = 'pending_admin',
          manager_approved_by = ${userID},
          manager_approved_at = NOW(),
          updated_at = NOW()
        WHERE id = ${id}
      `;
			await logEvent(id, "manager_approved", userID, actorName);
			const updated = await fetchExpense(id);
			void notifyRoles(
				["admin", "super_admin"],
				`Expense awaiting admin approval — ${updated.reference}`,
				emailShell(
					"Expense Awaiting Admin Approval",
					expenseRows(updated),
					"Manager approval complete. Admin sign-off is required to proceed.",
				),
			);
			return updated;
		}

		if (e.status === "pending_admin") {
			if (!isAdmin(role))
				throw APIError.permissionDenied("admin approval required");
			await db.exec`
        UPDATE expenses SET
          status = 'approved',
          admin_approved_by = ${userID},
          admin_approved_at = NOW(),
          updated_at = NOW()
        WHERE id = ${id}
      `;
			await logEvent(id, "admin_approved", userID, actorName);
			const updated = await fetchExpense(id);

			// Cash-basis: approving an expense does NOT post to the ledger — only
			// a recorded payment does (see the "pay" action). Approved-but-unpaid
			// expenses stay off the books until the cash goes out.

			void notifyRoles(
				["finance", "super_admin"],
				`Expense approved — ready for processing — ${updated.reference}`,
				emailShell(
					"Expense Approved — Ready for Processing",
					expenseRows(updated),
					"This expense has been fully approved and is ready for finance processing.",
				),
			);
			// Notify the creator that their expense was approved.
			void notifyUser(
				updated.created_by,
				`Your expense was approved — ${updated.reference}`,
				emailShell(
					"Expense Approved",
					expenseRows(updated),
					"Your expense has been approved and sent to finance for processing.",
				),
			);
			return updated;
		}

		throw APIError.failedPrecondition(
			`expense cannot be approved from status '${e.status}'`,
		);
	},
);

interface RejectExpenseRequest {
	id: string;
	reason?: string;
}

export const rejectExpense = api(
	{ expose: true, auth: true, method: "POST", path: "/expenses/:id/reject" },
	async ({ id, reason }: RejectExpenseRequest): Promise<Expense> => {
		const { userID, role } = getAuthData()!;
		const e = await fetchExpense(id);
		if (!["pending_manager", "pending_admin"].includes(e.status))
			throw APIError.failedPrecondition(
				`expense cannot be rejected from status '${e.status}'`,
			);
		if (!isManager(role))
			throw APIError.permissionDenied("only managers or admins can reject");

		let actorName: string | null = null;
		try {
			actorName = (await user.getContact({ id: userID })).name;
		} catch {
			actorName = null;
		}

		await db.exec`
      UPDATE expenses SET
        status = 'rejected',
        rejected_by = ${userID},
        rejected_at = NOW(),
        rejection_reason = ${reason ?? null},
        updated_at = NOW()
      WHERE id = ${id}
    `;
		await logEvent(id, "rejected", userID, actorName, reason);
		const updated = await fetchExpense(id);
		void notifyUser(
			updated.created_by,
			`Your expense was rejected — ${updated.reference}`,
			emailShell(
				"Expense Rejected",
				expenseRows(updated) +
					(reason
						? `<tr><td style="padding:6px 0;color:#94a3b8;">Reason</td><td style="padding:6px 0;color:#dc2626;font-weight:600;">${reason}</td></tr>`
						: ""),
				"Please review the feedback and resubmit if appropriate.",
			),
		);
		return updated;
	},
);

// ─── Finance processing ───────────────────────────────────────────────────────

interface ProcessExpenseRequest {
	id: string;
	action: "start" | "pay";
	payment_reference?: string;
	paid_amount?: number;
}

/** Maps expense_class to the correct CoA account for auto journal entries. */
function mapExpenseClassToAccount(expenseClass: string): string {
	switch (expenseClass) {
		case "employee":
			return "51100"; // Contracted Resource Monthly Payroll
		case "infrastructure":
			return "52200"; // Enterprise Software Licenses & SaaS
		case "management":
			return "52100"; // Executive Staff Salaries
		case "petty":
			return "52100"; // Executive Staff Salaries (misc)
		case "operational":
			return "52300"; // Legal, Compliance & Audit Fees
		default:
			return "52300";
	}
}

export const processExpense = api(
	{ expose: true, auth: true, method: "POST", path: "/expenses/:id/process" },
	async ({
		id,
		action,
		payment_reference,
		paid_amount,
	}: ProcessExpenseRequest): Promise<Expense> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role))
			throw APIError.permissionDenied("only finance can process expenses");
		const e = await fetchExpense(id);

		let actorName: string | null = null;
		try {
			actorName = (await user.getContact({ id: userID })).name;
		} catch {
			actorName = null;
		}

		if (action === "start") {
			if (e.status !== "approved")
				throw APIError.failedPrecondition("expense must be approved first");
			await db.exec`
        UPDATE expenses SET status = 'processing', updated_at = NOW() WHERE id = ${id}
      `;
			await logEvent(id, "processing_started", userID, actorName);
			return fetchExpense(id);
		}

		if (action === "pay") {
			if (!["approved", "processing"].includes(e.status))
				throw APIError.failedPrecondition(
					"expense must be approved or processing to mark paid",
				);
			await db.exec`
        UPDATE expenses SET
          status = 'paid',
          processed_by = ${userID},
          processed_at = NOW(),
          payment_reference = ${payment_reference ?? null},
          paid_amount = ${paid_amount ?? e.amount},
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
			const updated = await fetchExpense(id);

			// ── Cash-basis payment: Dr <expense acct> / Cr 11100 Cash ───────────
			// Recognise the cost when the cash goes out. Best-effort: a posting
			// failure must not fail the payment — reconcileExpensesToLedger backfills.
			const paidAmt = Number(paid_amount ?? e.amount);
			try {
				await financial.recordAutoEntry({
					fiscal_period: new Date().toISOString().slice(0, 7),
					reference_source: `${e.reference}:pay`,
					description: `Expense paid — ${e.reference} — ${e.title}`,
					debit_account: mapExpenseClassToAccount(e.expense_class), // the cost
					credit_account: EXPENSE_CASH_ACCOUNT, // 11100 cash out
					amount: paidAmt,
					actor_id: userID,
					actor_name: actorName,
				});
			} catch (err: unknown) {
				log.warn("cash-basis expense payment posting failed", {
					id,
					error: String(err),
				});
			}

			void notifyUser(
				updated.created_by,
				`Your expense was paid — ${updated.reference}`,
				emailShell(
					"Expense Paid",
					expenseRows(updated) +
						`<tr><td style="padding:6px 0;color:#94a3b8;">Paid amount</td><td style="padding:6px 0;color:#16a34a;font-weight:700;">${SAR(Number(updated.paid_amount ?? updated.amount))}</td></tr>` +
						(updated.payment_reference
							? `<tr><td style="padding:6px 0;color:#94a3b8;">Payment ref</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${updated.payment_reference}</td></tr>`
							: ""),
					"This expense has been processed and paid.",
				),
			);
			return updated;
		}

		throw APIError.invalidArgument("action must be 'start' or 'pay'");
	},
);

// ─── Events / audit trail ─────────────────────────────────────────────────────

interface ExpenseEvent {
	id: string;
	expense_id: string;
	action: string;
	actor_id: string | null;
	actor_name: string | null;
	note: string | null;
	created_at: string;
}

export const listExpenseEvents = api(
	{ expose: true, auth: true, method: "GET", path: "/expenses/:id/events" },
	async ({ id }: { id: string }): Promise<{ events: ExpenseEvent[] }> => {
		const rows = db.query<ExpenseEvent>`
      SELECT id, expense_id, action, actor_id, actor_name, note, created_at
      FROM expense_events WHERE expense_id = ${id}
      ORDER BY created_at ASC
    `;
		const events: ExpenseEvent[] = [];
		for await (const row of rows) events.push(row);
		return { events };
	},
);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface ExpenseStats {
	total_count: number;
	total_amount: number;
	pending_count: number;
	pending_amount: number;
	approved_count: number;
	approved_amount: number;
	paid_count: number;
	paid_amount: number;
	employee_amount: number;
	company_amount: number;
}

export const expenseStats = api(
	{ expose: true, auth: true, method: "GET", path: "/expenses-stats" },
	async (): Promise<ExpenseStats> => {
		const row = await db.queryRow<ExpenseStats>`
      SELECT
        COUNT(*)::int AS total_count,
        COALESCE(SUM(amount), 0) AS total_amount,
        COUNT(*) FILTER (WHERE status IN ('pending_manager', 'pending_admin'))::int AS pending_count,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('pending_manager', 'pending_admin')), 0) AS pending_amount,
        COUNT(*) FILTER (WHERE status IN ('approved', 'processing'))::int AS approved_count,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('approved', 'processing')), 0) AS approved_amount,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
        COALESCE(SUM(COALESCE(paid_amount, amount)) FILTER (WHERE status = 'paid'), 0) AS paid_amount,
        COALESCE(SUM(amount) FILTER (WHERE category = 'employee'), 0) AS employee_amount,
        COALESCE(SUM(amount) FILTER (WHERE category = 'company'), 0) AS company_amount
      FROM expenses
    `;
		return row!;
	},
);

// ─── Recurring templates (standard monthly expenses) ──────────────────────────

interface RecurringExpense {
	id: string;
	title: string;
	category: string;
	expense_class: string;
	expense_type_code: string | null;
	expense_type_name: string;
	// employee_id/name set → always generates for that employee.
	// NULL on an employee-scope template → choose employees at generation time.
	employee_id: string | null;
	employee_name: string | null;
	customer_id: string | null;
	customer_name: string | null;
	description: string | null;
	amount: number;
	currency: string;
	vendor: string | null;
	payment_method: string | null;
	day_of_month: number;
	active: boolean;
	// auto_generate: company-scope only. When TRUE the monthly cron
	// sends a reminder if the template wasn't generated by the 5th.
	auto_generate: boolean;
	created_by: string;
	created_by_name: string | null;
	created_at: string;
	updated_at: string;
}

const RECURRING_COLUMNS = `
  id, title, category, expense_class, expense_type_code, expense_type_name,
  employee_id, employee_name, customer_id, customer_name, description,
  amount, currency, vendor, payment_method, day_of_month, active, auto_generate,
  created_by, created_by_name, created_at, updated_at
`;

async function fetchRecurring(id: string): Promise<RecurringExpense> {
	const row = await db.rawQueryRow<RecurringExpense>(
		`SELECT ${RECURRING_COLUMNS} FROM recurring_expenses WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("recurring template not found");
	return row;
}

export const listRecurringExpenses = api(
	{ expose: true, auth: true, method: "GET", path: "/recurring-expenses" },
	async (): Promise<{ items: RecurringExpense[] }> => {
		if (!canManageExpenses())
			throw APIError.permissionDenied(
				"not allowed to view recurring templates",
			);
		const rows = db.rawQuery<RecurringExpense>(
			`SELECT ${RECURRING_COLUMNS} FROM recurring_expenses ORDER BY active DESC, title ASC`,
		);
		const items: RecurringExpense[] = [];
		for await (const row of rows) items.push(row);
		return { items };
	},
);

interface CreateRecurringRequest {
	title: string;
	category?: string;
	expense_class?: string;
	expense_type_code?: string;
	expense_type_name: string;
	employee_id?: string;
	employee_name?: string;
	customer_id?: string;
	customer_name?: string;
	description?: string;
	amount: number;
	currency?: string;
	vendor?: string;
	payment_method?: string;
	day_of_month?: number;
	active?: boolean;
	auto_generate?: boolean; // company-scope: send reminder if not generated by 5th
}

export const createRecurringExpense = api(
	{ expose: true, auth: true, method: "POST", path: "/recurring-expenses" },
	async (req: CreateRecurringRequest): Promise<RecurringExpense> => {
		const { userID } = getAuthData()!;
		if (!canManageExpenses())
			throw APIError.permissionDenied(
				"not allowed to manage recurring templates",
			);
		if (!req.title || !req.expense_type_name)
			throw APIError.invalidArgument(
				"title and expense_type_name are required",
			);

		let creatorName: string | null = null;
		try {
			creatorName = (await user.getContact({ id: userID })).name;
		} catch {
			creatorName = null;
		}

		const id = crypto.randomUUID();
		await db.exec`
      INSERT INTO recurring_expenses (
        id, title, category, expense_class, expense_type_code, expense_type_name,
        employee_id, employee_name, customer_id, customer_name, description,
        amount, currency, vendor, payment_method, day_of_month, active, auto_generate,
        created_by, created_by_name
      ) VALUES (
        ${id}, ${req.title}, ${req.category ?? "company"}, ${req.expense_class ?? "operational"},
        ${req.expense_type_code ?? null}, ${req.expense_type_name},
        ${req.employee_id ?? null}, ${req.employee_name ?? null},
        ${req.customer_id ?? null}, ${req.customer_name ?? null}, ${req.description ?? null},
        ${req.amount}, ${req.currency ?? "SAR"}, ${req.vendor ?? null}, ${req.payment_method ?? null},
        ${req.day_of_month ?? 1}, ${req.active ?? true}, ${req.auto_generate ?? false},
        ${userID}, ${creatorName}
      )
    `;
		return fetchRecurring(id);
	},
);

interface UpdateRecurringRequest extends Partial<CreateRecurringRequest> {
	id: string;
}

export const updateRecurringExpense = api(
	{ expose: true, auth: true, method: "PUT", path: "/recurring-expenses/:id" },
	async ({ id, ...req }: UpdateRecurringRequest): Promise<RecurringExpense> => {
		if (!canManageExpenses())
			throw APIError.permissionDenied(
				"not allowed to manage recurring templates",
			);
		const current = await fetchRecurring(id);
		await db.exec`
      UPDATE recurring_expenses SET
        title             = COALESCE(${req.title ?? null}, title),
        category          = COALESCE(${req.category ?? null}, category),
        expense_class     = COALESCE(${req.expense_class ?? null}, expense_class),
        expense_type_code = ${req.expense_type_code !== undefined ? req.expense_type_code : current.expense_type_code},
        expense_type_name = COALESCE(${req.expense_type_name ?? null}, expense_type_name),
        employee_id       = ${req.employee_id !== undefined ? req.employee_id : current.employee_id},
        employee_name     = ${req.employee_name !== undefined ? req.employee_name : current.employee_name},
        customer_id       = ${req.customer_id !== undefined ? req.customer_id : current.customer_id},
        customer_name     = ${req.customer_name !== undefined ? req.customer_name : current.customer_name},
        description       = ${req.description !== undefined ? req.description : current.description},
        amount            = COALESCE(${req.amount ?? null}, amount),
        currency          = COALESCE(${req.currency ?? null}, currency),
        vendor            = ${req.vendor !== undefined ? req.vendor : current.vendor},
        payment_method    = ${req.payment_method !== undefined ? req.payment_method : current.payment_method},
        day_of_month      = COALESCE(${req.day_of_month ?? null}, day_of_month),
        active            = COALESCE(${req.active ?? null}, active),
        auto_generate     = COALESCE(${req.auto_generate ?? null}, auto_generate),
        updated_at        = NOW()
      WHERE id = ${id}
    `;
		return fetchRecurring(id);
	},
);

export const deleteRecurringExpense = api(
	{
		expose: true,
		auth: true,
		method: "DELETE",
		path: "/recurring-expenses/:id",
	},
	async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
		if (!canManageExpenses())
			throw APIError.permissionDenied(
				"not allowed to manage recurring templates",
			);
		await fetchRecurring(id);
		await db.exec`DELETE FROM recurring_expenses WHERE id = ${id}`;
		return { ok: true };
	},
);

// ─── Generate monthly draft expenses from recurring templates ─────────────────
//
// Template scoping rules:
//   category='company'              → generates one expense per template.
//   category='employee', employee_id set → generates for that specific employee.
//   category='employee', employee_id NULL (generic blueprint) → generates for
//     each employee listed in employee_selections[template_id].employees.

interface EmployeeSelection {
	employee_id: string;
	employee_name: string;
	customer_id?: string;
	customer_name?: string;
	amount?: number; // overrides template amount for this employee
}

interface TemplateSelection {
	template_id: string;
	employees: EmployeeSelection[];
}

interface GenerateExpensesRequest {
	period_month: number; // 1-12
	period_year: number;
	// Required for generic employee-scope templates (employee_id IS NULL on template).
	employee_selections?: TemplateSelection[];
}

interface GenerateExpensesResponse {
	created: number;
	skipped: number;
	reminder_sent?: boolean;
}

async function insertGeneratedExpense(
	template: RecurringExpense,
	period_month: number,
	period_year: number,
	userID: string,
	creatorName: string | null,
	overrides?: Partial<EmployeeSelection>,
): Promise<void> {
	const lastDay = new Date(period_year, period_month, 0).getDate();
	const day = Math.min(Math.max(template.day_of_month || 1, 1), lastDay);
	const expenseDate = `${period_year}-${String(period_month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	const id = crypto.randomUUID();
	const reference = await nextReference();
	const empId = overrides?.employee_id ?? template.employee_id;
	const empName = overrides?.employee_name ?? template.employee_name;
	const custId = overrides?.customer_id ?? template.customer_id;
	const custName = overrides?.customer_name ?? template.customer_name;
	const amount = overrides?.amount ?? template.amount;

	await db.exec`
		INSERT INTO expenses (
			id, reference, category, expense_class, expense_type_code, expense_type_name,
			employee_id, employee_name, customer_id, customer_name,
			title, description, amount, currency, expense_date, vendor, payment_method,
			status, created_by, created_by_name, recurring_id, period_month, period_year
		) VALUES (
			${id}, ${reference}, ${template.category}, ${template.expense_class},
			${template.expense_type_code}, ${template.expense_type_name},
			${empId}, ${empName}, ${custId}, ${custName},
			${template.title}, ${template.description}, ${amount}, ${template.currency},
			${expenseDate}, ${template.vendor}, ${template.payment_method},
			'draft', ${userID}, ${creatorName}, ${template.id}, ${period_month}, ${period_year}
		)
	`;
	await logEvent(
		id,
		"generated",
		userID,
		creatorName,
		`From template: ${template.title}${empName ? ` — ${empName}` : ""}`,
	);
}

export const generateMonthlyExpenses = api(
	{ expose: true, auth: true, method: "POST", path: "/expenses/generate" },
	async (req: GenerateExpensesRequest): Promise<GenerateExpensesResponse> => {
		const { userID } = getAuthData()!;
		if (!canManageExpenses())
			throw APIError.permissionDenied("not allowed to generate expenses");
		if (req.period_month < 1 || req.period_month > 12)
			throw APIError.invalidArgument("period_month must be between 1 and 12");

		let creatorName: string | null = null;
		try {
			creatorName = (await user.getContact({ id: userID })).name;
		} catch {
			creatorName = null;
		}

		// Build a lookup: template_id → [employees] for generic employee templates
		const empSelMap = new Map<string, EmployeeSelection[]>();
		for (const sel of req.employee_selections ?? []) {
			empSelMap.set(sel.template_id, sel.employees);
		}

		const templates: RecurringExpense[] = [];
		const tRows = db.rawQuery<RecurringExpense>(
			`SELECT ${RECURRING_COLUMNS} FROM recurring_expenses WHERE active = TRUE`,
		);
		for await (const row of tRows) templates.push(row);

		let created = 0;
		let skipped = 0;

		for (const t of templates) {
			if (
				t.category === "company" ||
				(t.category === "employee" && t.employee_id)
			) {
				// Single-instance: company template OR employee-specific template.
				const existing = await db.queryRow<{ id: string }>`
					SELECT id FROM expenses
					WHERE recurring_id = ${t.id}
					  AND period_month  = ${req.period_month}
					  AND period_year   = ${req.period_year}
					  AND status <> 'cancelled'
					LIMIT 1
				`;
				if (existing) {
					skipped++;
					continue;
				}
				await insertGeneratedExpense(
					t,
					req.period_month,
					req.period_year,
					userID,
					creatorName,
				);
				created++;
			} else if (t.category === "employee" && !t.employee_id) {
				// Generic employee-blueprint: generate for each selected employee.
				const employees = empSelMap.get(t.id) ?? [];
				for (const emp of employees) {
					const existing = await db.queryRow<{ id: string }>`
						SELECT id FROM expenses
						WHERE recurring_id  = ${t.id}
						  AND period_month  = ${req.period_month}
						  AND period_year   = ${req.period_year}
						  AND employee_name = ${emp.employee_name}
						  AND status <> 'cancelled'
						LIMIT 1
					`;
					if (existing) {
						skipped++;
						continue;
					}
					await insertGeneratedExpense(
						t,
						req.period_month,
						req.period_year,
						userID,
						creatorName,
						emp,
					);
					created++;
				}
			}
		}

		return { created, skipped };
	},
);

// ─── Monthly generation reminder (auto_generate=true company templates) ───────
// Called by the cron job on the 5th of each month.
// Sends one reminder email per missing auto-generate template for the current month.

export const checkGenerationReminder = api(
	{ expose: false, method: "POST", path: "/expenses/check-reminder" },
	async (): Promise<{ reminded: number }> => {
		const now = new Date();
		const month = now.getMonth() + 1;
		const year = now.getFullYear();

		// Find auto_generate company templates not yet generated this month.
		const missing: RecurringExpense[] = [];
		const tRows = db.rawQuery<RecurringExpense>(
			`SELECT ${RECURRING_COLUMNS} FROM recurring_expenses
			 WHERE active = TRUE AND auto_generate = TRUE AND category = 'company'`,
		);
		for await (const t of tRows) {
			const existing = await db.rawQueryRow<{ id: string }>(
				`SELECT id FROM expenses
				 WHERE recurring_id = $1 AND period_month = $2 AND period_year = $3
				   AND status <> 'cancelled'
				 LIMIT 1`,
				t.id,
				month,
				year,
			);
			if (!existing) missing.push(t);
		}

		if (missing.length === 0) return { reminded: 0 };

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
		const monthName = MONTH_NAMES[month - 1];

		const rows = missing
			.map(
				(t) =>
					`<tr><td style="padding:6px 0;font-size:13px;">${t.title}</td>` +
					`<td style="padding:6px 0;font-size:13px;font-weight:600;text-align:right;">SAR ${Number(t.amount).toLocaleString()}</td></tr>`,
			)
			.join("");

		const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#0f172a;border-radius:12px 12px 0 0;padding:24px 40px;text-align:center;">
        <span style="color:#fff;font-size:20px;font-weight:700;">InnovWayz ERP</span>
      </td></tr>
      <tr><td style="background:#fff;border-radius:0 0 12px 12px;padding:32px 40px;">
        <h2 style="margin:0 0 16px;color:#0f172a;font-size:18px;">Monthly Expense Generation Reminder</h2>
        <p style="color:#64748b;font-size:14px;margin:0 0 20px;">
          The following standard company expense templates have <strong>not yet been generated</strong>
          for <strong>${monthName} ${year}</strong>. Please log in and generate them to keep records up to date.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;">${rows}</table>
        <p style="color:#64748b;font-size:13px;margin:20px 0 0;">
          Navigate to <em>Finance → Expenses → Generate Month</em> to create these drafts.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

		const subject = `[InnovWayz ERP] ${missing.length} company expense(s) not generated for ${monthName} ${year}`;
		await notifyRoles(["manager", "admin", "finance"], subject, html);

		return { reminded: missing.length };
	},
);

// Cron job: runs on the 5th of every month at 09:00 to send generation reminders.
import { CronJob } from "encore.dev/cron";
const _generationReminderCron = new CronJob("monthly-generation-reminder", {
	title: "Monthly Company Expense Generation Reminder",
	schedule: "0 9 5 * *",
	endpoint: checkGenerationReminder,
});

// ─── Reconcile paid expenses to the financial ledger ──────────────────────────

interface ExpenseReconcileResult {
	checked: number;
	posted: number;
	amount_posted: number;
}

interface ExpenseReconcileRequest {
	/**
	 * Only post expenses paid on/after this date (YYYY-MM-DD), matched against
	 * `processed_at`. Go-live cutoff: historical expenses (opening balance) are
	 * left alone. Omit to reconcile every paid expense (not normally desired).
	 */
	paid_since?: string;
}

/**
 * Cash-basis backfill: for each paid expense's cash outflow not yet on the
 * ledger, post Dr <expense account> / Cr 11100 Cash. Idempotent — posts only
 * the difference vs what is already booked for `<ref>:pay`. `paid_since` scopes
 * it so pre-go-live expenses are never injected.
 */
export const reconcileExpensesToLedger = api(
	{ expose: true, auth: true, method: "POST", path: "/expenses/reconcile-ledger" },
	async (req: ExpenseReconcileRequest): Promise<ExpenseReconcileResult> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role) && !isManager(role))
			throw APIError.permissionDenied("finance or admin only");
		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));
		const actorName = contact.name ?? null;
		const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

		const paidSince = req.paid_since ?? null;
		const rows = db.rawQuery<{
			reference: string;
			title: string;
			expense_class: string;
			amount: string;
			paid_amount: string | null;
			processed_at: string | null;
		}>(
			`SELECT reference, title, expense_class, amount::TEXT AS amount,
			        paid_amount::TEXT AS paid_amount, processed_at::TEXT AS processed_at
			 FROM expenses
			 WHERE status = 'paid'
			   AND ($1::date IS NULL OR processed_at::date >= $1::date)`,
			paidSince,
		);

		const today = new Date().toISOString().slice(0, 10);
		let checked = 0;
		let posted = 0;
		let amountPosted = 0;
		for await (const e of rows) {
			checked++;
			// Cash payment (Dr Expense / Cr Cash) for the amount actually paid.
			const paid = r2(Number(e.paid_amount ?? e.amount));
			if (paid <= 0) continue;
			const settled = await financial.postedAmountForSource({
				source_ref: `${e.reference}:pay`,
			});
			const payDiff = r2(paid - Number(settled.debit));
			if (payDiff > 0.005) {
				try {
					await financial.recordAutoEntry({
						fiscal_period: (e.processed_at ?? today).slice(0, 7),
						reference_source: `${e.reference}:pay`,
						description: `Expense paid (reconciled) — ${e.reference} — ${e.title}`,
						debit_account: mapExpenseClassToAccount(e.expense_class),
						credit_account: EXPENSE_CASH_ACCOUNT,
						amount: payDiff,
						actor_id: userID,
						actor_name: actorName,
					});
					posted++;
					amountPosted = r2(amountPosted + payDiff);
				} catch (err) {
					log.warn("expense payment reconcile failed", { reference: e.reference, error: String(err) });
				}
			}
		}
		return { checked, posted, amount_posted: amountPosted };
	},
);
