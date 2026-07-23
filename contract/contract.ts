import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { CronJob } from "encore.dev/cron";
import { user } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("contract", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type ContractType =
	| "employment"
	| "service"
	| "freelance"
	| "internship"
	| "probation"
	| "renewal"
	| "other";

export type ContractStatus =
	| "draft"
	| "active"
	| "expired"
	| "terminated"
	| "renewed";

export interface Contract {
	id: string;
	reference: string;
	employee_id: string | null;
	employee_name: string;
	customer_id: string | null;
	customer_name: string | null;
	job_title: string | null;
	contract_type: ContractType;
	start_date: string;
	end_date: string | null;
	probation_end_date: string | null;
	salary_amount: number | null;
	salary_currency: string;
	notice_period_days: number;
	file_url: string | null;
	notes: string | null;
	status: ContractStatus;
	created_by: string;
	created_by_name: string | null;
	activated_by: string | null;
	activated_at: string | null;
	terminated_by: string | null;
	terminated_at: string | null;
	termination_reason: string | null;
	renewed_by: string | null;
	renewed_at: string | null;
	renewed_contract_id: string | null;
	// Client billing (drives monthly invoicing)
	po_number: string | null;
	monthly_billing_amount: number | null;
	vat_percent: number;
	// Enhanced fields
	renewal_cycle: "monthly" | "quarterly" | "yearly";
	contract_value: number | null;
	benefit_type: "single" | "family";
	gosi_amount: number;
	family_benefit_amount: number;
	single_benefit_amount: number;
	annual_ticket_amount: number;
	iqama_amount: number;
	sales_manager_id: string | null;
	sales_manager_name: string | null;
	created_at: string;
	updated_at: string;
}

export interface ContractEvent {
	id: string;
	contract_id: string;
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

const CONTRACT_COLS = `
	id, reference,
	employee_id, employee_name, customer_id, customer_name, job_title,
	contract_type,
	start_date::TEXT       AS start_date,
	end_date::TEXT         AS end_date,
	probation_end_date::TEXT AS probation_end_date,
	salary_amount::float8  AS salary_amount,
	salary_currency, notice_period_days,
	file_url, notes, status,
	created_by, created_by_name,
	activated_by, activated_at,
	terminated_by, terminated_at, termination_reason,
	renewed_by, renewed_at, renewed_contract_id,
	po_number,
	monthly_billing_amount::float8 AS monthly_billing_amount,
	vat_percent::float8            AS vat_percent,
	renewal_cycle, contract_value::float8 AS contract_value,
	benefit_type,
	gosi_amount::float8 AS gosi_amount,
	family_benefit_amount::float8 AS family_benefit_amount,
	single_benefit_amount::float8 AS single_benefit_amount,
	annual_ticket_amount::float8  AS annual_ticket_amount,
	iqama_amount::float8          AS iqama_amount,
	sales_manager_id, sales_manager_name,
	created_at, updated_at
`;

async function fetchContract(id: string): Promise<Contract> {
	const row = await db.rawQueryRow<Contract>(
		`SELECT ${CONTRACT_COLS} FROM contracts WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("contract not found");
	return row;
}

async function nextRef(year: number): Promise<string> {
	const r = await db.rawQueryRow<{ ref: string }>(
		`SELECT 'CT-' || $1::TEXT || '-' || LPAD(NEXTVAL('contract_ref_seq')::TEXT, 6, '0') AS ref`,
		year,
	);
	return r!.ref;
}

async function logEvent(
	contractId: string,
	action: string,
	actorId: string,
	note?: string,
): Promise<void> {
	await db.exec`
		INSERT INTO contract_events (id, contract_id, action, performed_by, note)
		VALUES (${crypto.randomUUID()}, ${contractId}, ${action}, ${actorId}, ${note ?? null})
	`;
}

// ─── Notifications ────────────────────────────────────────────────────────────

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

interface CreateContractInput {
	employee_id?: string;
	employee_name: string;
	customer_id?: string;
	customer_name?: string;
	job_title?: string;
	contract_type?: ContractType;
	start_date: string;
	end_date?: string;
	probation_end_date?: string;
	salary_amount?: number;
	salary_currency?: string;
	notice_period_days?: number;
	file_url?: string;
	notes?: string;
	// Client billing (drives monthly invoicing)
	po_number?: string;
	monthly_billing_amount?: number;
	vat_percent?: number;
	// Enhanced fields
	renewal_cycle?: "monthly" | "quarterly" | "yearly";
	contract_value?: number;
	benefit_type?: "single" | "family";
	gosi_amount?: number;
	family_benefit_amount?: number;
	single_benefit_amount?: number;
	annual_ticket_amount?: number;
	iqama_amount?: number;
	sales_manager_id?: string;
	sales_manager_name?: string;
}

export const createContract = api(
	{ expose: true, method: "POST", path: "/contracts", auth: true },
	async (input: CreateContractInput): Promise<{ contract: Contract }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

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
			INSERT INTO contracts (
				id, reference,
				employee_id, employee_name, customer_id, customer_name, job_title,
				contract_type, start_date, end_date, probation_end_date,
				salary_amount, salary_currency, notice_period_days,
				file_url, notes, status, created_by, created_by_name,
				po_number, monthly_billing_amount, vat_percent,
				renewal_cycle, contract_value, benefit_type,
				gosi_amount, family_benefit_amount, single_benefit_amount,
				annual_ticket_amount, iqama_amount,
				sales_manager_id, sales_manager_name
			) VALUES (
				${id}, ${ref},
				${input.employee_id ?? null}, ${input.employee_name},
				${input.customer_id ?? null}, ${input.customer_name ?? null},
				${input.job_title ?? null},
				${input.contract_type ?? "employment"},
				${input.start_date},
				${input.end_date ?? null},
				${input.probation_end_date ?? null},
				${input.salary_amount ?? null},
				${input.salary_currency ?? "SAR"},
				${input.notice_period_days ?? 30},
				${input.file_url ?? null}, ${input.notes ?? null},
				'draft', ${userID}, ${creatorName},
				${input.po_number ?? null},
				${input.monthly_billing_amount ?? null},
				${input.vat_percent ?? 15},
				${input.renewal_cycle ?? "yearly"},
				${input.contract_value ?? null},
				${input.benefit_type ?? "single"},
				${input.gosi_amount ?? 0},
				${input.family_benefit_amount ?? 0},
				${input.single_benefit_amount ?? 0},
				${input.annual_ticket_amount ?? 0},
				${input.iqama_amount ?? 0},
				${input.sales_manager_id ?? null},
				${input.sales_manager_name ?? null}
			)
		`;
		await logEvent(id, "created", userID);
		return { contract: await fetchContract(id) };
	},
);

// ─── List ─────────────────────────────────────────────────────────────────────

interface ListContractsInput {
	status?: ContractStatus;
	contract_type?: ContractType;
	employee_id?: string;
	employee_name?: string;
	expiring_within_days?: number; // e.g. 30 = contracts expiring in next 30 days
	limit?: number;
	offset?: number;
}

export const listContracts = api(
	{ expose: true, method: "GET", path: "/contracts", auth: true },
	async (
		input: ListContractsInput,
	): Promise<{ contracts: Contract[]; total: number }> => {
		getAuthData()!;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		if (input.status) add("status = $?", input.status);
		if (input.contract_type) add("contract_type = $?", input.contract_type);
		if (input.employee_id) add("employee_id = $?", input.employee_id);
		if (input.employee_name)
			add("UPPER(employee_name) LIKE UPPER($?)", `%${input.employee_name}%`);
		if (input.expiring_within_days) {
			add("end_date IS NOT NULL", null);
			add(
				"end_date <= (CURRENT_DATE + ($?::INT || ' days')::INTERVAL)::DATE",
				input.expiring_within_days,
			);
			add("end_date >= CURRENT_DATE", null);
		}

		// Fix: remove null clauses (for IS NOT NULL and >= CURRENT_DATE)
		const validClauses = clauses.filter((_, i) => {
			const clause = clauses[i];
			return (
				!clause.startsWith("end_date IS NOT NULL") &&
				!clause.startsWith("end_date >= CURRENT_DATE")
			);
		});

		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const countRow = await db.rawQueryRow<{ n: string }>(
			`SELECT COUNT(*)::TEXT AS n FROM contracts ${where}`,
			...args,
		);
		const total = parseInt(countRow?.n ?? "0", 10);

		const limit = Math.min(input.limit ?? 200, 500);
		const offset = input.offset ?? 0;
		const li = args.length + 1;
		const oi = args.length + 2;
		const pagedArgs = [...args, limit, offset];

		const rows = db.rawQuery<Contract>(
			`SELECT ${CONTRACT_COLS} FROM contracts ${where}
			 ORDER BY created_at DESC
			 LIMIT $${li} OFFSET $${oi}`,
			...pagedArgs,
		);
		const contracts: Contract[] = [];
		for await (const r of rows) contracts.push(r);
		return { contracts, total };
	},
);

// ─── Internal: active contracts for monthly invoicing ────────────────────────
// Consumed by the invoice service to generate one invoice per active contract
// per period. Only contracts with a positive monthly billing amount are billable.

export interface ActiveContractBilling {
	contract_id: string;
	employee_id: string | null;
	employee_name: string;
	customer_id: string | null;
	customer_name: string | null;
	po_number: string | null;
	monthly_billing_amount: number;
	vat_percent: number;
}

export const listActiveForBilling = api(
	{ expose: false, auth: false, method: "GET", path: "/internal/contracts/active-billing" },
	async (): Promise<{ contracts: ActiveContractBilling[] }> => {
		const rows = db.rawQuery<ActiveContractBilling>(
			`SELECT id AS contract_id, employee_id, employee_name,
			        customer_id, customer_name, po_number,
			        monthly_billing_amount::float8 AS monthly_billing_amount,
			        vat_percent::float8            AS vat_percent
			 FROM contracts
			 WHERE status = 'active'
			   AND monthly_billing_amount IS NOT NULL
			   AND monthly_billing_amount > 0`,
		);
		const contracts: ActiveContractBilling[] = [];
		for await (const r of rows) contracts.push(r);
		return { contracts };
	},
);

// ─── Get ──────────────────────────────────────────────────────────────────────

export const getContract = api(
	{ expose: true, method: "GET", path: "/contracts/:id", auth: true },
	async ({ id }: { id: string }): Promise<{ contract: Contract }> => {
		getAuthData()!;
		return { contract: await fetchContract(id) };
	},
);

// ─── Update ───────────────────────────────────────────────────────────────────

interface UpdateContractInput extends Partial<CreateContractInput> {
	id: string;
}

export const updateContract = api(
	{ expose: true, method: "PUT", path: "/contracts/:id", auth: true },
	async (input: UpdateContractInput): Promise<{ contract: Contract }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const c = await fetchContract(input.id);
		if (!["draft", "active"].includes(c.status))
			throw APIError.failedPrecondition(`cannot edit a ${c.status} contract`);

		await db.exec`
			UPDATE contracts SET
				employee_name       = COALESCE(${input.employee_name ?? null}, employee_name),
				customer_name       = COALESCE(${input.customer_name ?? null}, customer_name),
				job_title           = COALESCE(${input.job_title ?? null}, job_title),
				contract_type       = COALESCE(${input.contract_type ?? null}, contract_type),
				start_date          = COALESCE(${input.start_date ?? null}, start_date),
				end_date            = CASE WHEN ${input.end_date !== undefined} THEN ${input.end_date ?? null} ELSE end_date END,
				probation_end_date  = CASE WHEN ${input.probation_end_date !== undefined} THEN ${input.probation_end_date ?? null} ELSE probation_end_date END,
				salary_amount       = COALESCE(${input.salary_amount ?? null}, salary_amount),
				salary_currency     = COALESCE(${input.salary_currency ?? null}, salary_currency),
				notice_period_days  = COALESCE(${input.notice_period_days ?? null}, notice_period_days),
				file_url            = CASE WHEN ${input.file_url !== undefined} THEN ${input.file_url ?? null} ELSE file_url END,
				notes               = CASE WHEN ${input.notes !== undefined} THEN ${input.notes ?? null} ELSE notes END,
				po_number              = CASE WHEN ${input.po_number !== undefined} THEN ${input.po_number ?? null} ELSE po_number END,
				monthly_billing_amount = CASE WHEN ${input.monthly_billing_amount !== undefined} THEN ${input.monthly_billing_amount ?? null} ELSE monthly_billing_amount END,
				vat_percent            = COALESCE(${input.vat_percent ?? null}, vat_percent),
				renewal_cycle          = COALESCE(${input.renewal_cycle ?? null}, renewal_cycle),
				contract_value         = CASE WHEN ${input.contract_value !== undefined} THEN ${input.contract_value ?? null} ELSE contract_value END,
				benefit_type           = COALESCE(${input.benefit_type ?? null}, benefit_type),
				gosi_amount            = COALESCE(${input.gosi_amount ?? null}, gosi_amount),
				family_benefit_amount  = COALESCE(${input.family_benefit_amount ?? null}, family_benefit_amount),
				single_benefit_amount  = COALESCE(${input.single_benefit_amount ?? null}, single_benefit_amount),
				annual_ticket_amount   = COALESCE(${input.annual_ticket_amount ?? null}, annual_ticket_amount),
				iqama_amount           = COALESCE(${input.iqama_amount ?? null}, iqama_amount),
				sales_manager_id       = CASE WHEN ${input.sales_manager_id !== undefined} THEN ${input.sales_manager_id ?? null} ELSE sales_manager_id END,
				sales_manager_name     = CASE WHEN ${input.sales_manager_name !== undefined} THEN ${input.sales_manager_name ?? null} ELSE sales_manager_name END,
				updated_at          = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "updated", userID);
		return { contract: await fetchContract(input.id) };
	},
);

// ─── Activate ─────────────────────────────────────────────────────────────────

export const activateContract = api(
	{ expose: true, method: "POST", path: "/contracts/:id/activate", auth: true },
	async ({ id }: { id: string }): Promise<{ contract: Contract }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const c = await fetchContract(id);
		if (c.status !== "draft")
			throw APIError.failedPrecondition(
				`cannot activate a ${c.status} contract`,
			);

		// One active contract per employee — renewals must supersede via the
		// renew flow, not by activating a parallel contract.
		if (c.employee_id) {
			const existing = await db.rawQueryRow<{ reference: string }>(
				`SELECT reference FROM contracts
				 WHERE employee_id = $1 AND status = 'active' AND id <> $2
				 LIMIT 1`,
				c.employee_id,
				id,
			);
			if (existing)
				throw APIError.failedPrecondition(
					`this employee already has an active contract (${existing.reference}) — terminate or renew it first`,
				);
		}

		await db.exec`
			UPDATE contracts
			SET status = 'active', activated_by = ${userID}, activated_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "activated", userID);

		const html = emailShell(
			`Your contract has been activated`,
			erow("Reference", c.reference) +
				erow("Employee", c.employee_name) +
				erow("Type", c.contract_type) +
				erow("Start Date", c.start_date) +
				(c.end_date ? erow("End Date", c.end_date) : "") +
				erow("Status", "Active"),
		);
		notifyUser(c.created_by, `[Contract] Activated — ${c.reference}`, html);

		return { contract: await fetchContract(id) };
	},
);

