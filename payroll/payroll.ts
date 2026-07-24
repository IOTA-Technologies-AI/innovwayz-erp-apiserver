import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { CronJob } from "encore.dev/cron";
import { user, billing, financial, request } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";
import { canAccessModule, MODULE_ROUTES } from "../authz/capabilities";

const db = new SQLDatabase("payroll", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

type SalaryStatus =
	| "draft"
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
	// Per-period payslip breakdown. `deductions` above stays authoritative for
	// approvals/ledger and is kept in sync as the sum of the itemized figures
	// (salary_advance + employee_requests_deduction + loss-of-pay + remote-work).
	attendance_days: number | null;
	government_holidays: number;
	annual_leaves: number;
	sick_leaves: number;
	loss_of_pay_days: number;
	days_payable: number;
	pay_date: string | null;
	remote_work_half: boolean;
	salary_advance: number;
	employee_requests_deduction: number;
	currency: string;
	notes: string | null;
	payment_method: string | null;
	salary_account: string;
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
	posted_by: string | null;
	posted_at: string | null;
	/** When the payslip PDF was emailed to the employee (null = not yet sent). */
	payslip_sent_at: string | null;
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

/**
 * Salary view/create/edit capability: a manager/finance role, OR a user granted
 * the Salaries module route. The approval chain (approve/reject), finance
 * processing (process/pay/batch/reconcile) and delete keep their own role checks
 * for separation of duties.
 */
function canManageSalaries(): boolean {
	const auth = getAuthData()!;
	return (
		isManager(auth.role) ||
		isFinance(auth.role) ||
		canAccessModule(auth, MODULE_ROUTES.salaries)
	);
}

// ─── Ledger posting (Corp Finance) ────────────────────────────────────────────
// Paid salaries post cash-basis: Dr <salary_account> / Cr 11100 Cash. Placed
// resources (assigned to a client) are a direct delivery cost — 51100 (COGS);
// internal/management staff are OPEX — 52100. One cumulative entry per account
// per pay batch, never per employee.
const SALARY_CASH_ACCOUNT = "11100";
const PLACED_SALARY_ACCOUNT = "51100"; // Contracted Resource Monthly Payroll
const INTERNAL_SALARY_ACCOUNT = "52100"; // Executive Staff Salaries

/** A placed resource (has a client) → COGS 51100; otherwise OPEX 52100. */
function salaryAccountFor(customerId: string | null | undefined): string {
	return customerId ? PLACED_SALARY_ACCOUNT : INTERNAL_SALARY_ACCOUNT;
}

const SALARY_COLUMNS = `
  id, reference, employee_id, employee_name, position, customer_id, customer_name,
  period_month, period_year, base_amount, additions, deductions, net_amount,
  attendance_days, government_holidays, annual_leaves, sick_leaves,
  loss_of_pay_days, days_payable, pay_date::TEXT AS pay_date, remote_work_half,
  salary_advance, employee_requests_deduction,
  currency, notes, payment_method, salary_account, status,
  created_by, created_by_name,
  manager_approved_by, manager_approved_at, admin_approved_by, admin_approved_at,
  rejected_by, rejected_at, rejection_reason,
  processed_by, processed_at, payment_reference, paid_amount, paid_at,
  posted_by, posted_at, payslip_sent_at,
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

/**
 * Email the employee their payslip PDF once a salary is marked paid. Best-effort
 * and idempotent: skips if already sent (`payslip_sent_at`) or the employee has
 * no email on file, and any failure is logged — it never blocks the payment.
 */
async function sendPayslipEmail(s: SalaryPayment): Promise<void> {
	if (s.payslip_sent_at || !s.employee_id) return;
	try {
		const slip = await request.generateEmployeePayslip({
			employee_id: s.employee_id,
			period_month: s.period_month,
			period_year: s.period_year,
		});
		if (!slip.employee_email) {
			log.warn("payslip email skipped: employee has no email on file", {
				salary_id: s.id,
				employee_id: s.employee_id,
			});
			return;
		}
		const { ok } = await user.sendNotification({
			to: slip.employee_email,
			subject: `Your payslip — ${monthLabel(s.period_month, s.period_year)}`,
			html: emailShell(
				"Your Payslip",
				salaryRows(s),
				"Your salary has been paid. Your payslip for this period is attached to this email.",
			),
			attachments: [{ filename: slip.file_name, content: slip.data_base64 }],
		});
		if (ok) {
			await db.exec`UPDATE salary_payments SET payslip_sent_at = NOW() WHERE id = ${s.id}`;
		}
	} catch (err) {
		log.error("failed to email payslip", {
			salary_id: s.id,
			error: String(err),
		});
	}
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

/** Per-period itemized deduction inputs printed on the payslip. */
interface PayslipDeductionInput {
	salary_advance?: number;
	employee_requests_deduction?: number;
	loss_of_pay_days?: number;
	remote_work_half?: boolean;
}

/**
 * Total deductions derived from the itemized payslip fields:
 * salary advance + employee-requests recovery + loss-of-pay amount
 * (days × daily rate, KSA daily rate = gross / 30) + remote-work-50%
 * (half the gross when the arrangement is applied). Returns null when no
 * itemized field is supplied, so callers can keep the caller-supplied total.
 */
function deriveDeductions(
	base: number,
	d: PayslipDeductionInput,
): number | null {
	const supplied =
		d.salary_advance !== undefined ||
		d.employee_requests_deduction !== undefined ||
		d.loss_of_pay_days !== undefined ||
		d.remote_work_half !== undefined;
	if (!supplied) return null;
	const advance = d.salary_advance ?? 0;
	const empReq = d.employee_requests_deduction ?? 0;
	const lopDays = d.loss_of_pay_days ?? 0;
	const lopAmount = (base / 30) * lopDays;
	const remote = d.remote_work_half ? base * 0.5 : 0;
	return round2(advance + empReq + lopAmount + remote);
}

interface ResolvedDeductions {
	deductions: number;
	salaryAdvance: number;
	empReqDeduction: number;
	lossOfPayDays: number;
	remoteWorkHalf: boolean;
}

/**
 * Merge itemized deduction fields for an update (req overrides current). When
 * the record carries any itemized deduction — or the caller touched one — the
 * `deductions` total is recomputed from them; otherwise the caller-supplied
 * lump (or the current total) is honored.
 */
function resolveUpdatedDeductions(
	base: number,
	req: {
		deductions?: number;
		salary_advance?: number;
		employee_requests_deduction?: number;
		loss_of_pay_days?: number;
		remote_work_half?: boolean;
	},
	current: SalaryPayment,
): ResolvedDeductions {
	const salaryAdvance = req.salary_advance ?? Number(current.salary_advance);
	const empReqDeduction =
		req.employee_requests_deduction ??
		Number(current.employee_requests_deduction);
	const lossOfPayDays = req.loss_of_pay_days ?? Number(current.loss_of_pay_days);
	const remoteWorkHalf = req.remote_work_half ?? current.remote_work_half;
	const itemizedTouched =
		req.salary_advance !== undefined ||
		req.employee_requests_deduction !== undefined ||
		req.loss_of_pay_days !== undefined ||
		req.remote_work_half !== undefined;
	const hasItemized =
		itemizedTouched ||
		salaryAdvance > 0 ||
		empReqDeduction > 0 ||
		lossOfPayDays > 0 ||
		remoteWorkHalf;
	const deductions = hasItemized
		? (deriveDeductions(base, {
				salary_advance: salaryAdvance,
				employee_requests_deduction: empReqDeduction,
				loss_of_pay_days: lossOfPayDays,
				remote_work_half: remoteWorkHalf,
			}) ?? Number(current.deductions))
		: (req.deductions ?? Number(current.deductions));
	return {
		deductions,
		salaryAdvance,
		empReqDeduction,
		lossOfPayDays,
		remoteWorkHalf,
	};
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const periodKey = (m: number, y: number) => `${y}-${String(m).padStart(2, "0")}`;
const newBatchRef = () => `SALPAY-${crypto.randomUUID()}`;

/** Mark one salary row paid and stamp its ledger batch reference. */
async function markSalaryPaidRow(
	salaryId: string,
	paidAmount: number,
	paymentRef: string | null,
	batchRef: string,
	userID: string,
	actorName: string | null,
): Promise<void> {
	await db.exec`
    UPDATE salary_payments SET
      status = 'paid', processed_by = ${userID}, processed_at = NOW(), paid_at = NOW(),
      payment_reference = ${paymentRef}, paid_amount = ${paidAmount},
      pay_batch_ref = ${batchRef}, updated_at = NOW()
    WHERE id = ${salaryId}
  `;
	await logEvent(salaryId, "paid", userID, actorName, paymentRef ?? undefined);
}

interface PaidRow {
	salary_account: string;
	paid: number;
	period_month: number;
	period_year: number;
}

/**
 * Post the cumulative salary ledger entry(ies) for a batch of just-paid rows:
 * one Dr <salary_account> / Cr 11100 Cash entry per distinct account, summing
 * the paid amounts — never per employee. Best-effort per account; a posting
 * failure is logged and the reconcile endpoint can backfill it later.
 */
async function postSalaryBatch(
	rows: PaidRow[],
	batchRef: string,
	userID: string,
	actorName: string | null,
): Promise<{ posted: number; amount: number }> {
	const byAccount = new Map<
		string,
		{ total: number; count: number; periods: Set<string> }
	>();
	for (const r of rows) {
		const g = byAccount.get(r.salary_account) ?? {
			total: 0,
			count: 0,
			periods: new Set<string>(),
		};
		g.total = round2(g.total + Number(r.paid));
		g.count++;
		g.periods.add(periodKey(r.period_month, r.period_year));
		byAccount.set(r.salary_account, g);
	}

	let posted = 0;
	let amount = 0;
	for (const [account, g] of byAccount) {
		if (g.total <= 0) continue;
		const periods = [...g.periods].sort((a, b) => a.localeCompare(b));
		const fiscalPeriod =
			periods.length === 1 ? periods[0] : new Date().toISOString().slice(0, 7);
		try {
			await financial.recordAutoEntry({
				fiscal_period: fiscalPeriod,
				reference_source: `${batchRef}:${account}`,
				description: `Salary paid — ${periods.join(", ")} — ${g.count} employee${g.count === 1 ? "" : "s"}`,
				debit_account: account,
				credit_account: SALARY_CASH_ACCOUNT,
				amount: g.total,
				actor_id: userID,
				actor_name: actorName,
			});
			posted++;
			amount = round2(amount + g.total);
		} catch (err) {
			log.warn("salary batch ledger posting failed", {
				batchRef,
				account,
				error: String(err),
			});
		}
	}
	return { posted, amount };
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
	// Per-period payslip fields
	attendance_days?: number;
	government_holidays?: number;
	annual_leaves?: number;
	sick_leaves?: number;
	loss_of_pay_days?: number;
	days_payable?: number;
	pay_date?: string;
	remote_work_half?: boolean;
	salary_advance?: number;
	employee_requests_deduction?: number;
}

export const createSalaryPayment = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll" },
	async (req: CreateSalaryRequest): Promise<SalaryPayment> => {
		const { userID } = getAuthData()!;
		if (!canManageSalaries())
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
		// Itemized payslip deductions, when supplied, become the authoritative
		// `deductions` total; otherwise fall back to the caller-supplied lump.
		const itemized = deriveDeductions(req.base_amount, req);
		const deductions = itemized ?? req.deductions ?? 0;
		const net = computeNet(req.base_amount, additions, deductions);
		const account = salaryAccountFor(req.customer_id);

		const creatorName = await actorNameOf(userID);
		const id = crypto.randomUUID();
		const reference = await nextReference();

		try {
			await db.exec`
        INSERT INTO salary_payments (
          id, reference, employee_id, employee_name, position, customer_id, customer_name,
          period_month, period_year, base_amount, additions, deductions, net_amount,
          attendance_days, government_holidays, annual_leaves, sick_leaves,
          loss_of_pay_days, days_payable, pay_date, remote_work_half,
          salary_advance, employee_requests_deduction,
          currency, notes, payment_method, salary_account, status, created_by, created_by_name
        ) VALUES (
          ${id}, ${reference}, ${req.employee_id}, ${req.employee_name}, ${req.position ?? null},
          ${req.customer_id ?? null}, ${req.customer_name ?? null},
          ${req.period_month}, ${req.period_year}, ${req.base_amount}, ${additions}, ${deductions}, ${net},
          ${req.attendance_days ?? null}, ${req.government_holidays ?? 0}, ${req.annual_leaves ?? 0}, ${req.sick_leaves ?? 0},
          ${req.loss_of_pay_days ?? 0}, ${req.days_payable ?? 30}, ${req.pay_date ?? null}, ${req.remote_work_half ?? false},
          ${req.salary_advance ?? 0}, ${req.employee_requests_deduction ?? 0},
          ${req.currency ?? "SAR"}, ${req.notes ?? null}, ${req.payment_method ?? null}, ${account},
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
	/** Optional subset of employees to include in this run (omit = all). */
	employee_ids?: string[];
}

interface GenerateMonthlyResponse {
	created: number;
	skipped: number;
	total_net: number;
}

/**
 * Core bulk-generation used by both the manual endpoint and the monthly
 * cron. Creates one draft salary payment per employee with a positive
 * monthly salary, skipping any that already exist for the period.
 */
async function generateForPeriod(
	periodMonth: number,
	periodYear: number,
	userID: string,
	creatorName: string | null,
	employeeIds?: string[],
): Promise<GenerateMonthlyResponse> {
	const { employees } = await billing.listEmployees();

	// Partial run: restrict to the selected employees when a list is provided.
	const selected = employeeIds && employeeIds.length > 0
		? new Set(employeeIds)
		: null;

	let created = 0;
	let skipped = 0;
	let totalNet = 0;

	for (const e of employees) {
		if (selected && !selected.has(e.id)) continue;
		const base = Number(e.monthly_salary) || 0;
		if (base <= 0) {
			skipped++;
			continue;
		}
		const id = crypto.randomUUID();
		const reference = await nextReference();
		const net = computeNet(base, 0, 0);
		const account = salaryAccountFor(e.customer_id);
		const res = await db.rawQueryRow<{ id: string }>(
			`INSERT INTO salary_payments (
        id, reference, employee_id, employee_name, position, customer_id, customer_name,
        period_month, period_year, base_amount, additions, deductions, net_amount,
        currency, salary_account, status, created_by, created_by_name
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, $11, 'SAR', $12, 'draft', $13, $14
      )
      ON CONFLICT (employee_id, period_month, period_year) DO NOTHING
      RETURNING id`,
			id, reference, e.id, e.name, e.position ?? null,
			e.customer_id ?? null, e.customer_name ?? null,
			periodMonth, periodYear, base, net, account, userID, creatorName,
		);
		if (res) {
			created++;
			totalNet += net;
			await logEvent(id, "generated", userID, creatorName);
		} else {
			skipped++;
		}
	}

	if (created > 0) {
		void notifyRoles(
			["admin", "super_admin", "manager"],
			`Payroll generated for ${monthLabel(periodMonth, periodYear)} — ${created} salaries`,
			emailShell(
				"Monthly Payroll Generated",
				`<tr><td style="padding:6px 0;color:#94a3b8;width:170px;">Period</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${monthLabel(periodMonth, periodYear)}</td></tr>
         <tr><td style="padding:6px 0;color:#94a3b8;">Salaries created</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${created}</td></tr>
        <tr><td style="padding:6px 0;color:#94a3b8;">Total net</td><td style="padding:6px 0;color:#0f172a;font-weight:700;">${SAR(totalNet)}</td></tr>`,
				"These salary payments are drafts — review, adjust accruals/deductions, and submit for admin approval.",
			),
		);
	}

	return {
		created,
		skipped,
		total_net: Math.round(totalNet * 100) / 100,
	};
}

export const generateMonthlyPayroll = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/generate" },
	async (req: GenerateMonthlyRequest): Promise<GenerateMonthlyResponse> => {
		const { userID } = getAuthData()!;
		if (!canManageSalaries())
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
		return generateForPeriod(
			req.period_month,
			req.period_year,
			userID,
			creatorName,
			req.employee_ids,
		);
	},
);

