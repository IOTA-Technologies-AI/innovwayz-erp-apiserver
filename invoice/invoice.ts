import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user, billing, financial } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("invoice", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

type InvoiceStatus =
	| "draft"
	| "sent"
	| "partially_paid"
	| "paid"
	| "overdue"
	| "cancelled";

export interface Invoice {
	id: string;
	reference: string;
	customer_id: string | null;
	customer_name: string;
	employee_id: string | null;
	employee_name: string | null;
	period_month: number | null;
	period_year: number | null;
	description: string | null;
	amount: number;
	tax_amount: number;
	total_amount: number;
	currency: string;
	status: InvoiceStatus;
	issue_date: string | null;
	due_date: string | null;
	paid_date: string | null;
	paid_amount: number | null;
	payment_reference: string | null;
	notes: string | null;
	created_by: string;
	created_by_name: string | null;
	sent_by: string | null;
	sent_at: string | null;
	cancelled_by: string | null;
	cancelled_at: string | null;
	created_at: string;
	updated_at: string;
}

// ─── Role helpers ─────────────────────────────────────────────────────────────

function isManager(role: string): boolean {
	return ["manager", "admin", "super_admin"].includes(role);
}
function isFinance(role: string): boolean {
	return ["finance", "super_admin"].includes(role);
}
function canManage(role: string): boolean {
	return isManager(role) || isFinance(role);
}

const INVOICE_COLUMNS = `
  id, reference, customer_id, customer_name, employee_id, employee_name,
  period_month, period_year, description,
  amount, tax_amount, total_amount, currency, status,
  issue_date, due_date, paid_date, paid_amount, payment_reference, notes,
  created_by, created_by_name, sent_by, sent_at, cancelled_by, cancelled_at,
  created_at, updated_at
`;

async function fetchInvoice(id: string): Promise<Invoice> {
	const row = await db.rawQueryRow<Invoice>(
		`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("invoice not found");
	return row;
}

async function logEvent(
	invoiceId: string,
	action: string,
	actorId: string,
	actorName: string | null,
	note?: string,
): Promise<void> {
	await db.exec`
    INSERT INTO invoice_events (id, invoice_id, action, actor_id, actor_name, note)
    VALUES (${crypto.randomUUID()}, ${invoiceId}, ${action}, ${actorId}, ${actorName ?? null}, ${note ?? null})
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

function invoiceRows(inv: Invoice): string {
	const row = (label: string, value: string) =>
		`<tr><td style="padding:6px 0;color:#94a3b8;width:170px;">${label}</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${value}</td></tr>`;
	return [
		row("Reference", inv.reference),
		row("Customer", inv.customer_name),
		inv.employee_name ? row("Employee", inv.employee_name) : "",
		row("Amount", SAR(Number(inv.total_amount))),
		inv.issue_date ? row("Issued", inv.issue_date) : "",
		inv.due_date ? row("Due", inv.due_date) : "",
		row("Raised by", inv.created_by_name ?? "—"),
	].join("");
}

// ─── Reference generation ─────────────────────────────────────────────────────

async function nextReference(): Promise<string> {
	const row = await db.queryRow<{ n: number }>`
    SELECT nextval('invoice_reference_seq') AS n
  `;
	const year = new Date().getFullYear();
	return `INV-${year}-${String(row!.n).padStart(6, "0")}`;
}

function addDays(dateStr: string, days: number): string {
	const d = new Date(dateStr + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ─── Create ───────────────────────────────────────────────────────────────────

interface CreateInvoiceRequest {
	customer_id?: string;
	customer_name: string;
	employee_id?: string;
	employee_name?: string;
	period_month?: number;
	period_year?: number;
	description?: string;
	amount: number;
	tax_amount?: number;
	currency?: string;
	issue_date?: string;
	due_date?: string;
	notes?: string;
}

export const createInvoice = api(
	{ expose: true, auth: true, method: "POST", path: "/invoices" },
	async (req: CreateInvoiceRequest): Promise<Invoice> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied(
				"only managers or finance can raise invoices",
			);
		if (!req.customer_name)
			throw APIError.invalidArgument("customer_name is required");
		if (req.amount == null || req.amount < 0)
			throw APIError.invalidArgument("amount must be zero or positive");

		const amount = round2(Number(req.amount));
		const tax = round2(Number(req.tax_amount ?? 0));
		const total = round2(amount + tax);
		const id = crypto.randomUUID();
		const reference = await nextReference();
		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));

		await db.exec`
      INSERT INTO invoices (
        id, reference, customer_id, customer_name, employee_id, employee_name,
        period_month, period_year, description,
        amount, tax_amount, total_amount, currency, status,
        issue_date, due_date, notes, created_by, created_by_name
      ) VALUES (
        ${id}, ${reference}, ${req.customer_id ?? null}, ${req.customer_name},
        ${req.employee_id ?? null}, ${req.employee_name ?? null},
        ${req.period_month ?? null}, ${req.period_year ?? null}, ${req.description ?? null},
        ${amount}, ${tax}, ${total}, ${req.currency ?? "SAR"}, 'draft',
        ${req.issue_date ?? null}, ${req.due_date ?? null}, ${req.notes ?? null},
        ${userID}, ${contact.name ?? null}
      )
    `;

		await logEvent(id, "created", userID, contact.name ?? null);
		return fetchInvoice(id);
	},
);

// ─── Generate monthly invoices from employee billing ──────────────────────────

interface GenerateInvoicesRequest {
	period_month: number;
	period_year: number;
}
interface GenerateInvoicesResponse {
	created: number;
	skipped: number;
	total_amount: number;
}

export const generateMonthlyInvoices = api(
	{ expose: true, auth: true, method: "POST", path: "/invoices/generate" },
	async (req: GenerateInvoicesRequest): Promise<GenerateInvoicesResponse> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied(
				"only managers or finance can generate invoices",
			);
		if (!req.period_month || !req.period_year)
			throw APIError.invalidArgument(
				"period_month and period_year are required",
			);

		const { employees } = await billing.listEmployees();
		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));

		// Existing (employee, period) pairs to avoid duplicates.
		const existing = new Set<string>();
		const exRows = db.rawQuery<{ employee_id: string | null }>(
			`SELECT employee_id FROM invoices
       WHERE period_month = $1 AND period_year = $2 AND status <> 'cancelled'
         AND employee_id IS NOT NULL`,
			req.period_month,
			req.period_year,
		);
		for await (const r of exRows)
			if (r.employee_id) existing.add(r.employee_id);

		let created = 0;
		let skipped = 0;
		let totalAmount = 0;

		for (const emp of employees) {
			const billingAmount = Number(emp.monthly_billing) || 0;
			if (billingAmount <= 0) {
				skipped++;
				continue;
			}
			if (existing.has(emp.id)) {
				skipped++;
				continue;
			}
			const id = crypto.randomUUID();
			const reference = await nextReference();
			const total = round2(billingAmount);
			await db.exec`
        INSERT INTO invoices (
          id, reference, customer_id, customer_name, employee_id, employee_name,
          period_month, period_year, description,
          amount, tax_amount, total_amount, currency, status,
          created_by, created_by_name
        ) VALUES (
          ${id}, ${reference}, ${emp.customer_id}, ${emp.customer_name},
          ${emp.id}, ${emp.name},
          ${req.period_month}, ${req.period_year},
          ${`Monthly Outsourcing Services of ${emp.name}`},
          ${total}, 0, ${total}, 'SAR', 'draft',
          ${userID}, ${contact.name ?? null}
        )
      `;
			await logEvent(id, "created", userID, contact.name ?? null, "generated");
			created++;
			totalAmount += total;
		}

		return { created, skipped, total_amount: round2(totalAmount) };
	},
);

