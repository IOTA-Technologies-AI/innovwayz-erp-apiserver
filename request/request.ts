import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { user, billing, contract, payroll, leave } from "~encore/clients";
import log from "encore.dev/log";
import crypto from "node:crypto";
import {
	generateExperienceLetter,
	generateSalaryCertificate,
	type LetterData,
	type SalaryCertificateData,
} from "./letters";

const db = new SQLDatabase("request", {
	migrations: "./migrations",
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type RequestType =
	| "exit_reentry"
	| "insurance_update"
	| "family_status"
	| "dependent_add"
	| "iqama_renewal"
	| "chamber_commerce"
	| "employment_letter"
	| "salary_certificate"
	| "experience_letter"
	| "noc_letter"
	| "other";

export type RequestStatus =
	| "submitted"
	| "in_review"
	| "completed"
	| "rejected"
	| "cancelled";

export type RequestPriority = "low" | "normal" | "high" | "urgent";

export interface EmployeeRequest {
	id: string;
	reference: string;
	request_type: RequestType;
	request_subtype: string | null;
	employee_id: string | null;
	employee_name: string;
	customer_id: string | null;
	customer_name: string | null;
	title: string;
	description: string | null;
	priority: RequestPriority;
	requested_date: string;
	required_by_date: string | null;
	attachment_url: string | null;
	notes: string | null;
	status: RequestStatus;
	created_by: string;
	created_by_name: string | null;
	reviewed_by: string | null;
	reviewed_at: string | null;
	completed_by: string | null;
	completed_at: string | null;
	completion_notes: string | null;
	rejected_by: string | null;
	rejected_at: string | null;
	rejection_reason: string | null;
	created_at: string;
	updated_at: string;
	/** True when a generated letter/certificate is available for download. */
	document_available: boolean;
}

export interface RequestEvent {
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

const REQUEST_COLS = `
	id, reference, request_type, request_subtype,
	employee_id, employee_name, customer_id, customer_name,
	title, description, priority,
	requested_date::TEXT AS requested_date,
	required_by_date::TEXT AS required_by_date,
	attachment_url, notes, status, created_by, created_by_name,
	reviewed_by, reviewed_at, completed_by, completed_at, completion_notes,
	rejected_by, rejected_at, rejection_reason,
	created_at, updated_at,
	EXISTS(
		SELECT 1 FROM request_documents d WHERE d.request_id = employee_requests.id
	) AS document_available
`;

async function fetchRequest(id: string): Promise<EmployeeRequest> {
	const row = await db.rawQueryRow<EmployeeRequest>(
		`SELECT ${REQUEST_COLS} FROM employee_requests WHERE id = $1`,
		id,
	);
	if (!row) throw APIError.notFound("request not found");
	return row;
}

async function logEvent(
	requestId: string,
	action: string,
	actorId: string,
	note?: string,
): Promise<void> {
	await db.exec`
		INSERT INTO employee_request_events (id, request_id, action, performed_by, note)
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

function emailShell(heading: string, bodyRows: string): string {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
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

function row(label: string, value: string): string {
	return `<tr>
    <td style="padding:6px 0;color:#64748b;font-size:13px;width:40%;">${label}</td>
    <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${value}</td>
  </tr>`;
}

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
	exit_reentry: "Exit / Re-Entry Visa",
	insurance_update: "Insurance Update",
	family_status: "Family Status Change",
	dependent_add: "Dependent Addition",
	iqama_renewal: "Iqama Renewal",
	chamber_commerce: "Chamber of Commerce",
	employment_letter: "Employment Letter",
	salary_certificate: "Salary Certificate",
	experience_letter: "Experience Letter",
	noc_letter: "NOC Letter",
	other: "Other",
};

// ─── Letter generation ────────────────────────────────────────────────────────

/** Request types that produce an auto-generated PDF letter on completion. */
const LETTER_REQUEST_TYPES: RequestType[] = [
	"experience_letter",
	"salary_certificate",
];

function slugify(name: string): string {
	return name.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/**
 * Assemble employee data from the billing (roster + salary) and contract
 * (employment dates) services, render the PDF and store it against the
 * request. Regeneration inserts a new version; the latest one is served.
 */
type EmployeeCompensation = Awaited<
	ReturnType<typeof billing.getEmployeeCompensation>
>;

/** Employment dates + formal job title from the contract service (best-effort). */
async function resolveEmploymentDetails(employeeId: string): Promise<{
	dateOfJoining: string | null;
	dateOfRelieving: string | null;
	jobTitle: string | null;
}> {
	let dateOfJoining: string | null = null;
	let dateOfRelieving: string | null = null;
	let jobTitle: string | null = null;
	try {
		const { contracts } = await contract.listContracts({
			employee_id: employeeId,
			limit: 100,
		});
		const employment = contracts
			.filter((c) => c.status !== "draft")
			.sort((a, b) => b.start_date.localeCompare(a.start_date));
		if (employment.length > 0) {
			const latest = employment[0];
			// Joining date = earliest contract start across the employment chain
			dateOfJoining = employment[employment.length - 1].start_date;
			jobTitle = latest.job_title;
			if (["terminated", "expired"].includes(latest.status)) {
				dateOfRelieving =
					latest.end_date ?? latest.terminated_at?.slice(0, 10) ?? null;
			}
		}
	} catch (err) {
		log.warn("employment details lookup failed", {
			employee_id: employeeId,
			error: String(err),
		});
	}
	return { dateOfJoining, dateOfRelieving, jobTitle };
}

/**
 * Assemble the full payslip (salary-certificate) data for an employee. Keyed by
 * employee + optional pay period: with a period, uses that exact salary_payment
 * row; otherwise the latest non-rejected one. Shared by the HR-request letter
 * flow and the internal payslip endpoint used on salary payment.
 */
async function buildSalaryCertificateData(
	employeeId: string,
	emp: EmployeeCompensation,
	base: LetterData,
	opts: { periodMonth?: number; periodYear?: number } = {},
): Promise<SalaryCertificateData> {
	if (!emp.monthly_salary || emp.monthly_salary <= 0) {
		throw new Error(
			"no salary on record for this employee — set the monthly salary before generating a payslip",
		);
	}

	// Per-period figures from the payroll record: overtime/additions, the
	// itemized deductions, attendance/leaves and the pay period.
	let overtime = 0;
	let salaryAdvance = 0;
	let latest: Awaited<
		ReturnType<typeof payroll.listSalaryPayments>
	>["salaries"][number] | undefined;
	try {
		const { salaries } = await payroll.listSalaryPayments(
			opts.periodMonth && opts.periodYear
				? {
						employee_id: employeeId,
						period_month: opts.periodMonth,
						period_year: opts.periodYear,
					}
				: { employee_id: employeeId },
		);
		latest = salaries.find(
			(s) => !["rejected", "cancelled"].includes(s.status),
		);
		if (latest) {
			overtime = Number(latest.additions) || 0;
			// Prefer the itemized advance; fall back to the legacy lump for records
			// created before the payslip breakdown existed.
			salaryAdvance =
				Number(latest.salary_advance) || Number(latest.deductions) || 0;
		}
	} catch (err) {
		log.warn("payslip: payroll lookup failed", {
			employee_id: employeeId,
			error: String(err),
		});
	}

	// Loss-of-pay days: from the payroll record when one exists; otherwise
	// derived from leave balances (days used beyond entitlement + carry-forward).
	let leaveLopDays = 0;
	try {
		const { balances } = await leave.listLeaveBalances({
			employee_id: employeeId,
			year: new Date().getFullYear(),
		});
		for (const bal of balances) {
			const allowed =
				(Number(bal.entitled_days) || 0) +
				(Number(bal.carry_forward_days) || 0);
			const used = Number(bal.used_days) || 0;
			if (used > allowed) leaveLopDays += used - allowed;
		}
	} catch (err) {
		log.warn("payslip: leave balance lookup failed", {
			employee_id: employeeId,
			error: String(err),
		});
	}
	const lossOfPayDays = latest
		? Number(latest.loss_of_pay_days) || 0
		: Math.round(leaveLopDays * 100) / 100;

	const now = new Date();
	return {
		...base,
		currency: latest?.currency || "SAR",
		monthlySalary: emp.monthly_salary,
		breakdown: {
			basic: emp.basic_amount,
			housing: emp.housing_allowance,
			transport: emp.transport_allowance,
			other: emp.other_allowance,
		},
		overtime,
		lossOfPayDays,
		salaryAdvance,
		// Employee-level payslip identity
		mode: emp.payment_mode,
		nationalId: emp.national_id,
		band: emp.band,
		location: emp.location,
		// Per-period payslip figures
		periodMonth: latest?.period_month ?? opts.periodMonth ?? now.getMonth() + 1,
		periodYear: latest?.period_year ?? opts.periodYear ?? now.getFullYear(),
		payDate: latest?.pay_date ?? null,
		attendanceDays: latest?.attendance_days ?? null,
		governmentHolidays: latest ? Number(latest.government_holidays) || 0 : 0,
		annualLeaves: latest ? Number(latest.annual_leaves) || 0 : 0,
		sickLeaves: latest ? Number(latest.sick_leaves) || 0 : 0,
		daysPayable: latest ? Number(latest.days_payable) || 30 : 30,
		remoteWorkHalf: latest?.remote_work_half ?? false,
		employeeRequestsDeduction: latest
			? Number(latest.employee_requests_deduction) || 0
			: 0,
	};
}

async function generateLetterForRequest(
	req: EmployeeRequest,
	actorId: string,
	actorName: string | null,
): Promise<string> {
	// Requests submitted by regular employees carry a free-text name with no
	// employee_id. Resolve it against the roster by exact (case-insensitive)
	// name match and backfill the link so future actions are direct.
	let employeeId = req.employee_id;
	if (!employeeId) {
		const { employees } = await billing.listEmployees();
		const target = req.employee_name.trim().toLowerCase();
		const matches = employees.filter(
			(e) => e.name.trim().toLowerCase() === target,
		);
		if (matches.length !== 1) {
			throw new Error(
				matches.length === 0
					? `no employee record matches "${req.employee_name}" — edit the request and select the employee from the list`
					: `multiple employee records match "${req.employee_name}" — edit the request and select the exact employee from the list`,
			);
		}
		employeeId = matches[0].id;
		await db.exec`
			UPDATE employee_requests SET
				employee_id   = ${employeeId},
				customer_id   = COALESCE(customer_id, ${matches[0].customer_id}),
				customer_name = COALESCE(customer_name, ${matches[0].customer_name}),
				updated_at    = NOW()
			WHERE id = ${req.id}
		`;
		await logEvent(
			req.id,
			"employee_linked",
			actorId,
			`matched by name to ${matches[0].name}`,
		);
	}

	const emp = await billing.getEmployeeCompensation({ id: employeeId });

	const { dateOfJoining, dateOfRelieving, jobTitle } =
		await resolveEmploymentDetails(employeeId);

	const employeeCode =
		emp.serial_no != null
			? `INW-${String(emp.serial_no).padStart(4, "0")}`
			: null;

	const base = {
		reference: req.reference,
		employeeName: req.employee_name,
		employeeCode,
		designation: jobTitle ?? emp.position,
		clientName: emp.customer_name,
		dateOfJoining,
		dateOfRelieving,
		purpose: req.request_subtype || null,
	};

	let pdf: Buffer;
	let label: string;
	if (req.request_type === "salary_certificate") {
		const data = await buildSalaryCertificateData(employeeId, emp, base);
		pdf = await generateSalaryCertificate(data);
		label = "Salary_Certificate";
	} else {
		pdf = await generateExperienceLetter(base);
		label = "Experience_Letter";
	}

	const fileName = `${label}-${slugify(req.employee_name)}-${req.reference}.pdf`;
	await db.exec`
		INSERT INTO request_documents (
			id, request_id, document_type, file_name, content_type,
			data_base64, generated_by, generated_by_name
		) VALUES (
			${crypto.randomUUID()}, ${req.id}, ${req.request_type}, ${fileName},
			'application/pdf', ${pdf.toString("base64")}, ${actorId}, ${actorName}
		)
	`;
	await logEvent(req.id, "letter_generated", actorId, fileName);
	return fileName;
}

// ─── Internal: generate a payslip PDF for an employee + period ────────────────
// Used by the payroll service to attach a payslip to the "salary paid" email.
// Not tied to an HR request row; returns the PDF (base64) + the employee's email.

interface GeneratePayslipRequest {
	employee_id: string;
	period_month?: number;
	period_year?: number;
}

interface GeneratePayslipResponse {
	file_name: string;
	data_base64: string;
	employee_name: string;
	employee_email: string | null;
}

export const generateEmployeePayslip = api(
	{ expose: false, auth: false, method: "POST", path: "/internal/payslip" },
	async (req: GeneratePayslipRequest): Promise<GeneratePayslipResponse> => {
		const emp = await billing.getEmployeeCompensation({ id: req.employee_id });
		const { dateOfJoining, dateOfRelieving, jobTitle } =
			await resolveEmploymentDetails(req.employee_id);

		const employeeCode =
			emp.serial_no != null
				? `INW-${String(emp.serial_no).padStart(4, "0")}`
				: null;
		const period =
			req.period_month && req.period_year
				? `${req.period_year}-${String(req.period_month).padStart(2, "0")}`
				: new Date().toISOString().slice(0, 7);

		const base: LetterData = {
			reference: `PAYSLIP-${period}`,
			employeeName: emp.name,
			employeeCode,
			designation: jobTitle ?? emp.position,
			clientName: emp.customer_name,
			dateOfJoining,
			dateOfRelieving,
			purpose: null,
		};

		const data = await buildSalaryCertificateData(req.employee_id, emp, base, {
			periodMonth: req.period_month,
			periodYear: req.period_year,
		});
		const pdf = await generateSalaryCertificate(data);
		const fileName = `Payslip-${slugify(emp.name)}-${period}.pdf`;

		return {
			file_name: fileName,
			data_base64: pdf.toString("base64"),
			employee_name: emp.name,
			employee_email: emp.email,
		};
	},
);

// ─── Create ───────────────────────────────────────────────────────────────────

interface CreateRequestInput {
	request_type: RequestType;
	request_subtype?: string;
	employee_id?: string;
	employee_name: string;
	customer_id?: string;
	customer_name?: string;
	title: string;
	description?: string;
	priority?: RequestPriority;
	required_by_date?: string;
	attachment_url?: string;
}

interface CreateRequestResponse {
	request: EmployeeRequest;
}

export const createRequest = api(
	{ expose: true, method: "POST", path: "/requests", auth: true },
	async (input: CreateRequestInput): Promise<CreateRequestResponse> => {
		const { userID, role } = getAuthData()!;

		const id = crypto.randomUUID();
		const reference = await db.rawQueryRow<{ ref: string }>(
			`SELECT 'REQ-' || EXTRACT(YEAR FROM NOW())::TEXT || '-' || LPAD(NEXTVAL('employee_request_ref_seq')::TEXT, 6, '0') AS ref`,
		);
		const ref = reference!.ref;

		let creatorName: string | null = null;
		try {
			creatorName = (await user.getContact({ id: userID })).name;
		} catch {
			// non-fatal
		}

		await db.exec`
			INSERT INTO employee_requests (
				id, reference, request_type, request_subtype,
				employee_id, employee_name, customer_id, customer_name,
				title, description, priority, required_by_date,
				attachment_url, status, created_by, created_by_name
			) VALUES (
				${id}, ${ref}, ${input.request_type}, ${input.request_subtype ?? null},
				${input.employee_id ?? null}, ${input.employee_name},
				${input.customer_id ?? null}, ${input.customer_name ?? null},
				${input.title}, ${input.description ?? null},
				${input.priority ?? "normal"}, ${input.required_by_date ?? null},
				${input.attachment_url ?? null}, 'submitted',
				${userID}, ${creatorName}
			)
		`;

		await logEvent(id, "submitted", userID);

		const req = await fetchRequest(id);

		// Notify managers/admins
		const typeLabel =
			REQUEST_TYPE_LABELS[input.request_type] ?? input.request_type;
		const html = emailShell(
			`New HR Request: ${input.title}`,
			row("Reference", ref) +
				row("Type", typeLabel) +
				row("Employee", input.employee_name) +
				row("Priority", (input.priority ?? "normal").toUpperCase()) +
				row("Submitted by", creatorName ?? userID),
		);
		notifyRoles(
			["manager", "admin"],
			`[HR Request] ${typeLabel} — ${input.employee_name}`,
			html,
		);

		return { request: req };
	},
);

// ─── List ─────────────────────────────────────────────────────────────────────

interface ListRequestsInput {
	status?: RequestStatus;
	request_type?: RequestType;
	employee_id?: string;
	employee_name?: string;
	year?: number;
	month?: number;
	mine?: boolean;
	limit?: number;
	offset?: number;
}

interface ListRequestsResponse {
	requests: EmployeeRequest[];
	total: number;
}

export const listRequests = api(
	{ expose: true, method: "GET", path: "/requests", auth: true },
	async (input: ListRequestsInput): Promise<ListRequestsResponse> => {
		const { userID, role } = getAuthData()!;

		const limit = Math.min(input.limit ?? 100, 500);
		const offset = input.offset ?? 0;

		const clauses: string[] = [];
		const args: (string | number | boolean | null)[] = [];
		const add = (clause: string, value: string | number | boolean | null) => {
			args.push(value);
			clauses.push(clause.replace("$?", `$${args.length}`));
		};

		// BDMs see ONLY requests for employees tagged to them.
		if (role === "bdm") {
			const { employee_ids } = await billing.getBdmEmployeeIds({
				bdm_user_id: userID,
			});
			if (employee_ids.length === 0) return { requests: [], total: 0 };
			const ph = employee_ids.map((id) => {
				args.push(id);
				return `$${args.length}`;
			});
			clauses.push(`employee_id IN (${ph.join(", ")})`);
		} else if (!isManager(role) || input.mine) {
			// Non-managers see only their own requests
			add("created_by = $?", userID);
		}
		if (input.status) add("status = $?", input.status);
		if (input.request_type) add("request_type = $?", input.request_type);
		if (input.employee_id) add("employee_id = $?", input.employee_id);
		if (input.employee_name)
			add("UPPER(employee_name) LIKE UPPER($?)", `%${input.employee_name}%`);
		if (input.year) add("EXTRACT(YEAR FROM created_at) = $?", input.year);
		if (input.month) add("EXTRACT(MONTH FROM created_at) = $?", input.month);

		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

		const countRow = await db.rawQueryRow<{ cnt: string }>(
			`SELECT COUNT(*)::TEXT AS cnt FROM employee_requests ${where}`,
			...args,
		);
		const total = parseInt(countRow?.cnt ?? "0", 10);

		const pagedArgs = [...args, limit, offset];
		const limitIdx = args.length + 1;
		const offsetIdx = args.length + 2;

		const rows = db.rawQuery<EmployeeRequest>(
			`SELECT ${REQUEST_COLS} FROM employee_requests ${where}
             ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
			...pagedArgs,
		);

		const requests: EmployeeRequest[] = [];
		for await (const r of rows) {
			requests.push(r);
		}

		return { requests, total };
	},
);

// ─── Get ──────────────────────────────────────────────────────────────────────

interface GetRequestResponse {
	request: EmployeeRequest;
}

export const getRequest = api(
	{ expose: true, method: "GET", path: "/requests/:id", auth: true },
	async ({ id }: { id: string }): Promise<GetRequestResponse> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(id);
		if (!isManager(role) && req.created_by !== userID) {
			throw APIError.permissionDenied("access denied");
		}
		return { request: req };
	},
);

