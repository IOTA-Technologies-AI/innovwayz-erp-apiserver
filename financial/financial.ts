/**
 * InnovWayz ERP — Financial Service
 *
 * Enterprise Financial Analytics & Partner Disbursement System.
 * Implements: Chart of Accounts, double-entry Journal Entries / Ledger Lines,
 * Bank Client & Resource Placement tracking, Trial Balance, P&L, Balance Sheet,
 * and automated Partner Disbursement calculations.
 *
 * Equity split (user-confirmed): Ja 30% / Wa 30% / ZA 30% / Org Growth 10%
 * Retained earnings: 20% of Net Profit locked to [31200] before distribution.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("financial", {
	migrations: "./migrations",
});

// ─── Role helpers ─────────────────────────────────────────────────────────────

function isFinance(role: string): boolean {
	return ["finance", "super_admin"].includes(role);
}
function canManage(role: string): boolean {
	return ["admin", "super_admin", "finance"].includes(role);
}
function isAdmin(role: string): boolean {
	return ["admin", "super_admin"].includes(role);
}

// ─── Audit helper ─────────────────────────────────────────────────────────────

async function audit(
	tableName: string,
	recordId: string,
	action: string,
	actorId: string,
	actorName: string | null,
	changes?: Record<string, unknown>,
): Promise<void> {
	await db.exec`
    INSERT INTO financial_audit_log (id, table_name, record_id, action, changed_by, changed_by_name, changes)
    VALUES (
      ${crypto.randomUUID()},
      ${tableName},
      ${recordId},
      ${action},
      ${actorId},
      ${actorName ?? null},
      ${changes ? JSON.stringify(changes) : null}
    )
  `;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChartOfAccount {
	account_code: string;
	account_name: string;
	account_class: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
	parent_code: string | null;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface BankClient {
	id: string;
	bank_name: string;
	billing_currency: string;
	contact_name: string | null;
	contact_email: string | null;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface FinancialResource {
	id: string;
	full_name: string;
	resource_type: string;
	monthly_cogs_cost: number;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface ResourcePlacement {
	id: string;
	resource_id: string;
	resource_name: string | null;
	bank_id: string;
	bank_name: string | null;
	monthly_billing_rate: number;
	monthly_cogs_cost: number | null;
	gross_margin: number | null;
	margin_pct: number | null;
	start_date: string;
	end_date: string | null;
	created_at: string;
}

export interface LedgerLine {
	id: string;
	journal_entry_id: string;
	account_code: string;
	account_name: string | null;
	debit: number;
	credit: number;
	description: string | null;
	created_at: string;
}

export interface JournalEntry {
	id: string;
	reference: string;
	fiscal_period: string;
	description: string;
	is_posted: boolean;
	posted_at: string | null;
	posted_by: string | null;
	posted_by_name: string | null;
	is_locked: boolean;
	created_by: string;
	created_by_name: string | null;
	created_at: string;
	updated_at: string;
	lines?: LedgerLine[];
}

export interface TrialBalanceLine {
	account_code: string;
	account_name: string;
	account_class: string;
	total_debit: number;
	total_credit: number;
}

export interface TrialBalanceResult {
	period: string | null;
	lines: TrialBalanceLine[];
	grand_total_debit: number;
	grand_total_credit: number;
	is_balanced: boolean;
	delta: number;
}

export interface PnLLine {
	account_code: string;
	account_name: string;
	amount: number;
}

export interface PnLResult {
	period: string;
	revenue_lines: PnLLine[];
	cogs_lines: PnLLine[];
	opex_lines: PnLLine[];
	gross_revenue: number;
	gross_profit: number;
	net_operating_income: number;
	net_profit: number;
	tax_provision: number;
}

export interface BalanceSheetSection {
	account_code: string;
	account_name: string;
	balance: number;
}

export interface BalanceSheetResult {
	as_of_period: string;
	assets: BalanceSheetSection[];
	liabilities: BalanceSheetSection[];
	equity: BalanceSheetSection[];
	total_assets: number;
	total_liabilities: number;
	total_equity: number;
	total_liabilities_and_equity: number;
	is_balanced: boolean;
}

export interface PartnerDraw {
	id: string;
	partner_id: string;
	fiscal_period: string;
	amount: number;
	drawn_by_name: string | null;
	reference: string | null;
	notes: string | null;
	draw_date: string;
	created_by: string;
	created_by_name: string | null;
	created_at: string;
}

export interface PartnerDisbursement {
	partner_id: string;
	partner_name: string;
	equity_percentage: number;
	associated_account: string;
	is_org_reserve: boolean;
	allocated_amount: number;
	total_drawn: number; // sum of draws this period
	available_balance: number; // allocated_amount - total_drawn
	draws: PartnerDraw[]; // draw history for this period
}

export interface DisbursementResult {
	period: string;
	gross_revenue: number;
	net_profit: number;
	retained_earnings_20pct: number;
	distributable_pool: number;
	disbursements: PartnerDisbursement[];
	can_disburse: boolean;
	blocking_reason: string | null;
	total_drawn: number; // sum of all partner draws this period
	total_reserved: number; // total accrued but not yet drawn
}

export interface PartnerCapitalAccount {
	id: string;
	partner_name: string;
	equity_percentage: number;
	associated_account: string;
	is_org_reserve: boolean;
	created_at: string;
}

export interface AuditLogEntry {
	id: string;
	table_name: string;
	record_id: string;
	action: string;
	changed_by: string;
	changed_by_name: string | null;
	changes: string | null;
	created_at: string;
}

// ─── 1. Chart of Accounts ─────────────────────────────────────────────────────

export const listAccounts = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/accounts" },
	async (): Promise<{ accounts: ChartOfAccount[] }> => {
		const rows = db.query<ChartOfAccount>`
      SELECT account_code, account_name, account_class, parent_code, is_active, created_at, updated_at
      FROM chart_of_accounts
      ORDER BY account_code
    `;
		const accounts: ChartOfAccount[] = [];
		for await (const row of rows) accounts.push(row);
		return { accounts };
	},
);

export const createAccount = api(
	{
		expose: true,
		auth: true,
		method: "POST",
		path: "/financial/accounts",
	},
	async (req: {
		account_code: string;
		account_name: string;
		account_class: string;
		parent_code?: string;
	}): Promise<ChartOfAccount> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");

		const { account_code, account_name, account_class, parent_code } = req;

		if (!/^[1-5][0-9]{4}$/.test(account_code)) {
			throw APIError.invalidArgument(
				"account_code must be a 5-digit number starting with 1–5",
			);
		}
		const validClasses = ["Asset", "Liability", "Equity", "Revenue", "Expense"];
		if (!validClasses.includes(account_class)) {
			throw APIError.invalidArgument(
				`account_class must be one of: ${validClasses.join(", ")}`,
			);
		}

		const existing = await db.queryRow<{ account_code: string }>`
      SELECT account_code FROM chart_of_accounts WHERE account_code = ${account_code}
    `;
		if (existing)
			throw APIError.alreadyExists(`Account ${account_code} already exists`);

		const row = await db.queryRow<ChartOfAccount>`
      INSERT INTO chart_of_accounts (account_code, account_name, account_class, parent_code)
      VALUES (${account_code}, ${account_name}, ${account_class as any}, ${parent_code ?? null})
      RETURNING account_code, account_name, account_class, parent_code, is_active, created_at, updated_at
    `;

		await audit("chart_of_accounts", account_code, "create", userID, null, {
			account_name,
			account_class,
		});
		return row!;
	},
);

export const updateAccount = api(
	{
		expose: true,
		auth: true,
		method: "PATCH",
		path: "/financial/accounts/:code",
	},
	async (req: {
		code: string;
		account_name?: string;
		is_active?: boolean;
	}): Promise<ChartOfAccount> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");

		const existing = await db.queryRow<ChartOfAccount>`
      SELECT account_code, account_name, account_class, parent_code, is_active, created_at, updated_at
      FROM chart_of_accounts WHERE account_code = ${req.code}
    `;
		if (!existing) throw APIError.notFound(`Account ${req.code} not found`);

		const updated = await db.queryRow<ChartOfAccount>`
      UPDATE chart_of_accounts SET
        account_name = ${req.account_name ?? existing.account_name},
        is_active    = ${req.is_active ?? existing.is_active},
        updated_at   = NOW()
      WHERE account_code = ${req.code}
      RETURNING account_code, account_name, account_class, parent_code, is_active, created_at, updated_at
    `;

		await audit("chart_of_accounts", req.code, "update", userID, null, req);
		return updated!;
	},
);

// ─── 2. Bank Clients ──────────────────────────────────────────────────────────

export const listBankClients = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/bank-clients" },
	async (): Promise<{ bank_clients: BankClient[] }> => {
		const rows = db.query<BankClient>`
      SELECT id, bank_name, billing_currency, contact_name, contact_email, is_active, created_at, updated_at
      FROM bank_clients
      ORDER BY bank_name
    `;
		const bank_clients: BankClient[] = [];
		for await (const row of rows) bank_clients.push(row);
		return { bank_clients };
	},
);

export const createBankClient = api(
	{ expose: true, auth: true, method: "POST", path: "/financial/bank-clients" },
	async (req: {
		bank_name: string;
		billing_currency?: string;
		contact_name?: string;
		contact_email?: string;
	}): Promise<BankClient> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");

		const id = crypto.randomUUID();
		const row = await db.queryRow<BankClient>`
      INSERT INTO bank_clients (id, bank_name, billing_currency, contact_name, contact_email)
      VALUES (
        ${id},
        ${req.bank_name},
        ${req.billing_currency ?? "USD"},
        ${req.contact_name ?? null},
        ${req.contact_email ?? null}
      )
      RETURNING id, bank_name, billing_currency, contact_name, contact_email, is_active, created_at, updated_at
    `;
		await audit("bank_clients", id, "create", userID, null, req);
		return row!;
	},
);

// ─── 3. Financial Resources ───────────────────────────────────────────────────

export const listResources = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/resources" },
	async (): Promise<{ resources: FinancialResource[] }> => {
		const rows = db.query<FinancialResource>`
      SELECT id, full_name, resource_type, monthly_cogs_cost, is_active, created_at, updated_at
      FROM financial_resources
      ORDER BY full_name
    `;
		const resources: FinancialResource[] = [];
		for await (const row of rows) resources.push(row);
		return { resources };
	},
);

export const createResource = api(
	{ expose: true, auth: true, method: "POST", path: "/financial/resources" },
	async (req: {
		full_name: string;
		resource_type: string;
		monthly_cogs_cost: number;
	}): Promise<FinancialResource> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");
		if (req.monthly_cogs_cost < 0)
			throw APIError.invalidArgument("monthly_cogs_cost must be >= 0");

		const id = crypto.randomUUID();
		const row = await db.queryRow<FinancialResource>`
      INSERT INTO financial_resources (id, full_name, resource_type, monthly_cogs_cost)
      VALUES (${id}, ${req.full_name}, ${req.resource_type}, ${req.monthly_cogs_cost})
      RETURNING id, full_name, resource_type, monthly_cogs_cost, is_active, created_at, updated_at
    `;
		await audit("financial_resources", id, "create", userID, null, req);
		return row!;
	},
);

// ─── 4. Resource Placements ───────────────────────────────────────────────────

export const listPlacements = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/placements" },
	async (): Promise<{ placements: ResourcePlacement[] }> => {
		const rows = db.query<ResourcePlacement>`
      SELECT
        rp.id, rp.resource_id, fr.full_name AS resource_name,
        rp.bank_id, bc.bank_name,
        rp.monthly_billing_rate,
        fr.monthly_cogs_cost,
        (rp.monthly_billing_rate - fr.monthly_cogs_cost) AS gross_margin,
        CASE
          WHEN rp.monthly_billing_rate > 0
          THEN ROUND(((rp.monthly_billing_rate - fr.monthly_cogs_cost) / rp.monthly_billing_rate) * 100, 2)
          ELSE 0
        END AS margin_pct,
        rp.start_date, rp.end_date, rp.created_at
      FROM resource_placements rp
      JOIN financial_resources fr ON fr.id = rp.resource_id
      JOIN bank_clients bc ON bc.id = rp.bank_id
      WHERE fr.is_active = TRUE
      ORDER BY fr.full_name, rp.start_date DESC
    `;
		const placements: ResourcePlacement[] = [];
		for await (const row of rows) placements.push(row);
		return { placements };
	},
);

export const createPlacement = api(
	{ expose: true, auth: true, method: "POST", path: "/financial/placements" },
	async (req: {
		resource_id: string;
		bank_id: string;
		monthly_billing_rate: number;
		start_date: string;
		end_date?: string;
	}): Promise<ResourcePlacement> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");

		const id = crypto.randomUUID();
		await db.exec`
      INSERT INTO resource_placements (id, resource_id, bank_id, monthly_billing_rate, start_date, end_date)
      VALUES (
        ${id}, ${req.resource_id}, ${req.bank_id}, ${req.monthly_billing_rate},
        ${req.start_date}, ${req.end_date ?? null}
      )
    `;
		const row = await db.rawQueryRow<ResourcePlacement>(
			`SELECT rp.id, rp.resource_id, fr.full_name AS resource_name,
              rp.bank_id, bc.bank_name, rp.monthly_billing_rate,
              fr.monthly_cogs_cost,
              (rp.monthly_billing_rate - fr.monthly_cogs_cost) AS gross_margin,
              CASE WHEN rp.monthly_billing_rate > 0
                   THEN ROUND(((rp.monthly_billing_rate - fr.monthly_cogs_cost) / rp.monthly_billing_rate) * 100, 2)
                   ELSE 0 END AS margin_pct,
              rp.start_date, rp.end_date, rp.created_at
         FROM resource_placements rp
         JOIN financial_resources fr ON fr.id = rp.resource_id
         JOIN bank_clients bc ON bc.id = rp.bank_id
         WHERE rp.id = $1`,
			id,
		);
		await audit("resource_placements", id, "create", userID, null, req);
		return row!;
	},
);

// ─── 5. Journal Entries ───────────────────────────────────────────────────────

interface CreateLedgerLineInput {
	account_code: string;
	debit?: number;
	credit?: number;
	description?: string;
}

export const listJournalEntries = api(
	{
		expose: true,
		auth: true,
		method: "GET",
		path: "/financial/journal-entries",
	},
	async (req: {
		fiscal_period?: string;
		limit?: number;
		offset?: number;
	}): Promise<{ journal_entries: JournalEntry[]; total: number }> => {
		const limit = Math.min(req.limit ?? 50, 200);
		const offset = req.offset ?? 0;

		let journal_entries: JournalEntry[];
		let total = 0;

		if (req.fiscal_period) {
			const countRow = await db.queryRow<{ count: number }>`
        SELECT COUNT(*)::int AS count FROM journal_entries WHERE fiscal_period = ${req.fiscal_period}
      `;
			total = countRow?.count ?? 0;

			const rows = db.query<JournalEntry>`
        SELECT id, reference, fiscal_period, description, is_posted, posted_at, posted_by,
               posted_by_name, is_locked, created_by, created_by_name, created_at, updated_at
        FROM journal_entries
        WHERE fiscal_period = ${req.fiscal_period}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
			journal_entries = [];
			for await (const row of rows) journal_entries.push(row);
		} else {
			const countRow = await db.queryRow<{ count: number }>`
        SELECT COUNT(*)::int AS count FROM journal_entries
      `;
			total = countRow?.count ?? 0;

			const rows = db.query<JournalEntry>`
        SELECT id, reference, fiscal_period, description, is_posted, posted_at, posted_by,
               posted_by_name, is_locked, created_by, created_by_name, created_at, updated_at
        FROM journal_entries
        ORDER BY fiscal_period DESC, created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
			journal_entries = [];
			for await (const row of rows) journal_entries.push(row);
		}

		return { journal_entries, total };
	},
);

export const getJournalEntry = api(
	{
		expose: true,
		auth: true,
		method: "GET",
		path: "/financial/journal-entries/:id",
	},
	async (req: { id: string }): Promise<JournalEntry> => {
		const entry = await db.queryRow<JournalEntry>`
      SELECT id, reference, fiscal_period, description, is_posted, posted_at, posted_by,
             posted_by_name, is_locked, created_by, created_by_name, created_at, updated_at
      FROM journal_entries WHERE id = ${req.id}
    `;
		if (!entry) throw APIError.notFound("Journal entry not found");

		const rows = db.query<LedgerLine>`
      SELECT ll.id, ll.journal_entry_id, ll.account_code,
             coa.account_name, ll.debit, ll.credit, ll.description, ll.created_at
      FROM ledger_lines ll
      LEFT JOIN chart_of_accounts coa ON coa.account_code = ll.account_code
      WHERE ll.journal_entry_id = ${req.id}
      ORDER BY ll.debit DESC, ll.created_at
    `;
		const lines: LedgerLine[] = [];
		for await (const row of rows) lines.push(row);

		return { ...entry, lines };
	},
);

export const createJournalEntry = api(
	{
		expose: true,
		auth: true,
		method: "POST",
		path: "/financial/journal-entries",
	},
	async (req: {
		fiscal_period: string;
		description: string;
		lines: CreateLedgerLineInput[];
	}): Promise<JournalEntry> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");

		if (!/^\d{4}-\d{2}$/.test(req.fiscal_period)) {
			throw APIError.invalidArgument("fiscal_period must be in YYYY-MM format");
		}
		if (!req.lines || req.lines.length < 2) {
			throw APIError.invalidArgument(
				"A journal entry must have at least 2 ledger lines",
			);
		}

		// Validate balance before insert
		let totalDebits = 0;
		let totalCredits = 0;
		for (const line of req.lines) {
			totalDebits += line.debit ?? 0;
			totalCredits += line.credit ?? 0;
		}
		if (Math.abs(totalDebits - totalCredits) > 0.005) {
			throw APIError.invalidArgument(
				`Unbalanced entry: debits ${totalDebits.toFixed(2)} ≠ credits ${totalCredits.toFixed(2)}`,
			);
		}

		const id = crypto.randomUUID();
		const seqRow = await db.rawQueryRow<{ nextval: string }>(
			`SELECT nextval('financial_je_seq')`,
		);
		const reference = `JE-${req.fiscal_period}-${String(seqRow?.nextval ?? id.slice(0, 6)).padStart(4, "0")}`;

		const entry = await db.queryRow<JournalEntry>`
      INSERT INTO journal_entries (id, reference, fiscal_period, description, created_by)
      VALUES (${id}, ${reference}, ${req.fiscal_period}, ${req.description}, ${userID})
      RETURNING id, reference, fiscal_period, description, is_posted, posted_at, posted_by,
                posted_by_name, is_locked, created_by, created_by_name, created_at, updated_at
    `;

		const lines: LedgerLine[] = [];
		for (const line of req.lines) {
			const lineId = crypto.randomUUID();
			const inserted = await db.queryRow<LedgerLine>`
        INSERT INTO ledger_lines (id, journal_entry_id, account_code, debit, credit, description)
        VALUES (
          ${lineId}, ${id}, ${line.account_code},
          ${line.debit ?? 0}, ${line.credit ?? 0}, ${line.description ?? null}
        )
        RETURNING id, journal_entry_id, account_code, debit, credit, description, created_at
      `;
			lines.push({ ...inserted!, account_name: null });
		}

		await audit("journal_entries", id, "create", userID, null, {
			fiscal_period: req.fiscal_period,
			description: req.description,
			line_count: req.lines.length,
		});

		return { ...entry!, lines };
	},
);

export const postJournalEntry = api(
	{
		expose: true,
		auth: true,
		method: "POST",
		path: "/financial/journal-entries/:id/post",
	},
	async (req: { id: string }): Promise<JournalEntry> => {
		const { userID, role } = getAuthData()!;
		if (!isFinance(role))
			throw APIError.permissionDenied("Finance role required to post entries");

		const entry = await db.queryRow<JournalEntry>`
      SELECT id, reference, fiscal_period, description, is_posted, is_locked, created_by, created_at, updated_at
      FROM journal_entries WHERE id = ${req.id}
    `;
		if (!entry) throw APIError.notFound("Journal entry not found");
		if (entry.is_posted)
			throw APIError.failedPrecondition("Entry is already posted");
		if (entry.is_locked)
			throw APIError.failedPrecondition(
				"Entry is locked and cannot be modified",
			);

		// Re-verify balance before posting
		const balRow = await db.rawQueryRow<{
			debit_sum: number;
			credit_sum: number;
		}>(
			`SELECT COALESCE(SUM(debit), 0) AS debit_sum, COALESCE(SUM(credit), 0) AS credit_sum
       FROM ledger_lines WHERE journal_entry_id = $1`,
			req.id,
		);
		if (
			Math.abs((balRow?.debit_sum ?? 0) - (balRow?.credit_sum ?? 0)) > 0.005
		) {
			throw APIError.failedPrecondition("Cannot post: entry is unbalanced");
		}

		const updated = await db.queryRow<JournalEntry>`
      UPDATE journal_entries
      SET is_posted = TRUE, posted_at = NOW(), posted_by = ${userID}, updated_at = NOW()
      WHERE id = ${req.id}
      RETURNING id, reference, fiscal_period, description, is_posted, posted_at, posted_by,
                posted_by_name, is_locked, created_by, created_by_name, created_at, updated_at
    `;

		await audit("journal_entries", req.id, "post", userID, null);
		return updated!;
	},
);

// ─── Manual edit / delete (super_admin provision) ─────────────────────────────

/**
 * Edit a journal entry's description, period and lines. super_admin only.
 * Allows correcting posted entries for minute manual adjustments; locked
 * entries remain immutable. The change is fully audited.
 */