// ─── Terminate ────────────────────────────────────────────────────────────────

interface TerminateContractInput {
	id: string;
	reason?: string;
}

export const terminateContract = api(
	{
		expose: true,
		method: "POST",
		path: "/contracts/:id/terminate",
		auth: true,
	},
	async (input: TerminateContractInput): Promise<{ contract: Contract }> => {
		const { userID, role } = getAuthData()!;
		if (!isAdmin(role)) throw APIError.permissionDenied("admin only");

		const c = await fetchContract(input.id);
		if (!["draft", "active"].includes(c.status))
			throw APIError.failedPrecondition(
				`cannot terminate a ${c.status} contract`,
			);

		await db.exec`
			UPDATE contracts
			SET status = 'terminated',
			    terminated_by = ${userID},
			    terminated_at = NOW(),
			    termination_reason = ${input.reason ?? null},
			    updated_at = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "terminated", userID, input.reason);

		const html = emailShell(
			`Contract terminated`,
			erow("Reference", c.reference) +
				erow("Employee", c.employee_name) +
				(input.reason ? erow("Reason", input.reason) : ""),
		);
		notifyUser(c.created_by, `[Contract] Terminated — ${c.reference}`, html);

		return { contract: await fetchContract(input.id) };
	},
);

// ─── Renew ────────────────────────────────────────────────────────────────────

interface RenewContractInput {
	id: string; // ID of the contract being renewed
	// New contract details
	start_date: string;
	end_date?: string;
	salary_amount?: number;
	notes?: string;
	file_url?: string;
	// Optional billing overrides — default to the old contract's values.
	po_number?: string;
	monthly_billing_amount?: number;
	vat_percent?: number;
}

export const renewContract = api(
	{ expose: true, method: "POST", path: "/contracts/:id/renew", auth: true },
	async (input: RenewContractInput): Promise<{ contract: Contract }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const old = await fetchContract(input.id);
		if (!["active", "expired"].includes(old.status))
			throw APIError.failedPrecondition(
				`cannot renew a ${old.status} contract`,
			);

		// Create the new contract
		const year = new Date(input.start_date).getFullYear();
		const newId = crypto.randomUUID();
		const ref = await nextRef(year);

		let creatorName: string | null = null;
		try {
			creatorName = (await user.getContact({ id: userID })).name;
		} catch {
			/* non-fatal */
		}

		await db.exec`
			INSERT INTO contracts (
				id, reference,
				employee_id, employee_name, customer_id, customer_name, job_title,
				contract_type, start_date, end_date,
				salary_amount, salary_currency, notice_period_days,
				file_url, notes, status, created_by, created_by_name,
				po_number, monthly_billing_amount, vat_percent,
				renewal_cycle, contract_value, benefit_type,
				gosi_amount, family_benefit_amount, single_benefit_amount,
				annual_ticket_amount, iqama_amount,
				sales_manager_id, sales_manager_name
			) VALUES (
				${newId}, ${ref},
				${old.employee_id ?? null}, ${old.employee_name},
				${old.customer_id ?? null}, ${old.customer_name ?? null},
				${old.job_title ?? null},
				'renewal',
				${input.start_date}, ${input.end_date ?? null},
				${input.salary_amount ?? old.salary_amount ?? null},
				${old.salary_currency}, ${old.notice_period_days},
				${input.file_url ?? null}, ${input.notes ?? null},
				'active', ${userID}, ${creatorName},
				${input.po_number ?? old.po_number ?? null},
				${input.monthly_billing_amount ?? old.monthly_billing_amount ?? null},
				${input.vat_percent ?? old.vat_percent ?? 15},
				${old.renewal_cycle}, ${old.contract_value ?? null}, ${old.benefit_type},
				${old.gosi_amount}, ${old.family_benefit_amount}, ${old.single_benefit_amount},
				${old.annual_ticket_amount}, ${old.iqama_amount},
				${old.sales_manager_id ?? null}, ${old.sales_manager_name ?? null}
			)
		`;
		await logEvent(newId, "created_via_renewal", userID);

		// Mark old contract as renewed
		await db.exec`
			UPDATE contracts
			SET status = 'renewed', renewed_by = ${userID}, renewed_at = NOW(),
			    renewed_contract_id = ${newId}, updated_at = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "renewed", userID, `Replaced by ${ref}`);

		return { contract: await fetchContract(newId) };
	},
);