// ─── Update ───────────────────────────────────────────────────────────────────

interface UpdateRequestInput {
	id: string;
	title?: string;
	description?: string;
	priority?: RequestPriority;
	required_by_date?: string | null;
	attachment_url?: string | null;
	request_subtype?: string | null;
	// Employee / customer link — lets HR link a free-text request to the
	// roster record so letters can be generated against system data
	employee_id?: string | null;
	employee_name?: string;
	customer_id?: string | null;
	customer_name?: string | null;
	// HR internal notes (manager/admin only)
	notes?: string | null;
}

export const updateRequest = api(
	{ expose: true, method: "PUT", path: "/requests/:id", auth: true },
	async (input: UpdateRequestInput): Promise<GetRequestResponse> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(input.id);

		const isCreator = req.created_by === userID;
		const isMgr = isManager(role);

		if (!isCreator && !isMgr) {
			throw APIError.permissionDenied("access denied");
		}
		// Creator can only edit their own submitted requests
		if (isCreator && !isMgr && req.status !== "submitted") {
			throw APIError.failedPrecondition("can only edit submitted requests");
		}

		// Notes field restricted to managers
		if (input.notes !== undefined && !isMgr) {
			throw APIError.permissionDenied("only managers can update notes");
		}

		await db.exec`
			UPDATE employee_requests SET
				title            = COALESCE(${input.title ?? null}, title),
				description      = COALESCE(${input.description ?? null}, description),
				priority         = COALESCE(${input.priority ?? null}, priority),
				required_by_date = CASE WHEN ${input.required_by_date !== undefined} THEN ${input.required_by_date ?? null} ELSE required_by_date END,
				attachment_url   = CASE WHEN ${input.attachment_url !== undefined} THEN ${input.attachment_url ?? null} ELSE attachment_url END,
				request_subtype  = CASE WHEN ${input.request_subtype !== undefined} THEN ${input.request_subtype ?? null} ELSE request_subtype END,
				employee_id      = CASE WHEN ${input.employee_id !== undefined} THEN ${input.employee_id ?? null} ELSE employee_id END,
				employee_name    = COALESCE(${input.employee_name ?? null}, employee_name),
				customer_id      = CASE WHEN ${input.customer_id !== undefined} THEN ${input.customer_id ?? null} ELSE customer_id END,
				customer_name    = CASE WHEN ${input.customer_name !== undefined} THEN ${input.customer_name ?? null} ELSE customer_name END,
				notes            = CASE WHEN ${input.notes !== undefined} THEN ${input.notes ?? null} ELSE notes END,
				updated_at       = NOW()
			WHERE id = ${input.id}
		`;

		await logEvent(input.id, "updated", userID);
		return { request: await fetchRequest(input.id) };
	},
);