// ─── List (paginated + filters) ───────────────────────────────────────────────

interface ListInvoicesParams {
	status?: string;
	customer_id?: string;
	customer_name?: string;
	employee_id?: string;
	created_by?: string;
	year?: number;
	month?: number; // 1-12
	quarter?: number; // 1-4
	date_from?: string; // YYYY-MM-DD (issue_date, inclusive)
	date_to?: string;
	mine?: boolean;
	limit?: number;
	offset?: number;
}

interface ListInvoicesResponse {
	invoices: Invoice[];
	total: number;
	limit: number;
	offset: number;
}

export const listInvoices = api(
	{ expose: true, auth: true, method: "GET", path: "/invoices" },
	async (p: ListInvoicesParams): Promise<ListInvoicesResponse> => {
		const { userID, role } = getAuthData()!;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		// Plain users only see invoices they raised.
		const restrictToOwn = !canManage(role) || !!p.mine;
		if (restrictToOwn) add("created_by = $?", userID);

		if (p.status) add("status = $?", p.status);
		if (p.customer_id) add("customer_id = $?", p.customer_id);
		if (p.customer_name) add("customer_name = $?", p.customer_name);
		if (p.employee_id) add("employee_id = $?", p.employee_id);
		if (p.created_by) add("created_by = $?", p.created_by);
		if (p.year) add("period_year = $?", p.year);
		if (p.month) add("period_month = $?", p.month);
		if (p.quarter)
			add(
				"EXTRACT(QUARTER FROM make_date(period_year, period_month, 1)) = $?",
				p.quarter,
			);
		if (p.date_from) add("issue_date >= $?", p.date_from);
		if (p.date_to) add("issue_date <= $?", p.date_to);

		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

		const countRow = await db.rawQueryRow<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM invoices ${where}`,
			...args,
		);
		const total = countRow?.n ?? 0;

		const limit = Math.min(Math.max(Number(p.limit) || 100, 1), 100);
		const offset = Math.max(Number(p.offset) || 0, 0);
		const pagedArgs = [...args, limit, offset];
		const limitIdx = args.length + 1;
		const offsetIdx = args.length + 2;

		const rows = db.rawQuery<Invoice>(
			`SELECT ${INVOICE_COLUMNS} FROM invoices ${where}
       ORDER BY COALESCE(issue_date, paid_date, created_at::date) DESC, created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
			...pagedArgs,
		);
		const invoices: Invoice[] = [];
		for await (const row of rows) invoices.push(row);
		return { invoices, total, limit, offset };
	},
);