// ─── Delete ───────────────────────────────────────────────────────────────────

export const deleteContract = api(
	{ expose: true, method: "DELETE", path: "/contracts/:id", auth: true },
	async ({ id }: { id: string }): Promise<{ success: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");
		await db.exec`DELETE FROM contracts WHERE id = ${id}`;
		return { success: true };
	},
);

// ─── Events ───────────────────────────────────────────────────────────────────

export const listContractEvents = api(
	{ expose: true, method: "GET", path: "/contracts/:id/events", auth: true },
	async ({ id }: { id: string }): Promise<{ events: ContractEvent[] }> => {
		getAuthData()!;
		const rows = db.rawQuery<ContractEvent>(
			`SELECT id, contract_id, action, performed_by, note, created_at
			 FROM contract_events WHERE contract_id = $1 ORDER BY created_at ASC`,
			id,
		);
		const events: ContractEvent[] = [];
		for await (const r of rows) events.push(r);
		return { events };
	},
);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface ContractStatsResponse {
	total: number;
	draft: number;
	active: number;
	expired: number;
	terminated: number;
	renewed: number;
	expiring_soon: number; // active contracts ending within 30 days
}

export const contractStats = api(
	{ expose: true, method: "GET", path: "/contracts-stats", auth: true },
	async (): Promise<ContractStatsResponse> => {
		getAuthData()!;
		const r = await db.rawQueryRow<{
			total: string;
			draft: string;
			active: string;
			expired: string;
			terminated: string;
			renewed: string;
			expiring_soon: string;
		}>(
			`SELECT
				COUNT(*)::TEXT                                                         AS total,
				COUNT(*) FILTER (WHERE status='draft')::TEXT                           AS draft,
				COUNT(*) FILTER (WHERE status='active')::TEXT                          AS active,
				COUNT(*) FILTER (WHERE status='expired')::TEXT                         AS expired,
				COUNT(*) FILTER (WHERE status='terminated')::TEXT                      AS terminated,
				COUNT(*) FILTER (WHERE status='renewed')::TEXT                         AS renewed,
				COUNT(*) FILTER (WHERE status='active' AND end_date IS NOT NULL
				                   AND end_date <= CURRENT_DATE + INTERVAL '30 days'
				                   AND end_date >= CURRENT_DATE)::TEXT                 AS expiring_soon
			FROM contracts`,
		);

		return {
			total: parseInt(r!.total, 10),
			draft: parseInt(r!.draft, 10),
			active: parseInt(r!.active, 10),
			expired: parseInt(r!.expired, 10),
			terminated: parseInt(r!.terminated, 10),
			renewed: parseInt(r!.renewed, 10),
			expiring_soon: parseInt(r!.expiring_soon, 10),
		};
	},
);
// ─── Contract Expiry Alert Cron (runs daily at 08:00) ─────────────────────────

