/**
 * InnovWayz ERP — Sales CRM Service
 *
 * Manages the full B2B sales lifecycle:
 *   Contacts → Deals → Pipeline Stages → Activities → Close
 *
 * Reports: BDM performance, quarterly/annual deal volumes, pipeline funnel.
 * All monetary values default to SAR.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("sales", { migrations: "./migrations" });

// ─── Role helpers ─────────────────────────────────────────────────────────────
function canManage(role: string): boolean {
	return ["admin", "super_admin", "manager"].includes(role);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ContactType = "lead" | "prospect" | "client" | "partner";
type DealStage =
	| "lead"
	| "qualified"
	| "proposal"
	| "negotiation"
	| "closed_won"
	| "closed_lost";
type ActivityType =
	| "call"
	| "email"
	| "meeting"
	| "demo"
	| "follow_up"
	| "proposal_sent"
	| "other";

export interface SalesContact {
	id: string;
	full_name: string;
	email: string | null;
	phone: string | null;
	company: string | null;
	job_title: string | null;
	contact_type: ContactType;
	source: string | null;
	owner_id: string | null;
	owner_name: string | null;
	notes: string | null;
	is_active: boolean;
	created_by: string;
	created_by_name: string | null;
	created_at: string;
	updated_at: string;
}

export interface SalesDeal {
	id: string;
	reference: string;
	title: string;
	contact_id: string | null;
	contact_name: string | null;
	company: string | null;
	value: number;
	currency: string;
	stage: DealStage;
	probability: number;
	expected_close_date: string | null;
	actual_close_date: string | null;
	owner_id: string | null;
	owner_name: string | null;
	description: string | null;
	lost_reason: string | null;
	created_by: string;
	created_by_name: string | null;
	created_at: string;
	updated_at: string;
	activities?: DealActivity[];
}

export interface DealActivity {
	id: string;
	deal_id: string;
	activity_type: ActivityType;
	subject: string;
	description: string | null;
	scheduled_at: string | null;
	completed_at: string | null;
	outcome: string | null;
	created_by: string;
	created_by_name: string | null;
	created_at: string;
}

export interface DealEvent {
	id: string;
	deal_id: string;
	action: string;
	actor_id: string | null;
	actor_name: string | null;
	note: string | null;
	created_at: string;
}

export interface PipelineSummary {
	stage: DealStage;
	count: number;
	total_value: number;
	avg_probability: number;
}

export interface BdmReport {
	owner_id: string | null;
	owner_name: string | null;
	total_deals: number;
	open_deals: number;
	won_deals: number;
	lost_deals: number;
	total_pipeline_value: number;
	won_value: number;
	conversion_rate: number;
}

export interface QuarterlyReport {
	year: number;
	quarter: number;
	owner_name: string | null;
	deals_won: number;
	won_value: number;
	deals_lost: number;
	deals_open: number;
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

const CONTACT_COLS = `
  id, full_name, email, phone, company, job_title,
  contact_type, source, owner_id, owner_name, notes, is_active,
  created_by, created_by_name, created_at, updated_at
`;

export const listContacts = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/contacts" },
	async (req: {
		contact_type?: string;
		owner_id?: string;
		search?: string;
		limit?: number;
		offset?: number;
	}): Promise<{ contacts: SalesContact[]; total: number }> => {
		const limit = Math.min(req.limit ?? 50, 200);
		const offset = req.offset ?? 0;

		const contacts: SalesContact[] = [];
		const rows = db.rawQuery<SalesContact>(
			`SELECT ${CONTACT_COLS}
       FROM sales_contacts
       WHERE is_active = TRUE
         AND ($1::text IS NULL OR contact_type = $1)
         AND ($2::text IS NULL OR owner_id = $2)
         AND ($3::text IS NULL OR (
               full_name ILIKE '%' || $3 || '%' OR
               company   ILIKE '%' || $3 || '%' OR
               email     ILIKE '%' || $3 || '%'))
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
			req.contact_type ?? null,
			req.owner_id ?? null,
			req.search ?? null,
			limit,
			offset,
		);
		for await (const row of rows) contacts.push(row);

		const countRow = await db.rawQueryRow<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM sales_contacts
       WHERE is_active = TRUE
         AND ($1::text IS NULL OR contact_type = $1)
         AND ($2::text IS NULL OR owner_id = $2)
         AND ($3::text IS NULL OR (full_name ILIKE '%' || $3 || '%' OR company ILIKE '%' || $3 || '%'))`,
			req.contact_type ?? null,
			req.owner_id ?? null,
			req.search ?? null,
		);
		return { contacts, total: countRow?.count ?? 0 };
	},
);

export const createContact = api(
	{ expose: true, auth: true, method: "POST", path: "/sales/contacts" },
	async (req: {
		full_name: string;
		email?: string;
		phone?: string;
		company?: string;
		job_title?: string;
		contact_type?: ContactType;
		source?: string;
		owner_id?: string;
		owner_name?: string;
		notes?: string;
	}): Promise<SalesContact> => {
		const { userID } = getAuthData()!;
		if (!req.full_name) throw APIError.invalidArgument("full_name is required");
		const id = crypto.randomUUID();
		const row = await db.rawQueryRow<SalesContact>(
			`INSERT INTO sales_contacts
         (id, full_name, email, phone, company, job_title, contact_type, source,
          owner_id, owner_name, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${CONTACT_COLS}`,
			id,
			req.full_name,
			req.email ?? null,
			req.phone ?? null,
			req.company ?? null,
			req.job_title ?? null,
			req.contact_type ?? "lead",
			req.source ?? null,
			req.owner_id ?? null,
			req.owner_name ?? null,
			req.notes ?? null,
			userID,
		);
		return row!;
	},
);

export const updateContact = api(
	{ expose: true, auth: true, method: "PUT", path: "/sales/contacts/:id" },
	async (req: {
		id: string;
		full_name?: string;
		email?: string;
		phone?: string;
		company?: string;
		job_title?: string;
		contact_type?: ContactType;
		source?: string;
		owner_id?: string;
		owner_name?: string;
		notes?: string;
		is_active?: boolean;
	}): Promise<SalesContact> => {
		const existing = await db.rawQueryRow<SalesContact>(
			`SELECT ${CONTACT_COLS} FROM sales_contacts WHERE id = $1`,
			req.id,
		);
		if (!existing) throw APIError.notFound("Contact not found");
		const row = await db.rawQueryRow<SalesContact>(
			`UPDATE sales_contacts SET
         full_name    = $2, email        = $3, phone       = $4,
         company      = $5, job_title    = $6, contact_type = $7,
         source       = $8, owner_id     = $9, owner_name  = $10,
         notes        = $11, is_active   = $12, updated_at = NOW()
       WHERE id = $1
       RETURNING ${CONTACT_COLS}`,
			req.id,
			req.full_name ?? existing.full_name,
			req.email ?? existing.email,
			req.phone ?? existing.phone,
			req.company ?? existing.company,
			req.job_title ?? existing.job_title,
			req.contact_type ?? existing.contact_type,
			req.source ?? existing.source,
			req.owner_id ?? existing.owner_id,
			req.owner_name ?? existing.owner_name,
			req.notes ?? existing.notes,
			req.is_active ?? existing.is_active,
		);
		return row!;
	},
);

export const deleteContact = api(
	{ expose: true, auth: true, method: "DELETE", path: "/sales/contacts/:id" },
	async (req: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Manager or Admin required");
		await db.exec`UPDATE sales_contacts SET is_active = FALSE, updated_at = NOW() WHERE id = ${req.id}`;
		return { ok: true };
	},
);

// ─── Deals ────────────────────────────────────────────────────────────────────

const DEAL_COLS = `
  id, reference, title, contact_id, contact_name, company,
  value, currency, stage, probability, expected_close_date, actual_close_date,
  owner_id, owner_name, description, lost_reason,
  created_by, created_by_name, created_at, updated_at
`;

// Default probability by stage
const STAGE_PROBABILITY: Record<DealStage, number> = {
	lead: 10,
	qualified: 25,
	proposal: 50,
	negotiation: 75,
	closed_won: 100,
	closed_lost: 0,
};

export const listDeals = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/deals" },
	async (req: {
		stage?: string;
		owner_id?: string;
		year?: number;
		quarter?: number;
		search?: string;
		limit?: number;
		offset?: number;
	}): Promise<{ deals: SalesDeal[]; total: number }> => {
		const limit = Math.min(req.limit ?? 100, 500);
		const offset = req.offset ?? 0;

		const deals: SalesDeal[] = [];
		const rows = db.rawQuery<SalesDeal>(
			`SELECT ${DEAL_COLS}
       FROM sales_deals
       WHERE ($1::text IS NULL OR stage = $1)
         AND ($2::text IS NULL OR owner_id = $2)
         AND ($3::int  IS NULL OR EXTRACT(YEAR    FROM expected_close_date) = $3)
         AND ($4::int  IS NULL OR EXTRACT(QUARTER FROM expected_close_date) = $4)
         AND ($5::text IS NULL OR (title ILIKE '%'||$5||'%' OR company ILIKE '%'||$5||'%'))
       ORDER BY updated_at DESC
       LIMIT $6 OFFSET $7`,
			req.stage ?? null,
			req.owner_id ?? null,
			req.year ?? null,
			req.quarter ?? null,
			req.search ?? null,
			limit,
			offset,
		);
		for await (const row of rows)
			deals.push({ ...row, value: Number(row.value) });

		const countRow = await db.rawQueryRow<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM sales_deals
       WHERE ($1::text IS NULL OR stage = $1)
         AND ($2::text IS NULL OR owner_id = $2)
         AND ($3::int  IS NULL OR EXTRACT(YEAR    FROM expected_close_date) = $3)
         AND ($4::int  IS NULL OR EXTRACT(QUARTER FROM expected_close_date) = $4)`,
			req.stage ?? null,
			req.owner_id ?? null,
			req.year ?? null,
			req.quarter ?? null,
		);
		return { deals, total: countRow?.count ?? 0 };
	},
);

export const getDeal = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/deals/:id" },
	async (req: { id: string }): Promise<SalesDeal> => {
		const deal = await db.rawQueryRow<SalesDeal>(
			`SELECT ${DEAL_COLS} FROM sales_deals WHERE id = $1`,
			req.id,
		);
		if (!deal) throw APIError.notFound("Deal not found");

		const actRows = db.rawQuery<DealActivity>(
			`SELECT id, deal_id, activity_type, subject, description,
              scheduled_at, completed_at, outcome, created_by, created_by_name, created_at
         FROM deal_activities WHERE deal_id = $1 ORDER BY created_at DESC`,
			req.id,
		);
		const activities: DealActivity[] = [];
		for await (const a of actRows) activities.push(a);

		return { ...deal, value: Number(deal.value), activities };
	},
);

export const createDeal = api(
	{ expose: true, auth: true, method: "POST", path: "/sales/deals" },
	async (req: {
		title: string;
		contact_id?: string;
		contact_name?: string;
		company?: string;
		value?: number;
		currency?: string;
		stage?: DealStage;
		probability?: number;
		expected_close_date?: string;
		owner_id?: string;
		owner_name?: string;
		description?: string;
	}): Promise<SalesDeal> => {
		const { userID } = getAuthData()!;
		if (!req.title) throw APIError.invalidArgument("title is required");
		const stage = req.stage ?? "lead";
		const id = crypto.randomUUID();
		const seqRow = await db.rawQueryRow<{ nextval: string }>(
			`SELECT nextval('sales_deal_ref_seq')`,
		);
		const reference = `DEAL-${String(seqRow?.nextval ?? "001").padStart(4, "0")}`;

		const row = await db.rawQueryRow<SalesDeal>(
			`INSERT INTO sales_deals
         (id, reference, title, contact_id, contact_name, company,
          value, currency, stage, probability, expected_close_date,
          owner_id, owner_name, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${DEAL_COLS}`,
			id,
			reference,
			req.title,
			req.contact_id ?? null,
			req.contact_name ?? null,
			req.company ?? null,
			req.value ?? 0,
			req.currency ?? "SAR",
			stage,
			req.probability ?? STAGE_PROBABILITY[stage],
			req.expected_close_date ?? null,
			req.owner_id ?? null,
			req.owner_name ?? null,
			req.description ?? null,
			userID,
		);
		await logDealEvent(id, "created", userID, null);
		return { ...row!, value: Number(row!.value) };
	},
);

export const updateDeal = api(
	{ expose: true, auth: true, method: "PUT", path: "/sales/deals/:id" },
	async (req: {
		id: string;
		title?: string;
		contact_id?: string;
		contact_name?: string;
		company?: string;
		value?: number;
		currency?: string;
		stage?: DealStage;
		probability?: number;
		expected_close_date?: string;
		actual_close_date?: string;
		owner_id?: string;
		owner_name?: string;
		description?: string;
		lost_reason?: string;
	}): Promise<SalesDeal> => {
		const { userID } = getAuthData()!;
		const existing = await db.rawQueryRow<SalesDeal>(
			`SELECT ${DEAL_COLS} FROM sales_deals WHERE id = $1`,
			req.id,
		);
		if (!existing) throw APIError.notFound("Deal not found");

		const stage = req.stage ?? (existing.stage as DealStage);
		// Auto-set actual_close_date when won/lost
		let actualCloseDate = req.actual_close_date ?? existing.actual_close_date;
		if (
			(stage === "closed_won" || stage === "closed_lost") &&
			!actualCloseDate
		) {
			actualCloseDate = new Date().toISOString().slice(0, 10);
		}

		const row = await db.rawQueryRow<SalesDeal>(
			`UPDATE sales_deals SET
         title               = $2,  contact_id          = $3,
         contact_name        = $4,  company             = $5,
         value               = $6,  currency            = $7,
         stage               = $8,  probability         = $9,
         expected_close_date = $10, actual_close_date   = $11,
         owner_id            = $12, owner_name          = $13,
         description         = $14, lost_reason         = $15,
         updated_at          = NOW()
       WHERE id = $1
       RETURNING ${DEAL_COLS}`,
			req.id,
			req.title ?? existing.title,
			req.contact_id ?? existing.contact_id,
			req.contact_name ?? existing.contact_name,
			req.company ?? existing.company,
			req.value ?? existing.value,
			req.currency ?? existing.currency,
			stage,
			req.probability ?? STAGE_PROBABILITY[stage],
			req.expected_close_date ?? existing.expected_close_date,
			actualCloseDate,
			req.owner_id ?? existing.owner_id,
			req.owner_name ?? existing.owner_name,
			req.description ?? existing.description,
			req.lost_reason ?? existing.lost_reason,
		);

		if (req.stage && req.stage !== existing.stage) {
			await logDealEvent(
				req.id,
				`stage_changed_to_${stage}`,
				userID,
				null,
				`Stage: ${existing.stage} → ${stage}`,
			);
		}
		return { ...row!, value: Number(row!.value) };
	},
);

export const deleteDeal = api(
	{ expose: true, auth: true, method: "DELETE", path: "/sales/deals/:id" },
	async (req: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!canManage(role))
			throw APIError.permissionDenied("Manager or Admin required");
		await db.exec`DELETE FROM sales_deals WHERE id = ${req.id}`;
		return { ok: true };
	},
);

// ─── Activities ───────────────────────────────────────────────────────────────

export const addActivity = api(
	{
		expose: true,
		auth: true,
		method: "POST",
		path: "/sales/deals/:dealId/activities",
	},
	async (req: {
		dealId: string;
		activity_type: ActivityType;
		subject: string;
		description?: string;
		scheduled_at?: string;
		completed_at?: string;
		outcome?: string;
	}): Promise<DealActivity> => {
		const { userID } = getAuthData()!;
		const deal = await db.rawQueryRow<{ id: string }>(
			`SELECT id FROM sales_deals WHERE id = $1`,
			req.dealId,
		);
		if (!deal) throw APIError.notFound("Deal not found");

		const id = crypto.randomUUID();
		const row = await db.rawQueryRow<DealActivity>(
			`INSERT INTO deal_activities
         (id, deal_id, activity_type, subject, description, scheduled_at, completed_at, outcome, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, deal_id, activity_type, subject, description,
                 scheduled_at, completed_at, outcome, created_by, created_by_name, created_at`,
			id,
			req.dealId,
			req.activity_type,
			req.subject,
			req.description ?? null,
			req.scheduled_at ?? null,
			req.completed_at ?? null,
			req.outcome ?? null,
			userID,
		);
		await logDealEvent(
			req.dealId,
			`activity_added_${req.activity_type}`,
			userID,
			null,
			req.subject,
		);
		return row!;
	},
);

export const listActivities = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/activities" },
	async (req: {
		activity_type?: string;
		owner_id?: string;
		limit?: number;
		offset?: number;
	}): Promise<{
		activities: (DealActivity & { deal_title: string | null })[];
	}> => {
		const limit = Math.min(req.limit ?? 100, 500);
		const offset = req.offset ?? 0;
		const rows = db.rawQuery<DealActivity & { deal_title: string | null }>(
			`SELECT da.id, da.deal_id, sd.title AS deal_title, da.activity_type,
              da.subject, da.description, da.scheduled_at, da.completed_at,
              da.outcome, da.created_by, da.created_by_name, da.created_at
         FROM deal_activities da
         LEFT JOIN sales_deals sd ON sd.id = da.deal_id
         WHERE ($1::text IS NULL OR da.activity_type = $1)
           AND ($2::text IS NULL OR sd.owner_id = $2)
         ORDER BY da.created_at DESC
         LIMIT $3 OFFSET $4`,
			req.activity_type ?? null,
			req.owner_id ?? null,
			limit,
			offset,
		);
		const activities: (DealActivity & { deal_title: string | null })[] = [];
		for await (const row of rows) activities.push(row);
		return { activities };
	},
);

// ─── Reports ──────────────────────────────────────────────────────────────────

/** Pipeline funnel — count and value by stage. */
export const getPipelineSummary = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/reports/pipeline" },
	async (): Promise<{ pipeline: PipelineSummary[] }> => {
		const rows = db.rawQuery<PipelineSummary>(
			`SELECT stage, COUNT(*)::int AS count,
              COALESCE(SUM(value), 0) AS total_value,
              COALESCE(AVG(probability), 0) AS avg_probability
         FROM sales_deals
         GROUP BY stage
         ORDER BY CASE stage
           WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2 WHEN 'proposal' THEN 3
           WHEN 'negotiation' THEN 4 WHEN 'closed_won' THEN 5 ELSE 6 END`,
		);
		const pipeline: PipelineSummary[] = [];
		for await (const row of rows) {
			pipeline.push({
				...row,
				total_value: Number(row.total_value),
				avg_probability: Number(row.avg_probability),
			});
		}
		return { pipeline };
	},
);