export const updateJournalEntry = api(
	{ expose: true, auth: true, method: "PUT", path: "/financial/journal-entries/:id" },
	async (req: {
		id: string;
		description?: string;
		fiscal_period?: string;
		lines: CreateLedgerLineInput[];
	}): Promise<JournalEntry> => {
		const { userID, role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");

		const entry = await db.queryRow<JournalEntry>`
      SELECT id, reference, fiscal_period, description, is_posted, is_locked, created_by, created_at, updated_at
      FROM journal_entries WHERE id = ${req.id}
    `;
		if (!entry) throw APIError.notFound("Journal entry not found");
		if (entry.is_locked)
			throw APIError.failedPrecondition("Entry is locked and cannot be edited");

		if (!req.lines || req.lines.length < 2)
			throw APIError.invalidArgument("A journal entry must have at least 2 ledger lines");
		if (req.fiscal_period && !/^\d{4}-\d{2}$/.test(req.fiscal_period))
			throw APIError.invalidArgument("fiscal_period must be in YYYY-MM format");

		let totalDebits = 0;
		let totalCredits = 0;
		for (const line of req.lines) {
			totalDebits += line.debit ?? 0;
			totalCredits += line.credit ?? 0;
		}
		if (Math.abs(totalDebits - totalCredits) > 0.005)
			throw APIError.invalidArgument(
				`Unbalanced entry: debits ${totalDebits.toFixed(2)} ≠ credits ${totalCredits.toFixed(2)}`,
			);

		// Validate all account codes exist and are active.
		for (const line of req.lines) {
			const acct = await db.queryRow<{ account_code: string }>`
        SELECT account_code FROM chart_of_accounts WHERE account_code = ${line.account_code} AND is_active = TRUE
      `;
			if (!acct)
				throw APIError.invalidArgument(`Unknown or inactive account: ${line.account_code}`);
		}

		await db.exec`
      UPDATE journal_entries SET
        description   = COALESCE(${req.description ?? null}, description),
        fiscal_period = COALESCE(${req.fiscal_period ?? null}, fiscal_period),
        updated_at    = NOW()
      WHERE id = ${req.id}
    `;
		// Replace ledger lines wholesale.
		await db.exec`DELETE FROM ledger_lines WHERE journal_entry_id = ${req.id}`;
		for (const line of req.lines) {
			await db.exec`
        INSERT INTO ledger_lines (id, journal_entry_id, account_code, debit, credit, description)
        VALUES (${crypto.randomUUID()}, ${req.id}, ${line.account_code}, ${line.debit ?? 0}, ${line.credit ?? 0}, ${line.description ?? null})
      `;
		}

		await audit("journal_entries", req.id, "manual_edit", userID, null, {
			was_posted: entry.is_posted,
			line_count: req.lines.length,
		});

		const result = await db.queryRow<JournalEntry>`
      SELECT id, reference, fiscal_period, description, is_posted, posted_at, posted_by,
             posted_by_name, is_locked, created_by, created_by_name, created_at, updated_at
      FROM journal_entries WHERE id = ${req.id}
    `;
		const lines = await collectLines(req.id);
		return { ...result!, lines };
	},
);

/** Delete a journal entry (ledger lines cascade). super_admin only. */
export const deleteJournalEntry = api(
	{ expose: true, auth: true, method: "DELETE", path: "/financial/journal-entries/:id" },
	async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
		const { userID, role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");
		const entry = await db.queryRow<{ is_locked: boolean }>`
      SELECT is_locked FROM journal_entries WHERE id = ${id}
    `;
		if (!entry) throw APIError.notFound("Journal entry not found");
		if (entry.is_locked)
			throw APIError.failedPrecondition("Entry is locked and cannot be deleted");
		await db.exec`DELETE FROM journal_entries WHERE id = ${id}`;
		await audit("journal_entries", id, "manual_delete", userID, null);
		return { ok: true };
	},
);

async function collectLines(entryId: string): Promise<LedgerLine[]> {
	const rows = db.rawQuery<LedgerLine>(
		`SELECT ll.id, ll.journal_entry_id, ll.account_code, coa.account_name,
		        ll.debit, ll.credit, ll.description, ll.created_at
		 FROM ledger_lines ll
		 LEFT JOIN chart_of_accounts coa ON coa.account_code = ll.account_code
		 WHERE ll.journal_entry_id = $1
		 ORDER BY ll.debit DESC`,
		entryId,
	);
	const out: LedgerLine[] = [];
	for await (const r of rows) out.push(r);
	return out;
}

// ─── 6. Trial Balance ─────────────────────────────────────────────────────────

export const getTrialBalance = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/trial-balance" },
	async (req: { fiscal_period?: string }): Promise<TrialBalanceResult> => {
		let lines: TrialBalanceLine[];

		if (req.fiscal_period) {
			const rows = db.query<TrialBalanceLine>`
        SELECT
          coa.account_code,
          coa.account_name,
          coa.account_class,
          COALESCE(SUM(ll.debit), 0.00)   AS total_debit,
          COALESCE(SUM(ll.credit), 0.00)  AS total_credit
        FROM chart_of_accounts coa
        LEFT JOIN ledger_lines ll ON coa.account_code = ll.account_code
        LEFT JOIN journal_entries je ON ll.journal_entry_id = je.id
          AND je.is_posted = TRUE
          AND je.fiscal_period = ${req.fiscal_period}
        WHERE coa.is_active = TRUE
        GROUP BY coa.account_code, coa.account_name, coa.account_class
        HAVING COALESCE(SUM(ll.debit), 0) > 0 OR COALESCE(SUM(ll.credit), 0) > 0
        ORDER BY coa.account_code
      `;
			lines = [];
			for await (const row of rows) lines.push(row);
		} else {
			const rows = db.query<TrialBalanceLine>`
        SELECT
          coa.account_code,
          coa.account_name,
          coa.account_class,
          COALESCE(SUM(ll.debit), 0.00)   AS total_debit,
          COALESCE(SUM(ll.credit), 0.00)  AS total_credit
        FROM chart_of_accounts coa
        LEFT JOIN ledger_lines ll ON coa.account_code = ll.account_code
        LEFT JOIN journal_entries je ON ll.journal_entry_id = je.id AND je.is_posted = TRUE
        WHERE coa.is_active = TRUE
        GROUP BY coa.account_code, coa.account_name, coa.account_class
        HAVING COALESCE(SUM(ll.debit), 0) > 0 OR COALESCE(SUM(ll.credit), 0) > 0
        ORDER BY coa.account_code
      `;
			lines = [];
			for await (const row of rows) lines.push(row);
		}

		const grandDebit = lines.reduce((s, l) => s + Number(l.total_debit), 0);
		const grandCredit = lines.reduce((s, l) => s + Number(l.total_credit), 0);
		const delta = Math.abs(grandDebit - grandCredit);

		return {
			period: req.fiscal_period ?? null,
			lines,
			grand_total_debit: grandDebit,
			grand_total_credit: grandCredit,
			is_balanced: delta < 0.005,
			delta,
		};
	},
);