interface AlertContract {
	id: string;
	reference: string;
	employee_name: string;
	customer_name: string | null;
	end_date: string;
	renewal_cycle: string;
	sales_manager_id: string | null;
	sales_manager_name: string | null;
	days_remaining: number;
	alert_90_sent_at: string | null;
	alert_60_sent_at: string | null;
	alert_30_sent_at: string | null;
	breach_notified_at: string | null;
	last_daily_alert_at: string | null;
}

async function runExpiryAlerts(): Promise<void> {
	log.info("running contract expiry alert check");

	// Fetch active contracts with an end_date set
	const rows = db.rawQuery<AlertContract>(
		`SELECT
       id, reference, employee_name, customer_name,
       end_date::TEXT AS end_date, renewal_cycle,
       sales_manager_id, sales_manager_name,
       (end_date - CURRENT_DATE)::int AS days_remaining,
       alert_90_sent_at, alert_60_sent_at, alert_30_sent_at,
       breach_notified_at, last_daily_alert_at
     FROM contracts
     WHERE status = 'active' AND end_date IS NOT NULL
     ORDER BY end_date ASC`,
	);

	for await (const c of rows) {
		const days = c.days_remaining;

		// Resolve recipients: sales manager + all admins
		const recipients: string[] = [];
		if (c.sales_manager_id) recipients.push(c.sales_manager_id);

		// Also notify admin + super_admin roles
		try {
			const { users: admins } = await user.listByRoles({
				roles: ["admin", "super_admin"],
			});
			for (const a of admins) {
				if (!recipients.includes(a.id)) recipients.push(a.id);
			}
		} catch {
			/* non-fatal */
		}

		if (recipients.length === 0) continue;

		const subject90 = `⚠️ Contract Expiring in 90 Days — ${c.employee_name}`;
		const subject60 = `🔔 Contract Expiring in 60 Days — ${c.employee_name}`;
		const subject30 = `🚨 Contract Expiring in 30 Days — ${c.employee_name}`;
		const subjectBreach = `🔴 CONTRACT BREACHED — ${c.employee_name} (Not Renewed)`;

		const body = emailShell(
			days <= 0
				? "Contract Breached — Immediate Action Required"
				: `Contract Expiring in ${days} Day(s)`,
			erow("Employee", c.employee_name) +
				erow("Client / Project", c.customer_name ?? "—") +
				erow("Contract Ref", c.reference) +
				erow("Renewal Cycle", c.renewal_cycle) +
				erow("End Date", c.end_date) +
				erow(
					"Days Remaining",
					days <= 0 ? `${Math.abs(days)} days overdue` : `${days} days`,
				) +
				(days <= 0
					? erow(
							"Status",
							"🔴 LAPSED — contract not renewed, employee placement at risk",
						)
					: erow("Action Required", "Initiate renewal process immediately")),
		);

		// 90-day alert
		if (days <= 90 && days > 60 && !c.alert_90_sent_at) {
			for (const uid of recipients) {
				await user
					.sendNotification({ to: uid, subject: subject90, html: body })
					.catch(() => {});
			}
			await db.exec`UPDATE contracts SET alert_90_sent_at = NOW() WHERE id = ${c.id}`;
			log.info("90-day alert sent", { contract: c.id });
		}

		// 60-day alert
		else if (days <= 60 && days > 30 && !c.alert_60_sent_at) {
			for (const uid of recipients) {
				await user
					.sendNotification({ to: uid, subject: subject60, html: body })
					.catch(() => {});
			}
			await db.exec`UPDATE contracts SET alert_60_sent_at = NOW() WHERE id = ${c.id}`;
			log.info("60-day alert sent", { contract: c.id });
		}

		// 30-day alert
		else if (days <= 30 && days > 0 && !c.alert_30_sent_at) {
			for (const uid of recipients) {
				await user
					.sendNotification({ to: uid, subject: subject30, html: body })
					.catch(() => {});
			}
			await db.exec`UPDATE contracts SET alert_30_sent_at = NOW() WHERE id = ${c.id}`;
			log.info("30-day alert sent", { contract: c.id });
		}

		// Breach / lapsed — send once as breach notification, then daily
		else if (days <= 0) {
			const today = new Date().toISOString().slice(0, 10);
			const lastDaily = c.last_daily_alert_at?.slice(0, 10);

			// First-time breach notification
			if (!c.breach_notified_at) {
				for (const uid of recipients) {
					await user
						.sendNotification({ to: uid, subject: subjectBreach, html: body })
						.catch(() => {});
				}
				await db.exec`
          UPDATE contracts
          SET breach_notified_at = NOW(), last_daily_alert_at = NOW()
          WHERE id = ${c.id}
        `;
				// Mark status as expired
				await db.exec`UPDATE contracts SET status = 'expired', updated_at = NOW() WHERE id = ${c.id}`;
				log.warn("contract breached and expired", { contract: c.id });
			}
			// Daily reminder until renewed
			else if (lastDaily !== today) {
				for (const uid of recipients) {
					await user
						.sendNotification({
							to: uid,
							subject: `📋 Daily Reminder: ${subjectBreach}`,
							html: body,
						})
						.catch(() => {});
				}
				await db.exec`UPDATE contracts SET last_daily_alert_at = NOW() WHERE id = ${c.id}`;
				log.info("daily breach reminder sent", { contract: c.id });
			}
		}
	}

	log.info("contract expiry alert check complete");
}

// Exposed endpoint so Railway/external cron can also trigger manually
export const triggerExpiryAlerts = api(
	{ expose: true, auth: true, method: "POST", path: "/contracts/alerts/run" },
	async (): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!isAdmin(role)) throw APIError.permissionDenied("admin only");
		await runExpiryAlerts();
		return { ok: true };
	},
);

// Internal endpoint called by the daily cron
export const checkExpiryAlertsCron = api(
	{ expose: false, method: "POST", path: "/internal/contracts/alerts/cron" },
	async (): Promise<void> => {
		await runExpiryAlerts();
	},
);

// Daily cron — 08:00 UTC
const _alertCron = new CronJob("contract-expiry-alerts", {
	title: "Contract expiry alert emails (90/60/30 days + daily breach)",
	schedule: "0 8 * * *",
	endpoint: checkExpiryAlertsCron,
});