// ─── Filter options ───────────────────────────────────────────────────────────

interface InvoiceFilterOptions {
	customers: string[];
	creators: { id: string; name: string | null }[];
	years: number[];
}

export const invoiceFilterOptions = api(
	{ expose: true, auth: true, method: "GET", path: "/invoices-filters" },
	async (): Promise<InvoiceFilterOptions> => {
		const customers: string[] = [];
		const cRows = db.query<{ customer_name: string }>`
      SELECT DISTINCT customer_name FROM invoices
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
      FROM invoices GROUP BY created_by ORDER BY created_by_name NULLS LAST
    `;
		for await (const r of uRows)
			creators.push({ id: r.created_by, name: r.created_by_name });

		const years: number[] = [];
		const yRows = db.query<{ y: number }>`
      SELECT DISTINCT period_year AS y FROM invoices
      WHERE period_year IS NOT NULL ORDER BY y DESC
    `;
		for await (const r of yRows) years.push(r.y);

		return { customers, creators, years };
	},
);

export const getInvoice = api(
	{ expose: true, auth: true, method: "GET", path: "/invoices/:id" },
	async ({ id }: { id: string }): Promise<Invoice> => {
		const { userID, role } = getAuthData()!;
		const inv = await fetchInvoice(id);
		if (!canManage(role) && inv.created_by !== userID)
			throw APIError.permissionDenied("not allowed to view this invoice");
		return inv;
	},
);

// ─── Update ───────────────────────────────────────────────────────────────────

interface UpdateInvoiceRequest {
	id: string;
	customer_id?: string | null;
	customer_name?: string;
	employee_id?: string | null;
	employee_name?: string | null;
	period_month?: number | null;
	period_year?: number | null;
	description?: string | null;
	amount?: number;
	tax_amount?: number;
	issue_date?: string | null;
	due_date?: string | null;
	notes?: string | null;
}