// ─── 7. Profit & Loss ─────────────────────────────────────────────────────────

export const getProfitAndLoss = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/profit-loss" },
	async (req: { fiscal_period: string }): Promise<PnLResult> => {
		if (!/^\d{4}-\d{2}$/.test(req.fiscal_period)) {
			throw APIError.invalidArgument("fiscal_period must be in YYYY-MM format");
		}

		// Fetch all posted ledger lines for the period
		const rows = db.query<{
			account_code: string;
			account_name: string;
			account_class: string;
			total_debit: number;
			total_credit: number;
		}>`
      SELECT
        coa.account_code,
        coa.account_name,
        coa.account_class,
        COALESCE(SUM(ll.debit), 0)  AS total_debit,
        COALESCE(SUM(ll.credit), 0) AS total_credit
      FROM chart_of_accounts coa
      JOIN ledger_lines ll ON coa.account_code = ll.account_code
      JOIN journal_entries je ON ll.journal_entry_id = je.id
        AND je.is_posted = TRUE
        AND je.fiscal_period = ${req.fiscal_period}
      WHERE coa.account_class IN ('Revenue', 'Expense')
      GROUP BY coa.account_code, coa.account_name, coa.account_class
      ORDER BY coa.account_code
    `;

		const revenueLines: PnLLine[] = [];
		const cogsLines: PnLLine[] = [];
		const opexLines: PnLLine[] = [];

		for await (const row of rows) {
			const code = row.account_code;
			const amount =
				row.account_class === "Revenue"
					? Number(row.total_credit) - Number(row.total_debit)
					: Number(row.total_debit) - Number(row.total_credit);

			if (row.account_class === "Revenue") {
				revenueLines.push({
					account_code: code,
					account_name: row.account_name,
					amount,
				});
			} else if (code.startsWith("51")) {
				cogsLines.push({
					account_code: code,
					account_name: row.account_name,
					amount,
				});
			} else if (code.startsWith("52")) {
				opexLines.push({
					account_code: code,
					account_name: row.account_name,
					amount,
				});
			}
		}

		// Tax provision from account 21300
		const taxRow = await db.rawQueryRow<{ total_credit: number }>(
			`SELECT COALESCE(SUM(ll.credit) - SUM(ll.debit), 0) AS total_credit
       FROM ledger_lines ll
       JOIN journal_entries je ON ll.journal_entry_id = je.id
         AND je.is_posted = TRUE AND je.fiscal_period = $1
       WHERE ll.account_code = '21300'`,
			req.fiscal_period,
		);
		const taxProvision = Number(taxRow?.total_credit ?? 0);

		const grossRevenue = revenueLines.reduce((s, l) => s + l.amount, 0);
		const totalCogs = cogsLines.reduce((s, l) => s + l.amount, 0);
		const totalOpex = opexLines.reduce((s, l) => s + l.amount, 0);
		const grossProfit = grossRevenue - totalCogs;
		const netOperatingIncome = grossProfit - totalOpex;
		const netProfit = netOperatingIncome - taxProvision;

		return {
			period: req.fiscal_period,
			revenue_lines: revenueLines,
			cogs_lines: cogsLines,
			opex_lines: opexLines,
			gross_revenue: grossRevenue,
			gross_profit: grossProfit,
			net_operating_income: netOperatingIncome,
			net_profit: netProfit,
			tax_provision: taxProvision,
		};
	},
);