/** BDM performance — deals and values grouped by owner. */
export const getBdmReport = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/reports/bdm" },
	async (req: { year?: number }): Promise<{ bdm: BdmReport[] }> => {
		const rows = db.rawQuery<{
			owner_id: string | null;
			owner_name: string | null;
			total_deals: number;
			won_deals: number;
			lost_deals: number;
			total_pipeline_value: number;
			won_value: number;
		}>(
			`SELECT
         owner_id, owner_name,
         COUNT(*)::int                                           AS total_deals,
         COUNT(*) FILTER (WHERE stage = 'closed_won')::int      AS won_deals,
         COUNT(*) FILTER (WHERE stage = 'closed_lost')::int     AS lost_deals,
         COALESCE(SUM(value), 0)                                AS total_pipeline_value,
         COALESCE(SUM(value) FILTER (WHERE stage = 'closed_won'), 0) AS won_value
       FROM sales_deals
       WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM COALESCE(actual_close_date, expected_close_date, created_at::date)) = $1)
       GROUP BY owner_id, owner_name
       ORDER BY won_value DESC`,
			req.year ?? null,
		);
		const bdm: BdmReport[] = [];
		for await (const row of rows) {
			const open = row.total_deals - row.won_deals - row.lost_deals;
			const conv =
				row.total_deals > 0
					? Math.round((row.won_deals / row.total_deals) * 100 * 10) / 10
					: 0;
			bdm.push({
				...row,
				open_deals: open,
				total_pipeline_value: Number(row.total_pipeline_value),
				won_value: Number(row.won_value),
				conversion_rate: conv,
			});
		}
		return { bdm };
	},
);