// ─── Review (submitted → in_review) ──────────────────────────────────────────

export const reviewRequest = api(
	{ expose: true, method: "POST", path: "/requests/:id/review", auth: true },
	async ({ id }: { id: string }): Promise<GetRequestResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) {
			throw APIError.permissionDenied("managers only");
		}
		const req = await fetchRequest(id);
		if (req.status !== "submitted") {
			throw APIError.failedPrecondition(
				`cannot review a ${req.status} request`,
			);
		}

		await db.exec`
			UPDATE employee_requests
			SET status = 'in_review', reviewed_by = ${userID}, reviewed_at = NOW(), updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "in_review", userID);

		// Notify creator
		const typeLabel = REQUEST_TYPE_LABELS[req.request_type] ?? req.request_type;
		const html = emailShell(
			`Your request is now in review`,
			row("Reference", req.reference) +
				row("Type", typeLabel) +
				row("Status", "In Review"),
		);
		notifyUser(
			req.created_by,
			`[HR Request] In Review — ${req.reference}`,
			html,
		);

		return { request: await fetchRequest(id) };
	},
);

// ─── Complete ─────────────────────────────────────────────────────────────────

interface CompleteRequestInput {
	id: string;
	completion_notes?: string;
}

export const completeRequest = api(
	{ expose: true, method: "POST", path: "/requests/:id/complete", auth: true },
	async (input: CompleteRequestInput): Promise<GetRequestResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) {
			throw APIError.permissionDenied("managers only");
		}
		const req = await fetchRequest(input.id);
		if (!["submitted", "in_review"].includes(req.status)) {
			throw APIError.failedPrecondition(
				`cannot complete a ${req.status} request`,
			);
		}

		await db.exec`
			UPDATE employee_requests
			SET status = 'completed',
			    completed_by = ${userID},
			    completed_at = NOW(),
			    completion_notes = ${input.completion_notes ?? null},
			    updated_at = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "completed", userID, input.completion_notes);

		// Auto-generate the letter for letter-type requests. A failure here must
		// not roll back the completion — it is logged on the audit trail and the
		// letter can be retried via POST /requests/:id/generate-letter.
		let letterGenerated = false;
		if (LETTER_REQUEST_TYPES.includes(req.request_type)) {
			try {
				let actorName: string | null = null;
				try {
					actorName = (await user.getContact({ id: userID })).name;
				} catch {
					// non-fatal
				}
				await generateLetterForRequest(req, userID, actorName);
				letterGenerated = true;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log.error("letter generation failed", {
					request_id: input.id,
					error: msg,
				});
				await logEvent(input.id, "letter_generation_failed", userID, msg);
			}
		}

		// Notify creator
		const typeLabel = REQUEST_TYPE_LABELS[req.request_type] ?? req.request_type;
		const html = emailShell(
			`Your request has been completed`,
			row("Reference", req.reference) +
				row("Type", typeLabel) +
				row("Status", "Completed") +
				(letterGenerated
					? row("Document", "Your letter is ready — download it from the Employee Requests page in the ERP portal")
					: "") +
				(input.completion_notes ? row("Notes", input.completion_notes) : ""),
		);
		notifyUser(
			req.created_by,
			`[HR Request] Completed — ${req.reference}`,
			html,
		);

		return { request: await fetchRequest(input.id) };
	},
);