// ─── 8. Balance Sheet ─────────────────────────────────────────────────────────

export const getBalanceSheet = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/balance-sheet" },
	async (req: { fiscal_period?: string }): Promise<BalanceSheetResult> => {
		const rows = db.query<{
			account_code: string;
			account_name: string;
			account_class: string;
			total_debit: number;
			total_credit: number;
		}>`
      SELECT
        coa.account_code,
        coa.account_name,
        coa.account_class,
        COALESCE(SUM(ll.debit), 0)  AS total_debit,
        COALESCE(SUM(ll.credit), 0) AS total_credit
      FROM chart_of_accounts coa
      LEFT JOIN ledger_lines ll ON coa.account_code = ll.account_code
      LEFT JOIN journal_entries je ON ll.journal_entry_id = je.id AND je.is_posted = TRUE
      WHERE coa.account_class IN ('Asset', 'Liability', 'Equity') AND coa.is_active = TRUE
      GROUP BY coa.account_code, coa.account_name, coa.account_class
      ORDER BY coa.account_code
    `;

		const assets: BalanceSheetSection[] = [];
		const liabilities: BalanceSheetSection[] = [];
		const equity: BalanceSheetSection[] = [];

		for await (const row of rows) {
			let balance: number;
			if (row.account_class === "Asset") {
				// Assets: debit increases
				balance = Number(row.total_debit) - Number(row.total_credit);
			} else {
				// Liabilities & Equity: credit increases
				balance = Number(row.total_credit) - Number(row.total_debit);
			}

			const section: BalanceSheetSection = {
				account_code: row.account_code,
				account_name: row.account_name,
				balance,
			};

			if (row.account_class === "Asset") assets.push(section);
			else if (row.account_class === "Liability") liabilities.push(section);
			else equity.push(section);
		}

		const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
		const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
		let totalEquity = equity.reduce((s, a) => s + a.balance, 0);

		// ── Roll current-period net income into equity ─────────────────────────
		// Revenue & Expense accounts are not on the balance sheet directly.
		// Until a closing entry is posted, we compute net income inline and
		// surface it as a virtual equity row so Assets = L + E always holds.
		const niRow = await db.rawQueryRow<{ net_income: number }>(
			`SELECT COALESCE(
         SUM(CASE WHEN coa.account_class = 'Revenue' THEN ll.credit - ll.debit  ELSE 0 END) -
         SUM(CASE WHEN coa.account_class = 'Expense' THEN ll.debit  - ll.credit ELSE 0 END),
         0
       ) AS net_income
       FROM chart_of_accounts coa
       JOIN ledger_lines ll  ON coa.account_code = ll.account_code
       JOIN journal_entries je ON ll.journal_entry_id = je.id AND je.is_posted = TRUE
       WHERE coa.account_class IN ('Revenue', 'Expense')`,
		);
		const netIncome = Math.round(Number(niRow?.net_income ?? 0) * 100) / 100;
		if (Math.abs(netIncome) > 0.005) {
			equity.push({
				account_code: "NET",
				account_name: "Current Period Net Income (P&L roll-up)",
				balance: netIncome,
			});
			totalEquity = Math.round((totalEquity + netIncome) * 100) / 100;
		}

		const totalLE = Math.round((totalLiabilities + totalEquity) * 100) / 100;

		return {
			as_of_period: req.fiscal_period ?? "all-time",
			assets,
			liabilities,
			equity,
			total_assets: Math.round(totalAssets * 100) / 100,
			total_liabilities: totalLiabilities,
			total_equity: totalEquity,
			total_liabilities_and_equity: totalLE,
			is_balanced: Math.abs(totalAssets - totalLE) < 0.005,
		};
	},
);