export const updateInvoice = api(
	{ expose: true, auth: true, method: "PUT", path: "/invoices/:id" },
	async (req: UpdateInvoiceRequest): Promise<Invoice> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied(
				"only managers or finance can edit invoices",
			);
		const inv = await fetchInvoice(req.id);
		if (["paid", "cancelled"].includes(inv.status))
			throw APIError.failedPrecondition(
				"paid or cancelled invoices cannot be edited",
			);

		const amount = req.amount != null ? round2(Number(req.amount)) : inv.amount;
		const tax =
			req.tax_amount != null ? round2(Number(req.tax_amount)) : inv.tax_amount;
		const total = round2(amount + tax);

		await db.exec`
      UPDATE invoices SET
        customer_id   = ${req.customer_id !== undefined ? req.customer_id : inv.customer_id},
        customer_name = ${req.customer_name ?? inv.customer_name},
        employee_id   = ${req.employee_id !== undefined ? req.employee_id : inv.employee_id},
        employee_name = ${req.employee_name !== undefined ? req.employee_name : inv.employee_name},
        period_month  = ${req.period_month !== undefined ? req.period_month : inv.period_month},
        period_year   = ${req.period_year !== undefined ? req.period_year : inv.period_year},
        description   = ${req.description !== undefined ? req.description : inv.description},
        amount        = ${amount},
        tax_amount    = ${tax},
        total_amount  = ${total},
        issue_date    = ${req.issue_date !== undefined ? req.issue_date : inv.issue_date},
        due_date      = ${req.due_date !== undefined ? req.due_date : inv.due_date},
        notes         = ${req.notes !== undefined ? req.notes : inv.notes},
        updated_at    = now()
      WHERE id = ${req.id}
    `;

		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));
		await logEvent(req.id, "updated", userID, contact.name ?? null);
		return fetchInvoice(req.id);
	},
);

// ─── Delete (super_admin only) ────────────────────────────────────────────────

export const deleteInvoice = api(
	{ expose: true, auth: true, method: "DELETE", path: "/invoices/:id" },
	async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("only super admins can delete invoices");
		await fetchInvoice(id);
		await db.exec`DELETE FROM invoices WHERE id = ${id}`;
		return { ok: true };
	},
);

// ─── Send (issue to customer) ─────────────────────────────────────────────────

interface SendInvoiceRequest {
	id: string;
	issue_date?: string;
	due_date?: string;
	due_in_days?: number;
}

export const sendInvoice = api(
	{ expose: true, auth: true, method: "POST", path: "/invoices/:id/send" },
	async (req: SendInvoiceRequest): Promise<Invoice> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied(
				"only managers or finance can send invoices",
			);
		const inv = await fetchInvoice(req.id);
		if (!["draft", "sent"].includes(inv.status))
			throw APIError.failedPrecondition("only draft invoices can be sent");

		const issue =
			req.issue_date ?? inv.issue_date ?? new Date().toISOString().slice(0, 10);
		const due =
			req.due_date ?? inv.due_date ?? addDays(issue, req.due_in_days ?? 30);

		await db.exec`
      UPDATE invoices SET
        status = 'sent', issue_date = ${issue}, due_date = ${due},
        sent_by = ${userID}, sent_at = now(), updated_at = now()
      WHERE id = ${req.id}
    `;

		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));
		await logEvent(req.id, "sent", userID, contact.name ?? null);

		const updated = await fetchInvoice(req.id);
		await notifyRoles(
			["finance"],
			`Invoice ${updated.reference} issued — ${updated.customer_name}`,
			emailShell(
				"Invoice Issued",
				invoiceRows(updated),
				"This invoice has been sent to the customer and is awaiting payment.",
			),
		);
		return updated;
	},
);

// ─── Record payment ───────────────────────────────────────────────────────────

interface PayInvoiceRequest {
	id: string;
	paid_amount?: number; // defaults to total_amount (full payment)
	payment_reference?: string;
	paid_date?: string;
}

