import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
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
				file_url, notes, status, created_by, created_by_name
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
				'draft', ${userID}, ${creatorName}
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
				file_url, notes, status, created_by, created_by_name
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
				'active', ${userID}, ${creatorName}
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