// ─── 9. Partner Disbursements ─────────────────────────────────────────────────

export const getDisbursements = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/disbursements" },
	async (req: { fiscal_period: string }): Promise<DisbursementResult> => {
		if (!/^\d{4}-\d{2}$/.test(req.fiscal_period)) {
			throw APIError.invalidArgument("fiscal_period must be in YYYY-MM format");
		}

		// Check trial balance is balanced
		const balanceCheck = await db.rawQueryRow<{
			debit_sum: number;
			credit_sum: number;
		}>(
			`SELECT COALESCE(SUM(ll.debit), 0) AS debit_sum, COALESCE(SUM(ll.credit), 0) AS credit_sum
       FROM ledger_lines ll
       JOIN journal_entries je ON ll.journal_entry_id = je.id
         AND je.is_posted = TRUE AND je.fiscal_period = $1`,
			req.fiscal_period,
		);

		const debitSum = Number(balanceCheck?.debit_sum ?? 0);
		const creditSum = Number(balanceCheck?.credit_sum ?? 0);

		if (Math.abs(debitSum - creditSum) > 0.005) {
			return {
				period: req.fiscal_period,
				gross_revenue: 0,
				net_profit: 0,
				retained_earnings_20pct: 0,
				distributable_pool: 0,
				disbursements: [],
				can_disburse: false,
				blocking_reason: `Trial Balance is unbalanced (Δ ${Math.abs(debitSum - creditSum).toFixed(2)}). Resolve before disbursement.`,
				total_drawn: 0,
				total_reserved: 0,
			};
		}

		// Compute P&L (tax_provision excluded — all ledger amounts are net)
		const pnl = await getProfitAndLoss({ fiscal_period: req.fiscal_period });

		if (pnl.net_profit <= 0) {
			return {
				period: req.fiscal_period,
				gross_revenue: pnl.gross_revenue,
				net_profit: pnl.net_profit,
				retained_earnings_20pct: 0,
				distributable_pool: 0,
				disbursements: [],
				can_disburse: false,
				blocking_reason: `Net Profit is ${pnl.net_profit <= 0 ? "zero or negative" : "insufficient"}. No distribution possible.`,
				total_drawn: 0,
				total_reserved: 0,
			};
		}

		const retainedEarnings = pnl.net_profit * 0.2;
		const distributablePool = pnl.net_profit * 0.8;

		// Fetch all partner draws for this period in one query
		const drawRows = db.query<PartnerDraw>`
      SELECT id, partner_id, fiscal_period, amount, drawn_by_name, reference, notes,
             draw_date::text AS draw_date, created_by, created_by_name, created_at
      FROM partner_draws
      WHERE fiscal_period = ${req.fiscal_period}
      ORDER BY draw_date ASC, created_at ASC
    `;
		const allDraws: PartnerDraw[] = [];
		for await (const row of drawRows) allDraws.push(row);

		// Group draws by partner
		const drawsByPartner = new Map<string, PartnerDraw[]>();
		for (const draw of allDraws) {
			if (!drawsByPartner.has(draw.partner_id))
				drawsByPartner.set(draw.partner_id, []);
			drawsByPartner.get(draw.partner_id)!.push(draw);
		}

		// Fetch partner matrix
		const partnerRows = db.query<PartnerCapitalAccount>`
      SELECT id, partner_name, equity_percentage, associated_account, is_org_reserve, created_at
      FROM partner_capital_accounts
      ORDER BY equity_percentage DESC, partner_name
    `;
		const partners: PartnerCapitalAccount[] = [];
		for await (const row of partnerRows) partners.push(row);

		const disbursements: PartnerDisbursement[] = partners.map((p) => {
			const partnerDraws = drawsByPartner.get(p.id) ?? [];
			const totalDrawn =
				Math.round(
					partnerDraws.reduce((s, d) => s + Number(d.amount), 0) * 100,
				) / 100;
			const allocatedAmount =
				Math.round(
					distributablePool * (Number(p.equity_percentage) / 100) * 100,
				) / 100;
			const availableBalance =
				Math.round((allocatedAmount - totalDrawn) * 100) / 100;

			return {
				partner_id: p.id,
				partner_name: p.partner_name,
				equity_percentage: Number(p.equity_percentage),
				associated_account: p.associated_account,
				is_org_reserve: p.is_org_reserve,
				allocated_amount: allocatedAmount,
				total_drawn: totalDrawn,
				available_balance: availableBalance,
				draws: partnerDraws,
			};
		});

		const totalDrawn = disbursements.reduce((s, d) => s + d.total_drawn, 0);
		const totalReserved = disbursements.reduce(
			(s, d) => s + Math.max(0, d.available_balance),
			0,
		);

		return {
			period: req.fiscal_period,
			gross_revenue: pnl.gross_revenue,
			net_profit: pnl.net_profit,
			retained_earnings_20pct: retainedEarnings,
			distributable_pool: distributablePool,
			disbursements,
			can_disburse: true,
			blocking_reason: null,
			total_drawn: Math.round(totalDrawn * 100) / 100,
			total_reserved: Math.round(totalReserved * 100) / 100,
		};
	},
);