/** Quarterly breakdown — won / lost / open deals and value per BDM per quarter. */
export const getQuarterlyReport = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/reports/quarterly" },
	async (req: {
		year?: number;
		owner_id?: string;
	}): Promise<{ rows: QuarterlyReport[] }> => {
		const dbRows = db.rawQuery<{
			year: number;
			quarter: number;
			owner_name: string | null;
			deals_won: number;
			won_value: number;
			deals_lost: number;
			deals_open: number;
		}>(
			`SELECT
         EXTRACT(YEAR    FROM expected_close_date)::int AS year,
         EXTRACT(QUARTER FROM expected_close_date)::int AS quarter,
         owner_name,
         COUNT(*) FILTER (WHERE stage = 'closed_won')::int  AS deals_won,
         COALESCE(SUM(value) FILTER (WHERE stage = 'closed_won'), 0) AS won_value,
         COUNT(*) FILTER (WHERE stage = 'closed_lost')::int AS deals_lost,
         COUNT(*) FILTER (WHERE stage NOT IN ('closed_won','closed_lost'))::int AS deals_open
       FROM sales_deals
       WHERE expected_close_date IS NOT NULL
         AND ($1::int  IS NULL OR EXTRACT(YEAR FROM expected_close_date) = $1)
         AND ($2::text IS NULL OR owner_id = $2)
       GROUP BY 1, 2, 3
       ORDER BY 1 DESC, 2 DESC, 3`,
			req.year ?? null,
			req.owner_id ?? null,
		);
		const result: QuarterlyReport[] = [];
		for await (const row of dbRows) {
			result.push({ ...row, won_value: Number(row.won_value) });
		}
		return { rows: result };
	},
);

// ─── Deal Events helper ───────────────────────────────────────────────────────

async function logDealEvent(
	dealId: string,
	action: string,
	actorId: string,
	actorName: string | null,
	note?: string,
): Promise<void> {
	await db.exec`
    INSERT INTO deal_events (id, deal_id, action, actor_id, actor_name, note)
    VALUES (${crypto.randomUUID()}, ${dealId}, ${action}, ${actorId}, ${actorName ?? null}, ${note ?? null})
  `;
}

export const getDealEvents = api(
	{ expose: true, auth: true, method: "GET", path: "/sales/deals/:id/events" },
	async (req: { id: string }): Promise<{ events: DealEvent[] }> => {
		const rows = db.rawQuery<DealEvent>(
			`SELECT id, deal_id, action, actor_id, actor_name, note, created_at
       FROM deal_events WHERE deal_id = $1 ORDER BY created_at DESC`,
			req.id,
		);
		const events: DealEvent[] = [];
		for await (const row of rows) events.push(row);
		return { events };
	},
);
