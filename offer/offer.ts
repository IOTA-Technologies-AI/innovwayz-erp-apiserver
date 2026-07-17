import { api, APIError, Header } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";
import {
	generateOfferLetter,
	COMPANY,
	type OfferLetterData,
	type OfferSignature,
} from "./offerLetter";

const db = new SQLDatabase("offer", { migrations: "./migrations" });

// ─── Types ────────────────────────────────────────────────────────────────────

export type OfferStatus =
	| "draft"
	| "sent"
	| "viewed"
	| "signed_by_candidate"
	| "countersigned"
	| "completed"
	| "declined"
	| "cancelled"
	| "expired";

export interface OfferLetter {
	id: string;
	reference: string;
	candidate_name: string;
	candidate_email: string;
	candidate_phone: string | null;
	job_title: string;
	department: string | null;
	work_location: string | null;
	customer_id: string | null;
	customer_name: string | null;
	employment_type: string;
	joining_date: string | null;
	offer_expiry_date: string | null;
	probation_months: number | null;
	notice_period_days: number | null;
	annual_leave_days: number | null;
	currency: string;
	monthly_salary: number;
	basic_amount: number | null;
	housing_allowance: number | null;
	transport_allowance: number | null;
	other_allowance: number | null;
	benefits: string | null;
	additional_terms: string | null;
	signatory_id: string | null;
	signatory_name: string | null;
	signatory_title: string | null;
	status: OfferStatus;
	candidate_signed_at: string | null;
	first_viewed_at: string | null;
	decline_reason: string | null;
	countersigned_at: string | null;
	countersigned_by_name: string | null;
	completed_at: string | null;
	document_hash: string | null;
	created_by: string;
	created_by_name: string | null;
	sent_at: string | null;
	created_at: string;
	updated_at: string;
	// derived
	document_available: boolean;
}

export interface OfferEvent {
	id: string;
	offer_id: string;
	action: string;
	actor: string | null;
	actor_name: string | null;
	note: string | null;
	created_at: string;
}

/** Candidate-facing view — never exposes internal audit / created_by fields. */
export interface PublicOffer {
	reference: string;
	candidate_name: string;
	job_title: string;
	company_name: string;
	status: OfferStatus;
	offer_expiry_date: string | null;
	already_signed: boolean;
	expired: boolean;
}

// ─── Role helpers ─────────────────────────────────────────────────────────────

function isManager(role: string): boolean {
	return ["manager", "admin", "super_admin"].includes(role);
}
function isAdmin(role: string): boolean {
	return ["admin", "super_admin"].includes(role);
}

// ─── SQL helpers ──────────────────────────────────────────────────────────────

const OFFER_COLS = `
	id, reference, candidate_name, candidate_email, candidate_phone,
	job_title, department, work_location, customer_id, customer_name,
	employment_type,
	joining_date::TEXT      AS joining_date,
	offer_expiry_date::TEXT AS offer_expiry_date,
	probation_months, notice_period_days, annual_leave_days,
	currency,
	monthly_salary::float8      AS monthly_salary,
	basic_amount::float8        AS basic_amount,
	housing_allowance::float8   AS housing_allowance,
	transport_allowance::float8 AS transport_allowance,
	other_allowance::float8     AS other_allowance,
	benefits, additional_terms,
	signatory_id, signatory_name, signatory_title,
	status, candidate_signed_at, first_viewed_at, decline_reason,
	countersigned_at, countersigned_by_name, completed_at, document_hash,
	created_by, created_by_name, sent_at, created_at, updated_at,
	EXISTS(SELECT 1 FROM offer_letter_docs d WHERE d.offer_id = offer_letters.id) AS document_available
`;