// ─── 10. Partner Capital Accounts ─────────────────────────────────────────────

export const listPartners = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/partners" },
	async (): Promise<{ partners: PartnerCapitalAccount[] }> => {
		const rows = db.query<PartnerCapitalAccount>`
      SELECT id, partner_name, equity_percentage, associated_account, is_org_reserve, created_at
      FROM partner_capital_accounts
      ORDER BY equity_percentage DESC, partner_name
    `;
		const partners: PartnerCapitalAccount[] = [];
		for await (const row of rows) partners.push(row);
		return { partners };
	},
);

// ─── 10b. Partner Draws ────────────────────────────────────────────────────────

export const recordDraw = api(
	{
		expose: true,
		auth: true,
		method: "POST",
		path: "/financial/partner-draws",
	},
	async (req: {
		partner_id: string;
		fiscal_period: string;
		amount: number;
		drawn_by_name?: string;
		reference?: string;
		notes?: string;
		draw_date?: string;
	}): Promise<PartnerDraw> => {
		const { userID, role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");

		if (!/^\d{4}-\d{2}$/.test(req.fiscal_period))
			throw APIError.invalidArgument("fiscal_period must be in YYYY-MM format");
		if (req.amount <= 0)
			throw APIError.invalidArgument("draw amount must be positive");

		const partner = await db.queryRow<{ id: string; partner_name: string }>`
      SELECT id, partner_name FROM partner_capital_accounts WHERE id = ${req.partner_id}
    `;
		if (!partner) throw APIError.notFound("Partner not found");

		const id = crypto.randomUUID();
		const drawDate = req.draw_date ?? new Date().toISOString().slice(0, 10);

		const contact = await db
			.rawQueryRow<{
				name: string | null;
			}>(`SELECT name FROM users WHERE id = $1 LIMIT 1`, userID)
			.catch(() => ({ name: null as string | null }));

		const row = await db.queryRow<PartnerDraw>`
      INSERT INTO partner_draws
        (id, partner_id, fiscal_period, amount, drawn_by_name, reference, notes, draw_date, created_by, created_by_name)
      VALUES (
        ${id}, ${req.partner_id}, ${req.fiscal_period}, ${req.amount},
        ${req.drawn_by_name ?? null}, ${req.reference ?? null}, ${req.notes ?? null},
        ${drawDate}::date, ${userID}, ${contact?.name ?? null}
      )
      RETURNING id, partner_id, fiscal_period, amount, drawn_by_name, reference, notes,
                draw_date::text AS draw_date, created_by, created_by_name, created_at
    `;

		await audit("partner_draws", id, "create", userID, contact?.name ?? null, {
			partner: partner.partner_name,
			amount: req.amount,
			fiscal_period: req.fiscal_period,
			drawn_by_name: req.drawn_by_name,
		});

		return row!;
	},
);

export const listDraws = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/partner-draws" },
	async (req: {
		fiscal_period?: string;
		partner_id?: string;
	}): Promise<{ draws: PartnerDraw[] }> => {
		let draws: PartnerDraw[];

		if (req.fiscal_period && req.partner_id) {
			const rows = db.query<PartnerDraw>`
        SELECT id, partner_id, fiscal_period, amount, drawn_by_name, reference, notes,
               draw_date::text AS draw_date, created_by, created_by_name, created_at
        FROM partner_draws
        WHERE fiscal_period = ${req.fiscal_period} AND partner_id = ${req.partner_id}
        ORDER BY draw_date ASC, created_at ASC
      `;
			draws = [];
			for await (const row of rows) draws.push(row);
		} else if (req.fiscal_period) {
			const rows = db.query<PartnerDraw>`
        SELECT id, partner_id, fiscal_period, amount, drawn_by_name, reference, notes,
               draw_date::text AS draw_date, created_by, created_by_name, created_at
        FROM partner_draws
        WHERE fiscal_period = ${req.fiscal_period}
        ORDER BY draw_date ASC, created_at ASC
      `;
			draws = [];
			for await (const row of rows) draws.push(row);
		} else {
			const rows = db.query<PartnerDraw>`
        SELECT id, partner_id, fiscal_period, amount, drawn_by_name, reference, notes,
               draw_date::text AS draw_date, created_by, created_by_name, created_at
        FROM partner_draws
        ORDER BY fiscal_period DESC, draw_date DESC, created_at DESC
        LIMIT 200
      `;
			draws = [];
			for await (const row of rows) draws.push(row);
		}

		return { draws };
	},
);