// ─── Generate / regenerate letter (manager) ──────────────────────────────────

interface GenerateLetterResponse {
	request: EmployeeRequest;
	file_name: string;
}

export const generateRequestLetter = api(
	{ expose: true, method: "POST", path: "/requests/:id/generate-letter", auth: true },
	async ({ id }: { id: string }): Promise<GenerateLetterResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) {
			throw APIError.permissionDenied("managers only");
		}
		const req = await fetchRequest(id);
		if (!LETTER_REQUEST_TYPES.includes(req.request_type)) {
			throw APIError.invalidArgument(
				"letters can only be generated for experience letter and salary certificate requests",
			);
		}
		if (["rejected", "cancelled"].includes(req.status)) {
			throw APIError.failedPrecondition(
				`cannot generate a letter for a ${req.status} request`,
			);
		}

		let actorName: string | null = null;
		try {
			actorName = (await user.getContact({ id: userID })).name;
		} catch {
			// non-fatal
		}

		try {
			const fileName = await generateLetterForRequest(req, userID, actorName);
			return { request: await fetchRequest(id), file_name: fileName };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await logEvent(id, "letter_generation_failed", userID, msg);
			throw APIError.failedPrecondition(msg);
		}
	},
);

// ─── Download generated letter ───────────────────────────────────────────────