export const payInvoice = api(
	{ expose: true, auth: true, method: "POST", path: "/invoices/:id/pay" },
	async (req: PayInvoiceRequest): Promise<Invoice> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role) && !isManager(role))
			throw APIError.permissionDenied("only finance can record payments");
		const inv = await fetchInvoice(req.id);
		if (["paid", "cancelled"].includes(inv.status))
			throw APIError.failedPrecondition("invoice is already closed");

		const already = Number(inv.paid_amount ?? 0);
		const increment =
			req.paid_amount != null
				? round2(Number(req.paid_amount))
				: round2(inv.total_amount - already);
		if (increment <= 0)
			throw APIError.invalidArgument("paid amount must be positive");

		const newPaid = round2(already + increment);
		const status: InvoiceStatus =
			newPaid >= Number(inv.total_amount) ? "paid" : "partially_paid";
		const paidDate = req.paid_date ?? new Date().toISOString().slice(0, 10);

		await db.exec`
      UPDATE invoices SET
        status = ${status}, paid_amount = ${newPaid},
        payment_reference = ${req.payment_reference ?? inv.payment_reference},
        paid_date = ${paidDate},
        issue_date = COALESCE(issue_date, ${paidDate}),
        updated_at = now()
      WHERE id = ${req.id}
    `;

		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));
		await logEvent(
			req.id,
			status === "paid" ? "paid" : "partial_payment",
			userID,
			contact.name ?? null,
			`Received ${SAR(increment)} (total paid ${SAR(newPaid)})`,
		);

		// ── Auto journal entry: Dr 11100 Cash / Cr 41100 Revenue ──────────────
		void financial
			.recordAutoEntry({
				fiscal_period: paidDate.slice(0, 7),
				reference_source: inv.reference,
				description: `Invoice payment — ${inv.reference} — ${inv.customer_name}`,
				debit_account: "11100", // Corporate Operating Account (cash in)
				credit_account: "41100", // Bank Tier-1 Placement Fees (revenue)
				amount: increment,
				actor_id: userID,
				actor_name: contact.name ?? null,
			})
			.catch((e) =>
				log.warn("auto financial entry failed for invoice", {
					id: req.id,
					error: String(e),
				}),
			);

		return fetchInvoice(req.id);
	},
);

// ─── Cancel ───────────────────────────────────────────────────────────────────

interface CancelInvoiceRequest {
	id: string;
	reason?: string;
}

export const cancelInvoice = api(
	{ expose: true, auth: true, method: "POST", path: "/invoices/:id/cancel" },
	async (req: CancelInvoiceRequest): Promise<Invoice> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied(
				"only managers or finance can cancel invoices",
			);
		const inv = await fetchInvoice(req.id);
		if (inv.status === "paid")
			throw APIError.failedPrecondition("paid invoices cannot be cancelled");

		await db.exec`
      UPDATE invoices SET
        status = 'cancelled', cancelled_by = ${userID}, cancelled_at = now(),
        notes = COALESCE(${req.reason ?? null}, notes), updated_at = now()
      WHERE id = ${req.id}
    `;

		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));
		await logEvent(
			req.id,
			"cancelled",
			userID,
			contact.name ?? null,
			req.reason,
		);
		return fetchInvoice(req.id);
	},
);

// ─── Events ───────────────────────────────────────────────────────────────────

interface InvoiceEvent {
	id: string;
	invoice_id: string;
	action: string;
	actor_id: string | null;
	actor_name: string | null;
	note: string | null;
	created_at: string;
}

export const listInvoiceEvents = api(
	{ expose: true, auth: true, method: "GET", path: "/invoices/:id/events" },
	async ({ id }: { id: string }): Promise<{ events: InvoiceEvent[] }> => {
		await fetchInvoice(id);
		const events: InvoiceEvent[] = [];
		const rows = db.query<InvoiceEvent>`
      SELECT id, invoice_id, action, actor_id, actor_name, note, created_at
      FROM invoice_events WHERE invoice_id = ${id} ORDER BY created_at ASC
    `;
		for await (const row of rows) events.push(row);
		return { events };
	},
);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface InvoiceStats {
	total_count: number;
	total_amount: number;
	paid_count: number;
	paid_amount: number;
	outstanding_count: number; // sent / partially_paid, not fully paid
	outstanding_amount: number; // total_amount - paid_amount for open invoices
	overdue_count: number; // outstanding & past due_date
	overdue_amount: number;
	avg_days_to_clear: number; // avg(paid_date - issue_date) for paid
}