// ─── 11. Audit Log ────────────────────────────────────────────────────────────

export const getAuditLog = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/audit-log" },
	async (req: {
		limit?: number;
		offset?: number;
	}): Promise<{ entries: AuditLogEntry[]; total: number }> => {
		const { role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");

		const limit = Math.min(req.limit ?? 50, 200);
		const offset = req.offset ?? 0;

		const countRow = await db.queryRow<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM financial_audit_log
    `;
		const total = countRow?.count ?? 0;

		const rows = db.query<AuditLogEntry>`
      SELECT id, table_name, record_id, action, changed_by, changed_by_name, changes, created_at
      FROM financial_audit_log
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
		const entries: AuditLogEntry[] = [];
		for await (const row of rows) entries.push(row);
		return { entries, total };
	},
);

// ─── 12. Multi-period P&L trend (for dashboard charts) ───────────────────────

export const getPnLTrend = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/pnl-trend" },
	async (req: {
		months?: number;
	}): Promise<{
		periods: string[];
		revenue: number[];
		expenses: number[];
		net_profit: number[];
	}> => {
		const months = Math.min(req.months ?? 6, 24);

		const rows = db.query<{
			fiscal_period: string;
			total_revenue: number;
			total_expense: number;
		}>`
      SELECT
        je.fiscal_period,
        COALESCE(SUM(CASE WHEN coa.account_class = 'Revenue' THEN ll.credit - ll.debit ELSE 0 END), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN coa.account_class = 'Expense' THEN ll.debit - ll.credit ELSE 0 END), 0) AS total_expense
      FROM journal_entries je
      JOIN ledger_lines ll ON ll.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON coa.account_code = ll.account_code
      WHERE je.is_posted = TRUE
        AND coa.account_class IN ('Revenue', 'Expense')
        AND je.fiscal_period >= TO_CHAR(NOW() - INTERVAL '1 month' * ${months}, 'YYYY-MM')
      GROUP BY je.fiscal_period
      ORDER BY je.fiscal_period ASC
    `;

		const data: {
			fiscal_period: string;
			total_revenue: number;
			total_expense: number;
		}[] = [];
		for await (const row of rows) data.push(row);

		return {
			periods: data.map((d) => d.fiscal_period),
			revenue: data.map((d) => Number(d.total_revenue)),
			expenses: data.map((d) => Number(d.total_expense)),
			net_profit: data.map(
				(d) => Number(d.total_revenue) - Number(d.total_expense),
			),
		};
	},
);

// ─── 13. Internal: Auto-record journal entry (called by invoice/expense services) ──

/**
 * Maps an expense_class value to the appropriate CoA expense account.
 * Exported so external callers can use the same mapping logic.
 */