// ─── Auto-generate on the 25th of each month ──────────────────────────────────

/**
 * Cron target: generate the current month's payroll automatically so it is
 * ready for admin review/approval by month-end. Runs unauthenticated as the
 * system actor; drafts still require the normal approve → finance flow.
 */
export const autoGenerateMonthlyPayroll = api(
	{ expose: false, method: "POST", path: "/payroll/auto-generate" },
	async (): Promise<GenerateMonthlyResponse> => {
		const now = new Date();
		const month = now.getMonth() + 1;
		const year = now.getFullYear();
		const result = await generateForPeriod(month, year, "system", "Automated Payroll");
		log.info("auto payroll generated", { month, year, created: result.created, skipped: result.skipped });
		return result;
	},
);

const _payrollCron = new CronJob("monthly-payroll-generate", {
	title: "Generate monthly payroll on the 25th",
	schedule: "0 6 25 * *",
	endpoint: autoGenerateMonthlyPayroll,
});


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

		// BDMs see ONLY the salaries of employees tagged to them.
		if (role === "bdm") {
			const { employee_ids } = await billing.getBdmEmployeeIds({
				bdm_user_id: userID,
			});
			if (employee_ids.length === 0) return { salaries: [] };
			const ph = employee_ids.map((id) => {
				args.push(id);
				return `$${args.length}`;
			});
			clauses.push(`employee_id IN (${ph.join(", ")})`);
		} else if (!canManageSalaries() || p.mine) {
			// Managers/finance and users granted the Salaries module see everyone;
			// others see nothing unless it's theirs.
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
		const { userID } = getAuthData()!;
		const s = await fetchSalary(id);
		if (!canManageSalaries() && s.created_by !== userID)
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
	salary_account?: string;
	/** Required when the payable amount changes — captured in the audit trail. */
	reason?: string;
	// Per-period payslip fields
	attendance_days?: number | null;
	government_holidays?: number;
	annual_leaves?: number;
	sick_leaves?: number;
	loss_of_pay_days?: number;
	days_payable?: number;
	pay_date?: string | null;
	remote_work_half?: boolean;
	salary_advance?: number;
	employee_requests_deduction?: number;
}