export const downloadRequestDocument = api.raw(
	{ expose: true, auth: true, method: "GET", path: "/requests/:id/document" },
	async (req, resp) => {
		const { userID, role } = getAuthData()!;

		const match = (req.url ?? "").match(/\/requests\/([^/]+)\/document/);
		const id = match?.[1];
		if (!id) {
			resp.writeHead(400, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "invalid request id" }));
			return;
		}

		const request = await db.rawQueryRow<{ created_by: string }>(
			`SELECT created_by FROM employee_requests WHERE id = $1`,
			id,
		);
		if (!request) {
			resp.writeHead(404, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "request not found" }));
			return;
		}
		if (!isManager(role) && request.created_by !== userID) {
			resp.writeHead(403, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "access denied" }));
			return;
		}

		const doc = await db.rawQueryRow<{
			file_name: string;
			content_type: string;
			data_base64: string;
		}>(
			`SELECT file_name, content_type, data_base64
             FROM request_documents
             WHERE request_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
			id,
		);
		if (!doc) {
			resp.writeHead(404, { "Content-Type": "application/json" });
			resp.end(JSON.stringify({ message: "no document has been generated for this request" }));
			return;
		}

		const buf = Buffer.from(doc.data_base64, "base64");
		resp.writeHead(200, {
			"Content-Type": doc.content_type,
			"Content-Disposition": `attachment; filename="${doc.file_name}"`,
			"Content-Length": buf.length,
		});
		resp.end(buf);
	},
);

// ─── Reject ───────────────────────────────────────────────────────────────────

interface RejectRequestInput {
	id: string;
	reason?: string;
}

export const rejectRequest = api(
	{ expose: true, method: "POST", path: "/requests/:id/reject", auth: true },
	async (input: RejectRequestInput): Promise<GetRequestResponse> => {
		const { userID, role } = getAuthData()!;
		if (!isManager(role)) {
			throw APIError.permissionDenied("managers only");
		}
		const req = await fetchRequest(input.id);
		if (!["submitted", "in_review"].includes(req.status)) {
			throw APIError.failedPrecondition(
				`cannot reject a ${req.status} request`,
			);
		}

		await db.exec`
			UPDATE employee_requests
			SET status = 'rejected',
			    rejected_by = ${userID},
			    rejected_at = NOW(),
			    rejection_reason = ${input.reason ?? null},
			    updated_at = NOW()
			WHERE id = ${input.id}
		`;
		await logEvent(input.id, "rejected", userID, input.reason);

		// Notify creator
		const typeLabel = REQUEST_TYPE_LABELS[req.request_type] ?? req.request_type;
		const html = emailShell(
			`Your request was not approved`,
			row("Reference", req.reference) +
				row("Type", typeLabel) +
				row("Status", "Rejected") +
				(input.reason ? row("Reason", input.reason) : ""),
		);
		notifyUser(
			req.created_by,
			`[HR Request] Rejected — ${req.reference}`,
			html,
		);

		return { request: await fetchRequest(input.id) };
	},
);

// ─── Cancel ───────────────────────────────────────────────────────────────────

export const cancelRequest = api(
	{ expose: true, method: "POST", path: "/requests/:id/cancel", auth: true },
	async ({ id }: { id: string }): Promise<GetRequestResponse> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(id);

		const isCreator = req.created_by === userID;
		if (!isCreator && !isAdmin(role)) {
			throw APIError.permissionDenied("only the creator or admin can cancel");
		}
		if (["completed", "rejected", "cancelled"].includes(req.status)) {
			throw APIError.failedPrecondition(
				`cannot cancel a ${req.status} request`,
			);
		}

		await db.exec`
			UPDATE employee_requests
			SET status = 'cancelled', updated_at = NOW()
			WHERE id = ${id}
		`;
		await logEvent(id, "cancelled", userID);

		return { request: await fetchRequest(id) };
	},
);

// ─── Delete (super_admin only) ────────────────────────────────────────────────

export const deleteRequest = api(
	{ expose: true, method: "DELETE", path: "/requests/:id", auth: true },
	async ({ id }: { id: string }): Promise<{ success: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin") {
			throw APIError.permissionDenied("super_admin only");
		}
		await db.exec`DELETE FROM employee_requests WHERE id = ${id}`;
		return { success: true };
	},
);

// ─── Events ───────────────────────────────────────────────────────────────────

interface ListRequestEventsResponse {
	events: RequestEvent[];
}

export const listRequestEvents = api(
	{ expose: true, method: "GET", path: "/requests/:id/events", auth: true },
	async ({ id }: { id: string }): Promise<ListRequestEventsResponse> => {
		const { userID, role } = getAuthData()!;
		const req = await fetchRequest(id);
		if (!isManager(role) && req.created_by !== userID) {
			throw APIError.permissionDenied("access denied");
		}

		const rows = db.rawQuery<RequestEvent>(
			`SELECT id, request_id, action, performed_by, note, created_at
             FROM employee_request_events
             WHERE request_id = $1
             ORDER BY created_at ASC`,
			id,
		);
		const events: RequestEvent[] = [];
		for await (const r of rows) events.push(r);

		return { events };
	},
);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface RequestStatsResponse {
	total: number;
	submitted: number;
	in_review: number;
	completed: number;
	rejected: number;
	cancelled: number;
	completed_this_month: number;
}

export const requestStats = api(
	{ expose: true, method: "GET", path: "/requests-stats", auth: true },
	async (): Promise<RequestStatsResponse> => {
		const { userID, role } = getAuthData()!;
		const scope = isManager(role) ? "" : `WHERE created_by = '${userID}'`;

		const row = await db.rawQueryRow<{
			total: string;
			submitted: string;
			in_review: string;
			completed: string;
			rejected: string;
			cancelled: string;
			completed_this_month: string;
		}>(
			`SELECT
				COUNT(*)::TEXT                                                      AS total,
				COUNT(*) FILTER (WHERE status = 'submitted')::TEXT                 AS submitted,
				COUNT(*) FILTER (WHERE status = 'in_review')::TEXT                 AS in_review,
				COUNT(*) FILTER (WHERE status = 'completed')::TEXT                 AS completed,
				COUNT(*) FILTER (WHERE status = 'rejected')::TEXT                  AS rejected,
				COUNT(*) FILTER (WHERE status = 'cancelled')::TEXT                 AS cancelled,
				COUNT(*) FILTER (
					WHERE status = 'completed'
					  AND DATE_TRUNC('month', completed_at) = DATE_TRUNC('month', NOW())
				)::TEXT AS completed_this_month
			FROM employee_requests ${scope}`,
		);

		const s = row!;
		return {
			total: parseInt(s.total, 10),
			submitted: parseInt(s.submitted, 10),
			in_review: parseInt(s.in_review, 10),
			completed: parseInt(s.completed, 10),
			rejected: parseInt(s.rejected, 10),
			cancelled: parseInt(s.cancelled, 10),
			completed_this_month: parseInt(s.completed_this_month, 10),
		};
	},
);