export function expenseClassToAccount(expenseClass: string): string {
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
			return "52300"; // Legal, Compliance & Banking Audit Fees
		default:
			return "52300";
	}
}

export interface AutoEntryRequest {
	fiscal_period: string; // YYYY-MM
	reference_source: string; // e.g. "INV-0042" or "EXP-0018"
	description: string;
	debit_account: string; // 5-digit CoA code
	credit_account: string; // 5-digit CoA code
	amount: number;
	actor_id: string;
	actor_name: string | null;
}

/**
 * Internal endpoint — not exposed externally.
 * Called by invoice and expense services when a payment is finalised.
 * Creates a balanced, posted journal entry automatically.
 */
export const recordAutoEntry = api(
	{ expose: false, method: "POST", path: "/financial/auto-entry" },
	async (
		req: AutoEntryRequest,
	): Promise<{ ok: boolean; journal_entry_id: string }> => {
		if (req.amount <= 0) {
			log.warn("recordAutoEntry skipped: amount <= 0", {
				source: req.reference_source,
			});
			return { ok: false, journal_entry_id: "" };
		}

		// Validate both accounts exist
		const [drAcct, crAcct] = await Promise.all([
			db.queryRow<{ account_code: string }>`
        SELECT account_code FROM chart_of_accounts WHERE account_code = ${req.debit_account} AND is_active = TRUE
      `,
			db.queryRow<{ account_code: string }>`
        SELECT account_code FROM chart_of_accounts WHERE account_code = ${req.credit_account} AND is_active = TRUE
      `,
		]);
		if (!drAcct || !crAcct) {
			log.warn("recordAutoEntry skipped: unknown account", {
				debit: req.debit_account,
				credit: req.credit_account,
			});
			return { ok: false, journal_entry_id: "" };
		}

		const id = crypto.randomUUID();
		const seqRow = await db.rawQueryRow<{ nextval: string }>(
			`SELECT nextval('financial_je_seq')`,
		);
		const reference = `JE-${req.fiscal_period}-${String(seqRow?.nextval ?? "AUTO").padStart(4, "0")}`;

		await db.exec`
      INSERT INTO journal_entries
        (id, reference, fiscal_period, description,
         is_posted, posted_at, posted_by, posted_by_name,
         created_by, created_by_name, created_at, updated_at)
      VALUES (
        ${id}, ${reference}, ${req.fiscal_period}, ${req.description},
        TRUE, NOW(), ${req.actor_id}, ${req.actor_name ?? null},
        ${req.actor_id}, ${req.actor_name ?? null}, NOW(), NOW()
      )
    `;

		await db.exec`
      INSERT INTO ledger_lines (id, journal_entry_id, account_code, debit, credit, description)
      VALUES (${crypto.randomUUID()}, ${id}, ${req.debit_account},  ${req.amount}, 0.00, ${req.reference_source})
    `;
		await db.exec`
      INSERT INTO ledger_lines (id, journal_entry_id, account_code, debit, credit, description)
      VALUES (${crypto.randomUUID()}, ${id}, ${req.credit_account}, 0.00, ${req.amount}, ${req.reference_source})
    `;

		await audit(
			"journal_entries",
			id,
			"auto_created",
			req.actor_id,
			req.actor_name,
			{
				source: req.reference_source,
				debit_account: req.debit_account,
				credit_account: req.credit_account,
				amount: req.amount,
			},
		);

		log.info("auto journal entry created", {
			id,
			reference,
			source: req.reference_source,
			amount: req.amount,
		});
		return { ok: true, journal_entry_id: id };
	},
);

/**
 * Preview which auto-generated journal entries would be removed by a purge.
 * Read-only. Auto entries are those recorded via recordAutoEntry, tagged
 * `auto_created` in the audit log.
 */
export const previewAutoEntryPurge = api(
	{ expose: true, auth: true, method: "GET", path: "/financial/auto-entries/preview" },
	async (): Promise<{ count: number; total_debit: number; total_credit: number }> => {
		const { role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Finance or Admin role required");
		const row = await db.rawQueryRow<{ n: string; d: string; c: string }>(
			`SELECT COUNT(DISTINCT je.id)::TEXT AS n,
			        COALESCE(SUM(ll.debit),0)::TEXT AS d,
			        COALESCE(SUM(ll.credit),0)::TEXT AS c
			 FROM journal_entries je
			 JOIN ledger_lines ll ON ll.journal_entry_id = je.id
			 WHERE je.id IN (
			   SELECT record_id FROM financial_audit_log
			   WHERE table_name = 'journal_entries' AND action = 'auto_created'
			 )`,
		);
		return {
			count: Number.parseInt(row?.n ?? "0", 10),
			total_debit: Number(row?.d ?? 0),
			total_credit: Number(row?.c ?? 0),
		};
	},
);

/**
 * Remove all auto-generated journal entries (ledger lines cascade). Used to
 * rebuild the ledger from source after a mapping change. Intended to be
 * followed immediately by reconciliation, which re-posts the correct entries.
 * super_admin only — this deletes financial records.
 */
export const purgeAutoEntries = api(
	{ expose: true, auth: true, method: "POST", path: "/financial/auto-entries/purge" },
	async (): Promise<{ removed: number }> => {
		const { userID, role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("super_admin only");
		const res = await db.rawQueryRow<{ n: string }>(
			`WITH del AS (
			   DELETE FROM journal_entries
			   WHERE id IN (
			     SELECT record_id FROM financial_audit_log
			     WHERE table_name = 'journal_entries' AND action = 'auto_created'
			   )
			   RETURNING id
			 )
			 SELECT COUNT(*)::TEXT AS n FROM del`,
		);
		const removed = Number.parseInt(res?.n ?? "0", 10);
		await audit("journal_entries", "*", "auto_purge", userID, null, { removed });
		log.info("purged auto journal entries", { removed });
		return { removed };
	},
);

/**
 * Internal: how much has already been posted to the ledger for a given source
 * reference (an invoice or expense reference). Used by reconciliation to
 * backfill only the missing amount, so it is safe to run repeatedly.
 * Since every auto-entry is balanced, debit == credit == posted amount for
 * that source; callers read the side that matches their document type.
 */
export const postedAmountForSource = api(
	{ expose: false, method: "POST", path: "/financial/internal/posted-for-source" },
	async ({ source_ref }: { source_ref: string }): Promise<{ debit: number; credit: number }> => {
		const row = await db.rawQueryRow<{ d: string; c: string }>(
			`SELECT COALESCE(SUM(ll.debit),0)::TEXT AS d, COALESCE(SUM(ll.credit),0)::TEXT AS c
			 FROM ledger_lines ll
			 JOIN journal_entries je ON ll.journal_entry_id = je.id
			 WHERE je.is_posted = TRUE AND ll.description = $1`,
			source_ref,
		);
		return { debit: Number(row?.d ?? 0), credit: Number(row?.c ?? 0) };
	},
);