async function fetchOffer(id: string): Promise<OfferLetter> {
	const row = await db.rawQueryRow<OfferLetter>(
		`SELECT ${OFFER_COLS} FROM offer_letters WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("offer not found");
	return row;
}

async function logEvent(
	offerId: string,
	action: string,
	actor: string | null,
	actorName: string | null,
	opts?: { ip?: string | null; userAgent?: string | null; note?: string | null },
): Promise<void> {
	await db.exec`
		INSERT INTO offer_letter_events (id, offer_id, action, actor, actor_name, ip, user_agent, note)
		VALUES (${crypto.randomUUID()}, ${offerId}, ${action}, ${actor}, ${actorName},
		        ${opts?.ip ?? null}, ${opts?.userAgent ?? null}, ${opts?.note ?? null})
	`;
}

function appBaseUrl(): string {
	const v = process.env.FRONTEND_BASE_URL;
	return (v ? v.replace(/\/$/, "") : "") || "https://erp.innovwayz.io";
}

/** Best-effort client IP from a forwarded header (first hop). */
function clientIp(forwardedFor?: string): string | null {
	if (!forwardedFor) return null;
	return forwardedFor.split(",")[0]?.trim() || null;
}

// ─── PDF assembly ─────────────────────────────────────────────────────────────

function toLetterData(
	o: OfferLetter,
	opts: {
		withCandidateSig?: boolean;
		withCompanySig?: boolean;
		candidateSig?: { value: string; type: "drawn" | "typed"; signedAt: string } | null;
		companySig?: { value: string; type: "drawn" | "typed"; signedAt: string } | null;
		audit?: OfferLetterData["audit"];
	},
): OfferLetterData {
	return {
		reference: o.reference,
		candidateName: o.candidate_name,
		candidateEmail: o.candidate_email,
		jobTitle: o.job_title,
		department: o.department,
		workLocation: o.work_location,
		clientName: o.customer_name,
		employmentType: o.employment_type,
		joiningDate: o.joining_date,
		offerExpiryDate: o.offer_expiry_date,
		probationMonths: o.probation_months,
		noticePeriodDays: o.notice_period_days,
		annualLeaveDays: o.annual_leave_days,
		currency: o.currency,
		monthlySalary: o.monthly_salary,
		breakdown: {
			basic: o.basic_amount,
			housing: o.housing_allowance,
			transport: o.transport_allowance,
			other: o.other_allowance,
		},
		benefits: o.benefits,
		additionalTerms: o.additional_terms,
		signatoryName: o.signatory_name,
		signatoryTitle: o.signatory_title,
		companySig: undefined,
		candidateSignature: opts.candidateSig
			? {
					value: opts.candidateSig.value,
					type: opts.candidateSig.type,
					name: o.candidate_name,
					signedAt: opts.candidateSig.signedAt,
				}
			: null,
		companySignature: opts.companySig
			? {
					value: opts.companySig.value,
					type: opts.companySig.type,
					name: o.signatory_name ?? "Authorized Signatory",
					signedAt: opts.companySig.signedAt,
				}
			: null,
		audit: opts.audit,
	} as OfferLetterData;
}

async function storeDoc(offerId: string, stage: string, fileName: string, pdf: Buffer): Promise<void> {
	await db.exec`
		INSERT INTO offer_letter_docs (id, offer_id, stage, file_name, content_type, data_base64)
		VALUES (${crypto.randomUUID()}, ${offerId}, ${stage}, ${fileName}, 'application/pdf', ${pdf.toString("base64")})
	`;
}

function slugify(name: string): string {
	return name.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// ─── Email ────────────────────────────────────────────────────────────────────

function emailShell(heading: string, bodyHtml: string, cta?: { url: string; label: string }): string {
	const button = cta
		? `<table cellpadding="0" cellspacing="0" style="margin:24px auto 8px;"><tr><td align="center"
		     style="background:#1E63B0;border-radius:10px;">
		     <a href="${cta.url}" style="display:inline-block;padding:14px 40px;color:#fff;font-size:15px;
		        font-weight:700;text-decoration:none;">${cta.label}</a></td></tr></table>`
		: "";
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#16437E;border-radius:12px 12px 0 0;padding:24px 40px;text-align:center;">
        <span style="color:#fff;font-size:20px;font-weight:700;">InnovWayz Technologies</span></td></tr>
      <tr><td style="background:#fff;border-radius:0 0 12px 12px;padding:32px 40px;">
        <h2 style="margin:0 0 18px;color:#16437E;font-size:19px;">${heading}</h2>
        ${bodyHtml}${button}
      </td></tr>
      <tr><td style="padding:16px 40px;text-align:center;color:#94a3b8;font-size:12px;">
        &copy; ${new Date().getFullYear()} InnovWayz Technologies. All Rights Reserved.</td></tr>
    </table></td></tr></table></body></html>`;
}

function p(text: string): string {
	return `<p style="margin:0 0 12px;color:#475569;font-size:14px;line-height:1.6;">${text}</p>`;
}

async function notify(to: string, subject: string, html: string): Promise<void> {
	try {
		await user.sendNotification({ to, subject, html });
	} catch (err) {
		log.error("offer email failed", { to, error: String(err) });
	}
}

async function notifyRoles(roles: string[], subject: string, html: string): Promise<void> {
	try {
		const { users } = await user.listByRoles({ roles });
		await Promise.all(users.map((u) => notify(u.email, subject, html)));
	} catch (err) {
		log.error("offer role email failed", { roles, error: String(err) });
	}
}

// ─── Create ───────────────────────────────────────────────────────────────────

interface CreateOfferInput {
	candidate_name: string;
	candidate_email: string;
	candidate_phone?: string;
	job_title: string;
	department?: string;
	work_location?: string;
	customer_id?: string;
	customer_name?: string;
	employment_type?: string;
	joining_date?: string;
	offer_expiry_date?: string;
	probation_months?: number;
	notice_period_days?: number;
	annual_leave_days?: number;
	currency?: string;
	monthly_salary: number;
	basic_amount?: number;
	housing_allowance?: number;
	transport_allowance?: number;
	other_allowance?: number;
	benefits?: string;
	additional_terms?: string;
	signatory_id?: string;
	signatory_name?: string;
	signatory_title?: string;
}

export const createOffer = api(
	{ expose: true, method: "POST", path: "/offers", auth: true },
	async (input: CreateOfferInput): Promise<{ offer: OfferLetter }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		if (!input.candidate_name?.trim() || !input.candidate_email?.trim() || !input.job_title?.trim()) {
			throw APIError.invalidArgument("candidate name, email and job title are required");
		}

		const id = crypto.randomUUID();
		const refRow = await db.rawQueryRow<{ ref: string }>(
			`SELECT 'OFF-' || EXTRACT(YEAR FROM NOW())::TEXT || '-' || LPAD(NEXTVAL('offer_letter_ref_seq')::TEXT, 6, '0') AS ref`,
		);
		const reference = refRow!.ref;

		let creatorName: string | null = null;
		try {
			creatorName = (await user.getContact({ id: userID })).name;
		} catch {
			/* non-fatal */
		}

		await db.exec`
			INSERT INTO offer_letters (
				id, reference, candidate_name, candidate_email, candidate_phone,
				job_title, department, work_location, customer_id, customer_name,
				employment_type, joining_date, offer_expiry_date,
				probation_months, notice_period_days, annual_leave_days,
				currency, monthly_salary, basic_amount, housing_allowance,
				transport_allowance, other_allowance, benefits, additional_terms,
				signatory_id, signatory_name, signatory_title,
				status, created_by, created_by_name
			) VALUES (
				${id}, ${reference}, ${input.candidate_name}, ${input.candidate_email}, ${input.candidate_phone ?? null},
				${input.job_title}, ${input.department ?? null}, ${input.work_location ?? null},
				${input.customer_id ?? null}, ${input.customer_name ?? null},
				${input.employment_type ?? "full_time"}, ${input.joining_date ?? null}, ${input.offer_expiry_date ?? null},
				${input.probation_months ?? null}, ${input.notice_period_days ?? null}, ${input.annual_leave_days ?? null},
				${input.currency ?? "SAR"}, ${input.monthly_salary ?? 0}, ${input.basic_amount ?? null}, ${input.housing_allowance ?? null},
				${input.transport_allowance ?? null}, ${input.other_allowance ?? null}, ${input.benefits ?? null}, ${input.additional_terms ?? null},
				${input.signatory_id ?? null}, ${input.signatory_name ?? null}, ${input.signatory_title ?? null},
				'draft', ${userID}, ${creatorName}
			)
		`;
		await logEvent(id, "created", userID, creatorName);
		return { offer: await fetchOffer(id) };
	},
);

// ─── List / Get ────────────────────────────────────────────────────────────────

interface ListOffersInput {
	status?: OfferStatus;
	candidate?: string;
	limit?: number;
	offset?: number;
}

export const listOffers = api(
	{ expose: true, method: "GET", path: "/offers", auth: true },
	async (input: ListOffersInput): Promise<{ offers: OfferLetter[]; total: number }> => {
		const { role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");

		const clauses: string[] = [];
		const args: (string | number | null)[] = [];
		const add = (clause: string, value: string | number | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};
		if (input.status) add("status = $?", input.status);
		if (input.candidate)
			add("(UPPER(candidate_name) LIKE UPPER($?) OR UPPER(candidate_email) LIKE UPPER($?))", `%${input.candidate}%`);
		// second placeholder for the OR
		if (input.candidate) args.push(`%${input.candidate}%`);
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

		const countRow = await db.rawQueryRow<{ n: string }>(
			`SELECT COUNT(*)::TEXT AS n FROM offer_letters ${where}`,
			...args,
		);
		const total = Number.parseInt(countRow?.n ?? "0", 10);

		const limit = Math.min(input.limit ?? 100, 500);
		const offset = input.offset ?? 0;
		const rows = db.rawQuery<OfferLetter>(
			`SELECT ${OFFER_COLS} FROM offer_letters ${where} ORDER BY created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
			...args, limit, offset,
		);
		const offers: OfferLetter[] = [];
		for await (const r of rows) offers.push(r);
		return { offers, total };
	},
);