export const updateSalaryPayment = api(
	{ expose: true, auth: true, method: "PUT", path: "/payroll/:id" },
	async ({ id, ...req }: UpdateSalaryRequest): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		const current = await fetchSalary(id);

		const creatorEditable =
			current.created_by === userID &&
			["draft", "pending_manager"].includes(current.status);
		const managerEditable =
			(isManager(role) || canManageSalaries()) &&
			["draft", "pending_manager", "pending_admin"].includes(current.status);
		if (!creatorEditable && !managerEditable)
			throw APIError.permissionDenied(
				"not allowed to edit this salary payment",
			);

		const base = req.base_amount ?? Number(current.base_amount);
		const additions = req.additions ?? Number(current.additions);
		const {
			deductions,
			salaryAdvance,
			empReqDeduction,
			lossOfPayDays,
			remoteWorkHalf,
		} = resolveUpdatedDeductions(base, req, current);
		const net = computeNet(base, additions, deductions);
		const prevNet = Number(current.net_amount);

		// A change to the payable amount must carry a reason (audit requirement).
		const amountChanged =
			base !== Number(current.base_amount) ||
			additions !== Number(current.additions) ||
			deductions !== Number(current.deductions);
		if (amountChanged && !req.reason?.trim())
			throw APIError.invalidArgument(
				"a reason is required when changing the payable salary",
			);

		let account = current.salary_account;
		if (req.salary_account !== undefined) {
			if (
				![PLACED_SALARY_ACCOUNT, INTERNAL_SALARY_ACCOUNT].includes(
					req.salary_account,
				)
			)
				throw APIError.invalidArgument(
					`salary_account must be ${PLACED_SALARY_ACCOUNT} or ${INTERNAL_SALARY_ACCOUNT}`,
				);
			account = req.salary_account;
		}

		await db.exec`
      UPDATE salary_payments SET
        base_amount    = ${base},
        additions      = ${additions},
        deductions     = ${deductions},
        net_amount     = ${net},
        attendance_days     = ${req.attendance_days !== undefined ? req.attendance_days : current.attendance_days},
        government_holidays = ${req.government_holidays ?? current.government_holidays},
        annual_leaves       = ${req.annual_leaves ?? current.annual_leaves},
        sick_leaves         = ${req.sick_leaves ?? current.sick_leaves},
        loss_of_pay_days    = ${lossOfPayDays},
        days_payable        = ${req.days_payable ?? current.days_payable},
        pay_date            = ${req.pay_date !== undefined ? req.pay_date : current.pay_date},
        remote_work_half    = ${remoteWorkHalf},
        salary_advance      = ${salaryAdvance},
        employee_requests_deduction = ${empReqDeduction},
        notes          = ${req.notes !== undefined ? req.notes : current.notes},
        payment_method = ${req.payment_method !== undefined ? req.payment_method : current.payment_method},
        salary_account = ${account},
        updated_at     = NOW()
      WHERE id = ${id}
    `;
		if (amountChanged) {
			await logEvent(
				id,
				"amount_amended",
				userID,
				current.created_by_name,
				`${SAR(prevNet)} → ${SAR(net)} — ${req.reason!.trim()}`,
			);
		} else {
			await logEvent(id, "updated", userID, current.created_by_name);
		}
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

// ─── Post (submit a draft for approval) ───────────────────────────────────────

export const postSalaryPayment = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/:id/post" },
	async ({ id }: { id: string }): Promise<SalaryPayment> => {
		const { userID } = getAuthData()!;
		const s = await fetchSalary(id);
		if (s.status !== "draft")
			throw APIError.failedPrecondition("only draft salaries can be posted");
		if (s.created_by !== userID && !canManageSalaries())
			throw APIError.permissionDenied(
				"not allowed to post this salary payment",
			);

		const actorName = await actorNameOf(userID);
		await db.exec`
      UPDATE salary_payments SET
        status = 'pending_manager', posted_by = ${userID}, posted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
		await logEvent(id, "submitted", userID, actorName);
		const updated = await fetchSalary(id);
		void notifyRoles(
			["manager", "admin", "super_admin"],
			`Salary submitted for approval — ${updated.reference}`,
			emailShell(
				"Salary Submitted for Approval",
				salaryRows(updated),
				"Please review this salary payment in the InnovWayz ERP portal.",
			),
		);
		return updated;
	},
);

// ─── Bulk post (multi-select submit drafts for approval) ──────────────────────

interface PostBatchRequest {
	ids: string[];
}
interface PostBatchResponse {
	posted: number;
	skipped: number;
}

export const postBatch = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/post-batch" },
	async (req: PostBatchRequest): Promise<PostBatchResponse> => {
		const { userID } = getAuthData()!;
		if (!Array.isArray(req.ids) || req.ids.length === 0)
			throw APIError.invalidArgument("select at least one salary to submit");
		const actorName = await actorNameOf(userID);
		const canManage = canManageSalaries();

		let posted = 0;
		let skipped = 0;
		const postedRefs: string[] = [];
		for (const id of req.ids) {
			const s = await db.rawQueryRow<SalaryPayment>(
				`SELECT ${SALARY_COLUMNS} FROM salary_payments WHERE id = $1`,
				id,
			);
			// Only the creator or a salaries-manager may submit, and only drafts.
			if (!s || s.status !== "draft" || (s.created_by !== userID && !canManage)) {
				skipped++;
				continue;
			}
			await db.exec`
        UPDATE salary_payments SET
          status = 'pending_manager', posted_by = ${userID}, posted_at = NOW(), updated_at = NOW()
        WHERE id = ${id}
      `;
			await logEvent(id, "submitted", userID, actorName);
			postedRefs.push(s.reference);
			posted++;
		}

		// One summary notification for the whole batch (not one per row).
		if (posted > 0) {
			void notifyRoles(
				["manager", "admin", "super_admin"],
				`${posted} salaries submitted for approval`,
				emailShell(
					"Salaries Submitted for Approval",
					`<tr><td style="padding:6px 0;color:#94a3b8;width:170px;">Submitted</td><td style="padding:6px 0;color:#0f172a;font-weight:700;">${posted}</td></tr>` +
						`<tr><td style="padding:6px 0;color:#94a3b8;">References</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${postedRefs.slice(0, 25).join(", ")}${postedRefs.length > 25 ? " …" : ""}</td></tr>`,
					"Please review these salary payments in the InnovWayz ERP portal.",
				),
			);
		}
		return { posted, skipped };
	},
);

// ─── Approvals ────────────────────────────────────────────────────────────────

export const approveSalaryPayment = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/:id/approve" },
	async ({
		id,
		base_amount,
		additions,
		deductions,
		reason,
	}: {
		id: string;
		base_amount?: number;
		additions?: number;
		deductions?: number;
		reason?: string;
	}): Promise<SalaryPayment> => {
		const { userID, role } = getAuthData()!;
		let s = await fetchSalary(id);
		const actorName = await actorNameOf(userID);

		// Approver may amend the figures (up or down) before signing off.
		if (
			base_amount !== undefined ||
			additions !== undefined ||
			deductions !== undefined
		) {
			const base = base_amount ?? Number(s.base_amount);
			const add = additions ?? Number(s.additions);
			const ded = deductions ?? Number(s.deductions);
			if (base < 0 || add < 0 || ded < 0)
				throw APIError.invalidArgument("amounts must be positive");
			const net = computeNet(base, add, ded);
			if (net !== Number(s.net_amount)) {
				if (!reason?.trim())
					throw APIError.invalidArgument(
						"a reason is required when amending the payable salary",
					);
				const prev = Number(s.net_amount);
				await db.exec`
          UPDATE salary_payments SET
            base_amount = ${base}, additions = ${add}, deductions = ${ded},
            net_amount = ${net}, updated_at = NOW()
          WHERE id = ${id}
        `;
				await logEvent(
					id,
					"amount_amended",
					userID,
					actorName,
					`${SAR(prev)} → ${SAR(net)} — ${reason.trim()}`,
				);
				s = await fetchSalary(id);
			}
		}

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
			// Mark paid and post the cumulative salary entry (a batch of one).
			const batchRef = newBatchRef();
			await markSalaryPaidRow(
				id,
				paid,
				payment_reference ?? null,
				batchRef,
				userID,
				actorName,
			);
			await postSalaryBatch(
				[
					{
						salary_account: s.salary_account,
						paid,
						period_month: s.period_month,
						period_year: s.period_year,
					},
				],
				batchRef,
				userID,
				actorName,
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
			// Email the employee their payslip PDF (best-effort, never blocks).
			void sendPayslipEmail(updated);
			return updated;
		}

		throw APIError.invalidArgument("action must be 'start' or 'pay'");
	},
);

// ─── Bulk mark paid (multi-select) + cumulative ledger posting ────────────────

interface PayBatchRequest {
	ids: string[];
	payment_reference?: string;
}
interface PayBatchResponse {
	paid: number;
	skipped: number;
	posted: number;
	amount: number;
}

export const payBatch = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/pay-batch" },
	async (req: PayBatchRequest): Promise<PayBatchResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role))
			throw APIError.permissionDenied("only finance can process salaries");
		if (!Array.isArray(req.ids) || req.ids.length === 0)
			throw APIError.invalidArgument("select at least one salary to pay");
		const actorName = await actorNameOf(userID);
		const batchRef = newBatchRef();

		let paidCount = 0;
		let skipped = 0;
		const paidRows: PaidRow[] = [];
		for (const id of req.ids) {
			const s = await db.rawQueryRow<SalaryPayment>(
				`SELECT ${SALARY_COLUMNS} FROM salary_payments WHERE id = $1`,
				id,
			);
			// Only approved (or in-progress) salaries can be paid.
			if (!s || !["approved", "processing"].includes(s.status)) {
				skipped++;
				continue;
			}
			const paid = Number(s.net_amount);
			await markSalaryPaidRow(
				id,
				paid,
				req.payment_reference ?? null,
				batchRef,
				userID,
				actorName,
			);
			paidRows.push({
				salary_account: s.salary_account,
				paid,
				period_month: s.period_month,
				period_year: s.period_year,
			});
			// Email the employee their payslip PDF (best-effort, never blocks).
			void sendPayslipEmail(s);
			paidCount++;
		}

		// One cumulative Dr <account> / Cr 11100 entry per account in the batch.
		const { posted, amount } = await postSalaryBatch(
			paidRows,
			batchRef,
			userID,
			actorName,
		);
		return { paid: paidCount, skipped, posted, amount };
	},
);

// ─── Reconcile paid salaries to the ledger (backfill) ─────────────────────────

interface SalaryReconcileRequest {
	paid_since?: string; // YYYY-MM-DD, matched on paid_at
}
interface SalaryReconcileResponse {
	checked: number;
	posted: number;
	amount: number;
}

/**
 * Backfill cumulative ledger entries for paid salaries never posted
 * (`pay_batch_ref IS NULL`) — e.g. paid before ledger posting existed. Groups
 * by (period, salary_account) into synthetic per-period batches. Idempotent:
 * stamped rows are excluded, so repeated runs are safe.
 */
export const reconcileSalariesToLedger = api(
	{ expose: true, auth: true, method: "POST", path: "/payroll/reconcile-ledger" },
	async (req: SalaryReconcileRequest): Promise<SalaryReconcileResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role)) throw APIError.permissionDenied("finance only");
		const actorName = await actorNameOf(userID);

		const rows = db.rawQuery<{
			id: string;
			salary_account: string;
			paid_amount: string | null;
			net_amount: string;
			period_month: number;
			period_year: number;
		}>(
			`SELECT id, salary_account, paid_amount::TEXT AS paid_amount,
			        net_amount::TEXT AS net_amount, period_month, period_year
			 FROM salary_payments
			 WHERE status = 'paid' AND pay_batch_ref IS NULL
			   AND ($1::date IS NULL OR paid_at::date >= $1::date)`,
			req.paid_since ?? null,
		);

		const byPeriod = new Map<string, PaidRow[]>();
		let checked = 0;
		for await (const r of rows) {
			checked++;
			const key = periodKey(r.period_month, r.period_year);
			const batchRef = `SALRECON-${key}`;
			// Stamp first so a mid-run failure can never double-post on retry.
			await db.exec`UPDATE salary_payments SET pay_batch_ref = ${batchRef} WHERE id = ${r.id}`;
			const list = byPeriod.get(key) ?? [];
			list.push({
				salary_account: r.salary_account,
				paid: round2(Number(r.paid_amount ?? r.net_amount)),
				period_month: r.period_month,
				period_year: r.period_year,
			});
			byPeriod.set(key, list);
		}

		let posted = 0;
		let amount = 0;
		for (const [key, list] of byPeriod) {
			const res = await postSalaryBatch(
				list,
				`SALRECON-${key}`,
				userID,
				actorName,
			);
			posted += res.posted;
			amount = round2(amount + res.amount);
		}
		return { checked, posted, amount };
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