export const invoiceStats = api(
	{ expose: true, auth: true, method: "GET", path: "/invoices-stats" },
	async (): Promise<InvoiceStats> => {
		const row = await db.queryRow<{
			total_count: number;
			total_amount: number;
			paid_count: number;
			paid_amount: number;
			outstanding_count: number;
			outstanding_amount: number;
			overdue_count: number;
			overdue_amount: number;
			avg_days_to_clear: number | null;
		}>`
      SELECT
        COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS total_count,
        COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS total_amount,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
        COALESCE(SUM(COALESCE(paid_amount, total_amount)) FILTER (WHERE status = 'paid'), 0) AS paid_amount,
        COUNT(*) FILTER (WHERE status IN ('sent', 'partially_paid'))::int AS outstanding_count,
        COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)) FILTER (WHERE status IN ('sent', 'partially_paid')), 0) AS outstanding_amount,
        COUNT(*) FILTER (WHERE status IN ('sent', 'partially_paid') AND due_date IS NOT NULL AND due_date < CURRENT_DATE)::int AS overdue_count,
        COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)) FILTER (WHERE status IN ('sent', 'partially_paid') AND due_date IS NOT NULL AND due_date < CURRENT_DATE), 0) AS overdue_amount,
        AVG(paid_date - issue_date) FILTER (WHERE status = 'paid' AND paid_date IS NOT NULL AND issue_date IS NOT NULL) AS avg_days_to_clear
      FROM invoices
    `;
		return {
			total_count: row?.total_count ?? 0,
			total_amount: Number(row?.total_amount ?? 0),
			paid_count: row?.paid_count ?? 0,
			paid_amount: Number(row?.paid_amount ?? 0),
			outstanding_count: row?.outstanding_count ?? 0,
			outstanding_amount: Number(row?.outstanding_amount ?? 0),
			overdue_count: row?.overdue_count ?? 0,
			overdue_amount: Number(row?.overdue_amount ?? 0),
			avg_days_to_clear: Math.round(Number(row?.avg_days_to_clear ?? 0)),
		};
	},
);

// ─── Reconcile paid invoices to the financial ledger ──────────────────────────

interface ReconcileResult {
	checked: number;
	posted: number;
	amount_posted: number;
}

/**
 * Backfill missing revenue journal entries for invoices that are paid or
 * partially paid but under-posted in the ledger (e.g. paid before auto-posting
 * existed, or a transient posting failure). Idempotent: it only posts the
 * difference between the amount actually paid and what is already on the
 * ledger for that invoice reference, so repeated runs are safe.
 */
export const reconcileInvoicesToLedger = api(
	{ expose: true, auth: true, method: "POST", path: "/invoices/reconcile-ledger" },
	async (): Promise<ReconcileResult> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role) && !isManager(role))
			throw APIError.permissionDenied("finance or admin only");
		const contact = await user
			.getContact({ id: userID })
			.catch(() => ({ name: null as string | null }));

		const rows = db.rawQuery<{
			reference: string;
			customer_name: string | null;
			paid_amount: string | null;
			paid_date: string | null;
		}>(
			`SELECT reference, customer_name, paid_amount::TEXT AS paid_amount, paid_date::TEXT AS paid_date
			 FROM invoices WHERE status IN ('paid','partially_paid')`,
		);

		let checked = 0;
		let posted = 0;
		let amountPosted = 0;
		for await (const inv of rows) {
			checked++;
			const paid = round2(Number(inv.paid_amount ?? 0));
			if (paid <= 0) continue;
			const { credit } = await financial.postedAmountForSource({
				source_ref: inv.reference,
			});
			const diff = round2(paid - Number(credit));
			if (diff <= 0.005) continue;
			const period = (inv.paid_date ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
			try {
				await financial.recordAutoEntry({
					fiscal_period: period,
					reference_source: inv.reference,
					description: `Invoice payment (reconciled) — ${inv.reference} — ${inv.customer_name ?? ""}`,
					debit_account: "11100",
					credit_account: "41100",
					amount: diff,
					actor_id: userID,
					actor_name: contact.name ?? null,
				});
				posted++;
				amountPosted = round2(amountPosted + diff);
			} catch (err) {
				log.warn("invoice reconcile posting failed", {
					reference: inv.reference,
					error: String(err),
				});
			}
		}
		return { checked, posted, amount_posted: amountPosted };
	},
);