export const getOffer = api(
	{ expose: true, method: "GET", path: "/offers/:id", auth: true },
	async ({ id }: { id: string }): Promise<{ offer: OfferLetter }> => {
		const { role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		return { offer: await fetchOffer(id) };
	},
);

// ─── Update (draft only) ─────────────────────────────────────────────────────

interface UpdateOfferInput extends Partial<CreateOfferInput> {
	id: string;
}

export const updateOffer = api(
	{ expose: true, method: "PUT", path: "/offers/:id", auth: true },
	async (input: UpdateOfferInput): Promise<{ offer: OfferLetter }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		const offer = await fetchOffer(input.id);
		if (offer.status !== "draft") {
			throw APIError.failedPrecondition("only draft offers can be edited");
		}

		const s = (v: string | undefined) => v ?? null;
		const n = (v: number | undefined) => v ?? null;
		await db.exec`
			UPDATE offer_letters SET
				candidate_name    = COALESCE(${s(input.candidate_name)}, candidate_name),
				candidate_email   = COALESCE(${s(input.candidate_email)}, candidate_email),
				candidate_phone   = CASE WHEN ${input.candidate_phone !== undefined} THEN ${s(input.candidate_phone)} ELSE candidate_phone END,
				job_title         = COALESCE(${s(input.job_title)}, job_title),
				department        = CASE WHEN ${input.department !== undefined} THEN ${s(input.department)} ELSE department END,
				work_location     = CASE WHEN ${input.work_location !== undefined} THEN ${s(input.work_location)} ELSE work_location END,
				customer_id       = CASE WHEN ${input.customer_id !== undefined} THEN ${s(input.customer_id)} ELSE customer_id END,
				customer_name     = CASE WHEN ${input.customer_name !== undefined} THEN ${s(input.customer_name)} ELSE customer_name END,
				employment_type   = COALESCE(${s(input.employment_type)}, employment_type),
				joining_date      = CASE WHEN ${input.joining_date !== undefined} THEN ${s(input.joining_date)} ELSE joining_date END,
				offer_expiry_date = CASE WHEN ${input.offer_expiry_date !== undefined} THEN ${s(input.offer_expiry_date)} ELSE offer_expiry_date END,
				probation_months  = CASE WHEN ${input.probation_months !== undefined} THEN ${n(input.probation_months)} ELSE probation_months END,
				notice_period_days= CASE WHEN ${input.notice_period_days !== undefined} THEN ${n(input.notice_period_days)} ELSE notice_period_days END,
				annual_leave_days = CASE WHEN ${input.annual_leave_days !== undefined} THEN ${n(input.annual_leave_days)} ELSE annual_leave_days END,
				currency          = COALESCE(${s(input.currency)}, currency),
				monthly_salary    = COALESCE(${n(input.monthly_salary)}, monthly_salary),
				basic_amount        = CASE WHEN ${input.basic_amount !== undefined} THEN ${n(input.basic_amount)} ELSE basic_amount END,
				housing_allowance   = CASE WHEN ${input.housing_allowance !== undefined} THEN ${n(input.housing_allowance)} ELSE housing_allowance END,
				transport_allowance = CASE WHEN ${input.transport_allowance !== undefined} THEN ${n(input.transport_allowance)} ELSE transport_allowance END,
				other_allowance     = CASE WHEN ${input.other_allowance !== undefined} THEN ${n(input.other_allowance)} ELSE other_allowance END,
				benefits          = CASE WHEN ${input.benefits !== undefined} THEN ${s(input.benefits)} ELSE benefits END,
				additional_terms  = CASE WHEN ${input.additional_terms !== undefined} THEN ${s(input.additional_terms)} ELSE additional_terms END,
				signatory_id      = CASE WHEN ${input.signatory_id !== undefined} THEN ${s(input.signatory_id)} ELSE signatory_id END,
				signatory_name    = CASE WHEN ${input.signatory_name !== undefined} THEN ${s(input.signatory_name)} ELSE signatory_name END,
				signatory_title   = CASE WHEN ${input.signatory_title !== undefined} THEN ${s(input.signatory_title)} ELSE signatory_title END,
				updated_at        = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "updated", userID, null);
		return { offer: await fetchOffer(input.id) };
	},
);

// ─── Send ─────────────────────────────────────────────────────────────────────

export const sendOffer = api(
	{ expose: true, method: "POST", path: "/offers/:id/send", auth: true },
	async ({ id }: { id: string }): Promise<{ offer: OfferLetter }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		const offer = await fetchOffer(id);
		if (!["draft", "sent", "viewed"].includes(offer.status)) {
			throw APIError.failedPrecondition(`cannot send a ${offer.status} offer`);
		}
		if (!offer.monthly_salary || offer.monthly_salary <= 0) {
			throw APIError.failedPrecondition("set a monthly salary before sending the offer");
		}

		const token = crypto.randomBytes(32).toString("base64url");
		const expiresAt = offer.offer_expiry_date
			? new Date(`${offer.offer_expiry_date}T23:59:59`)
			: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

		await db.exec`
			UPDATE offer_letters
			SET sign_token = ${token}, token_expires_at = ${expiresAt.toISOString()},
			    status = 'sent', sent_by = ${userID}, sent_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;

		// Render + store the unsigned PDF for the candidate to preview.
		const fresh = await fetchOffer(id);
		const pdf = await generateOfferLetter(toLetterData(fresh, {}));
		await storeDoc(id, "unsigned", `Offer_Letter-${slugify(offer.candidate_name)}-${offer.reference}.pdf`, pdf);
		await logEvent(id, "sent", userID, offer.created_by_name, {
			note: `emailed signing link to ${offer.candidate_email}`,
		});

		const signUrl = `${appBaseUrl()}/sign/${token}`;
		const html = emailShell(
			`You've received an offer from ${COMPANY.name}`,
			p(`Dear ${offer.candidate_name},`) +
				p(`We are delighted to offer you the position of <strong>${offer.job_title}</strong> at ${COMPANY.name}. ` +
					`Please review your offer letter and sign it electronically using the secure link below.`) +
				(offer.offer_expiry_date
					? p(`This offer is valid until <strong>${offer.offer_expiry_date}</strong>.`)
					: "") +
				p(`If the button doesn't work, copy and paste this link into your browser:<br><span style="color:#1E63B0;word-break:break-all;">${signUrl}</span>`),
			{ url: signUrl, label: "Review & Sign Offer" },
		);
		await notify(offer.candidate_email, `Your offer of employment — ${COMPANY.name}`, html);

		return { offer: fresh };
	},
);

// ─── Cancel ───────────────────────────────────────────────────────────────────

export const cancelOffer = api(
	{ expose: true, method: "POST", path: "/offers/:id/cancel", auth: true },
	async ({ id }: { id: string }): Promise<{ offer: OfferLetter }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		const offer = await fetchOffer(id);
		if (["completed", "cancelled", "declined"].includes(offer.status)) {
			throw APIError.failedPrecondition(`cannot cancel a ${offer.status} offer`);
		}
		await db.exec`
			UPDATE offer_letters
			SET status = 'cancelled', sign_token = NULL, cancelled_by = ${userID}, cancelled_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "cancelled", userID, null);
		return { offer: await fetchOffer(id) };
	},
);

// ─── Countersign (company) ────────────────────────────────────────────────────

interface CountersignInput {
	id: string;
	signature: string; // PNG data URL (drawn) or typed name
	signature_type: "drawn" | "typed";
}

export const countersignOffer = api(
	{ expose: true, method: "POST", path: "/offers/:id/countersign", auth: true },
	async (input: CountersignInput): Promise<{ offer: OfferLetter }> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		if (!input.signature?.trim()) throw APIError.invalidArgument("signature is required");

		const offer = await fetchOffer(input.id);
		if (offer.status !== "signed_by_candidate") {
			throw APIError.failedPrecondition(
				`offer must be signed by the candidate before it can be countersigned (current: ${offer.status})`,
			);
		}

		let signerName = offer.signatory_name;
		try {
			const contact = await user.getContact({ id: userID });
			signerName = signerName ?? contact.name;
		} catch {
			/* non-fatal */
		}
		const now = new Date().toISOString();

		await db.exec`
			UPDATE offer_letters SET
				company_signature = ${input.signature}, company_signature_type = ${input.signature_type},
				countersigned_at = ${now}, countersigned_by = ${userID}, countersigned_by_name = ${signerName},
				signatory_name = COALESCE(signatory_name, ${signerName}),
				status = 'completed', completed_at = ${now}, updated_at = NOW()
			WHERE id = ${input.id}
		`;

		// Seal the final PDF with both signatures + audit certificate.
		const fresh = await fetchOffer(input.id);
		const candSigRow = await db.rawQueryRow<{ value: string; type: "drawn" | "typed"; at: string }>(
			`SELECT candidate_signature AS value, candidate_signature_type AS type, candidate_signed_at::TEXT AS at
			 FROM offer_letters WHERE id = $1`,
			input.id,
		);
		const sealed = await generateOfferLetter(
			toLetterData(fresh, {
				candidateSig: candSigRow
					? { value: candSigRow.value, type: candSigRow.type, signedAt: candSigRow.at }
					: null,
				companySig: { value: input.signature, type: input.signature_type, signedAt: now },
				audit: {
					reference: fresh.reference,
					envelopeId: fresh.id,
					candidateName: fresh.candidate_name,
					candidateEmail: fresh.candidate_email,
					candidateSignedAt: fresh.candidate_signed_at,
					candidateIp: null,
					companySignatoryName: signerName,
					countersignedAt: now,
					documentHash: null,
				},
			}),
		);
		const hash = crypto.createHash("sha256").update(sealed).digest("hex");
		await db.exec`UPDATE offer_letters SET document_hash = ${hash} WHERE id = ${input.id}`;
		await storeDoc(input.id, "completed", `Offer_Letter-SIGNED-${slugify(offer.candidate_name)}-${offer.reference}.pdf`, sealed);
		await logEvent(input.id, "countersigned", userID, signerName, { note: `sha256:${hash.slice(0, 16)}…` });
		await logEvent(input.id, "completed", userID, signerName);

		// Notify both parties.
		const done = emailShell(
			"Offer letter fully executed",
			p(`The offer letter <strong>${offer.reference}</strong> for ${offer.candidate_name} ` +
				`(${offer.job_title}) has been signed by the candidate and countersigned by ${signerName}. ` +
				`A sealed copy is attached to the record in the ERP.`),
		);
		notifyRoles(["admin", "manager"], `[Offer] Completed — ${offer.reference}`, done);
		notify(
			offer.candidate_email,
			`Your signed offer letter — ${COMPANY.name}`,
			emailShell(
				"Your offer letter is fully signed",
				p(`Dear ${offer.candidate_name},`) +
					p(`Your offer of employment for the position of <strong>${offer.job_title}</strong> has been ` +
						`countersigned by ${COMPANY.name} and is now fully executed. ` +
						`You can download your signed copy from your signing link.`),
			),
		);

		return { offer: fresh };
	},
);

// ─── Events / stats / download (manager) ──────────────────────────────────────

export const listOfferEvents = api(
	{ expose: true, method: "GET", path: "/offers/:id/events", auth: true },
	async ({ id }: { id: string }): Promise<{ events: OfferEvent[] }> => {
		const { role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		const rows = db.rawQuery<OfferEvent>(
			`SELECT id, offer_id, action, actor, actor_name, note, created_at
			 FROM offer_letter_events WHERE offer_id = $1 ORDER BY created_at ASC`,
			id,
		);
		const events: OfferEvent[] = [];
		for await (const r of rows) events.push(r);
		return { events };
	},
);

interface OfferStatsResponse {
	total: number;
	draft: number;
	awaiting_candidate: number;
	awaiting_countersign: number;
	completed: number;
	declined: number;
}

export const offerStats = api(
	{ expose: true, method: "GET", path: "/offers-stats", auth: true },
	async (): Promise<OfferStatsResponse> => {
		const { role } = getAuthData()!;
		if (!isManager(role)) throw APIError.permissionDenied("managers only");
		const r = await db.rawQueryRow<Record<string, string>>(
			`SELECT
				COUNT(*)::TEXT AS total,
				COUNT(*) FILTER (WHERE status = 'draft')::TEXT AS draft,
				COUNT(*) FILTER (WHERE status IN ('sent','viewed'))::TEXT AS awaiting_candidate,
				COUNT(*) FILTER (WHERE status = 'signed_by_candidate')::TEXT AS awaiting_countersign,
				COUNT(*) FILTER (WHERE status = 'completed')::TEXT AS completed,
				COUNT(*) FILTER (WHERE status = 'declined')::TEXT AS declined
			FROM offer_letters`,
		);
		return {
			total: Number.parseInt(r?.total ?? "0", 10),
			draft: Number.parseInt(r?.draft ?? "0", 10),
			awaiting_candidate: Number.parseInt(r?.awaiting_candidate ?? "0", 10),
			awaiting_countersign: Number.parseInt(r?.awaiting_countersign ?? "0", 10),
			completed: Number.parseInt(r?.completed ?? "0", 10),
			declined: Number.parseInt(r?.declined ?? "0", 10),
		};
	},
);

async function streamLatestDoc(offerId: string, resp: import("http").ServerResponse): Promise<void> {
	const doc = await db.rawQueryRow<{ file_name: string; content_type: string; data_base64: string }>(
		`SELECT file_name, content_type, data_base64 FROM offer_letter_docs
		 WHERE offer_id = $1 ORDER BY created_at DESC LIMIT 1`,
		offerId,
	);
	if (!doc) {
		resp.writeHead(404, { "Content-Type": "application/json" });
		resp.end(JSON.stringify({ message: "no document generated yet" }));
		return;
	}
	const buf = Buffer.from(doc.data_base64, "base64");
	resp.writeHead(200, {
		"Content-Type": doc.content_type,
		"Content-Disposition": `inline; filename="${doc.file_name}"`,
		"Content-Length": buf.length,
	});
	resp.end(buf);
}

export const downloadOfferDocument = api.raw(
	{ expose: true, auth: true, method: "GET", path: "/offers/:id/document" },
	async (req, resp) => {
		const { role } = getAuthData()!;
		if (!isManager(role)) {
			resp.writeHead(403, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "managers only" }));
			return;
		}
		const id = /\/offers\/([^/]+)\/document/.exec(req.url ?? "")?.[1];
		if (!id) {
			resp.writeHead(400, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "invalid id" }));
			return;
		}
		await streamLatestDoc(id, resp);
	},
);

// ─── Public: candidate signing (token-based, no auth) ─────────────────────────

async function offerByToken(token: string): Promise<OfferLetter | null> {
	const row = await db.rawQueryRow<OfferLetter>(
		`SELECT ${OFFER_COLS} FROM offer_letters WHERE sign_token = $1`,
		token,
	);
	return row;
}

function isExpired(o: OfferLetter): boolean {
	if (!o.offer_expiry_date) return false;
	return new Date(`${o.offer_expiry_date}T23:59:59`) < new Date();
}

export const getPublicOffer = api(
	{ expose: true, auth: false, method: "GET", path: "/sign/:token" },
	async ({ token }: { token: string }): Promise<PublicOffer> => {
		const offer = await offerByToken(token);
		if (!offer || ["draft", "cancelled"].includes(offer.status)) {
			throw APIError.notFound("this signing link is not valid");
		}
		// Record first view.
		if (offer.status === "sent") {
			await db.exec`
				UPDATE offer_letters
				SET status = 'viewed', first_viewed_at = COALESCE(first_viewed_at, NOW()), updated_at = NOW()
				WHERE id = ${offer.id}
			`;
			await logEvent(offer.id, "viewed", `candidate:${offer.candidate_email}`, offer.candidate_name);
		}
		return {
			reference: offer.reference,
			candidate_name: offer.candidate_name,
			job_title: offer.job_title,
			company_name: COMPANY.name,
			status: offer.status === "sent" ? "viewed" : offer.status,
			offer_expiry_date: offer.offer_expiry_date,
			already_signed: ["signed_by_candidate", "countersigned", "completed"].includes(offer.status),
			expired: isExpired(offer),
		};
	},
);

export const getPublicOfferDocument = api.raw(
	{ expose: true, auth: false, method: "GET", path: "/sign/:token/document" },
	async (req, resp) => {
		const token = /\/sign\/([^/]+)\/document/.exec(req.url ?? "")?.[1];
		if (!token) {
			resp.writeHead(400, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "invalid link" }));
			return;
		}
		const offer = await offerByToken(token);
		if (!offer || ["draft", "cancelled"].includes(offer.status)) {
			resp.writeHead(404, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "not found" }));
			return;
		}
		await streamLatestDoc(offer.id, resp);
	},
);

interface AcceptOfferInput {
	token: string;
	signature: string;
	signature_type: "drawn" | "typed";
	forwardedFor?: Header<"X-Forwarded-For">;
	userAgent?: Header<"User-Agent">;
}

export const acceptOffer = api(
	{ expose: true, auth: false, method: "POST", path: "/sign/:token/accept" },
	async (input: AcceptOfferInput): Promise<{ ok: boolean }> => {
		if (!input.signature?.trim()) throw APIError.invalidArgument("signature is required");
		const offer = await offerByToken(input.token);
		if (!offer || ["draft", "cancelled"].includes(offer.status)) {
			throw APIError.notFound("this signing link is not valid");
		}
		if (["signed_by_candidate", "countersigned", "completed"].includes(offer.status)) {
			throw APIError.failedPrecondition("this offer has already been signed");
		}
		if (offer.status === "declined") throw APIError.failedPrecondition("this offer was declined");
		if (isExpired(offer)) {
			await db.exec`UPDATE offer_letters SET status = 'expired', updated_at = NOW() WHERE id = ${offer.id}`;
			throw APIError.failedPrecondition("this offer has expired");
		}

		const ip = clientIp(input.forwardedFor);
		const now = new Date().toISOString();
		await db.exec`
			UPDATE offer_letters SET
				candidate_signature = ${input.signature}, candidate_signature_type = ${input.signature_type},
				candidate_signed_at = ${now}, candidate_signer_ip = ${ip},
				candidate_signer_agent = ${input.userAgent ?? null},
				status = 'signed_by_candidate', updated_at = NOW()
			WHERE id = ${offer.id}
		`;
		await logEvent(offer.id, "signed", `candidate:${offer.candidate_email}`, offer.candidate_name, {
			ip, userAgent: input.userAgent ?? null,
		});

		// Store candidate-signed PDF.
		const fresh = await fetchOffer(offer.id);
		const pdf = await generateOfferLetter(
			toLetterData(fresh, {
				candidateSig: { value: input.signature, type: input.signature_type, signedAt: now },
			}),
		);
		await storeDoc(offer.id, "candidate_signed", `Offer_Letter-${slugify(offer.candidate_name)}-${offer.reference}.pdf`, pdf);

		// Notify HR to countersign.
		const html = emailShell(
			"Candidate signed — awaiting countersignature",
			p(`<strong>${offer.candidate_name}</strong> has accepted and signed the offer letter ` +
				`<strong>${offer.reference}</strong> (${offer.job_title}). ` +
				`Please countersign it in the ERP to complete the process.`),
		);
		notifyRoles(["admin", "manager"], `[Offer] Signed by candidate — ${offer.reference}`, html);

		return { ok: true };
	},
);

interface DeclineOfferInput {
	token: string;
	reason?: string;
	forwardedFor?: Header<"X-Forwarded-For">;
	userAgent?: Header<"User-Agent">;
}

export const declineOffer = api(
	{ expose: true, auth: false, method: "POST", path: "/sign/:token/decline" },
	async (input: DeclineOfferInput): Promise<{ ok: boolean }> => {
		const offer = await offerByToken(input.token);
		if (!offer || ["draft", "cancelled"].includes(offer.status)) {
			throw APIError.notFound("this signing link is not valid");
		}
		if (["signed_by_candidate", "countersigned", "completed"].includes(offer.status)) {
			throw APIError.failedPrecondition("this offer has already been signed");
		}
		await db.exec`
			UPDATE offer_letters SET status = 'declined', decline_reason = ${input.reason ?? null}, updated_at = NOW()
			WHERE id = ${offer.id}
		`;
		await logEvent(offer.id, "declined", `candidate:${offer.candidate_email}`, offer.candidate_name, {
			ip: clientIp(input.forwardedFor), userAgent: input.userAgent ?? null, note: input.reason ?? null,
		});
		const html = emailShell(
			"Offer declined by candidate",
			p(`<strong>${offer.candidate_name}</strong> has declined the offer letter <strong>${offer.reference}</strong> ` +
				`(${offer.job_title}).` + (input.reason ? ` Reason: ${input.reason}` : "")),
		);
		notifyRoles(["admin", "manager"], `[Offer] Declined — ${offer.reference}`, html);
		return { ok: true };
	},
);
