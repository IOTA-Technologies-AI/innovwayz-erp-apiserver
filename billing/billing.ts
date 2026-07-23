import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { Topic, Subscription } from "encore.dev/pubsub";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { CronJob } from "encore.dev/cron";
import { user } from "~encore/clients";
import { UserCreatedTopic } from "../user/user";
import log from "encore.dev/log";
import crypto from "node:crypto";

const db = new SQLDatabase("billing", {
	migrations: "./migrations",
});

export interface PlanChangedEvent {
	user_id: string;
	old_plan: string;
	new_plan: string;
}

export const PlanChangedTopic = new Topic<PlanChangedEvent>("plan-changed", {
	deliveryGuarantee: "at-least-once",
});

// Auto-create a free plan when a new user signs up.
const _ = new Subscription(UserCreatedTopic, "create-free-plan", {
	handler: async (event) => {
		log.info("creating free plan for new user", { user_id: event.user_id });

		await db.exec`
      INSERT INTO subscriptions (user_id, plan, status)
      VALUES (${event.user_id}, 'free', 'active')
      ON CONFLICT (user_id) DO NOTHING
    `;
	},
});

interface SubscriptionInfo {
	id: number;
	user_id: string;
	plan: string;
	status: string;
	created_at: string;
	updated_at: string;
}

// Get billing info for the authenticated user.
export const get = api(
	{ expose: true, auth: true, method: "GET", path: "/billing" },
	async (): Promise<SubscriptionInfo> => {
		const { userID: user_id } = getAuthData()!;
		const row = await db.queryRow<SubscriptionInfo>`
      SELECT id, user_id, plan, status, created_at, updated_at
      FROM subscriptions WHERE user_id = ${user_id}
    `;
		if (!row) throw APIError.notFound("no subscription found");
		return row;
	},
);

interface UpgradeRequest {
	plan: string;
}

// Upgrade the authenticated user's subscription plan. Options: free, pro, enterprise.
export const upgrade = api(
	{ expose: true, auth: true, method: "POST", path: "/billing/upgrade" },
	async ({ plan }: UpgradeRequest): Promise<SubscriptionInfo> => {
		const { userID: user_id } = getAuthData()!;
		const valid = ["free", "pro", "enterprise"];
		if (!valid.includes(plan)) {
			throw APIError.invalidArgument(
				`plan must be one of: ${valid.join(", ")}`,
			);
		}

		const current = await db.queryRow<{ plan: string }>`
      SELECT plan FROM subscriptions WHERE user_id = ${user_id}
    `;
		if (!current) throw APIError.notFound("no subscription found");

		await db.exec`
      UPDATE subscriptions
      SET plan = ${plan}, updated_at = NOW()
      WHERE user_id = ${user_id}
    `;

		await PlanChangedTopic.publish({
			user_id,
			old_plan: current.plan,
			new_plan: plan,
		});

		const row = await db.queryRow<SubscriptionInfo>`
      SELECT id, user_id, plan, status, created_at, updated_at
      FROM subscriptions WHERE user_id = ${user_id}
    `;
		return row!;
	},
);

// ─── Customers ───────────────────────────────────────────────────────────────

interface Customer {
	id: string;
	name: string;
	short_name: string;
	billing_months_per_year: number;
	notes: string | null;
	created_at: string;
}

interface ListCustomersResponse {
	customers: Customer[];
}

export const listCustomers = api(
	{ expose: true, auth: true, method: "GET", path: "/customers" },
	async (): Promise<ListCustomersResponse> => {
		const rows = db.query<Customer>`
      SELECT id::text, name, short_name, billing_months_per_year, notes, created_at
      FROM customers ORDER BY name
    `;
		const customers: Customer[] = [];
		for await (const row of rows) customers.push(row);
		return { customers };
	},
);

export const createCustomer = api(
	{ expose: true, auth: true, method: "POST", path: "/customers" },
	async (req: {
		name: string;
		short_name: string;
		billing_months_per_year?: number;
		notes?: string;
	}): Promise<Customer> => {
		const { role } = getAuthData()!;
		if (!["admin", "super_admin"].includes(role))
			throw APIError.permissionDenied("Admin only");
		if (!req.name || !req.short_name)
			throw APIError.invalidArgument("name and short_name are required");

		const row = await db.rawQueryRow<Customer>(
			`INSERT INTO customers (name, short_name, billing_months_per_year, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id::text, name, short_name, billing_months_per_year, notes, created_at`,
			req.name,
			req.short_name,
			req.billing_months_per_year ?? 12,
			req.notes ?? null,
		);
		return row!;
	},
);

export const updateCustomer = api(
	{ expose: true, auth: true, method: "PUT", path: "/customers/:id" },
	async (req: {
		id: string;
		name?: string;
		short_name?: string;
		billing_months_per_year?: number;
		notes?: string;
	}): Promise<Customer> => {
		const { role } = getAuthData()!;
		if (!["admin", "super_admin"].includes(role))
			throw APIError.permissionDenied("Admin only");

		const existing = await db.rawQueryRow<Customer>(
			`SELECT id::text, name, short_name, billing_months_per_year, notes, created_at FROM customers WHERE id = $1`,
			req.id,
		);
		if (!existing) throw APIError.notFound("Customer not found");

		const row = await db.rawQueryRow<Customer>(
			`UPDATE customers SET
         name = $2, short_name = $3,
         billing_months_per_year = $4, notes = $5
       WHERE id = $1
       RETURNING id::text, name, short_name, billing_months_per_year, notes, created_at`,
			req.id,
			req.name ?? existing.name,
			req.short_name ?? existing.short_name,
			req.billing_months_per_year ?? existing.billing_months_per_year,
			req.notes !== undefined ? req.notes : existing.notes,
		);
		return row!;
	},
);

export const deleteCustomer = api(
	{ expose: true, auth: true, method: "DELETE", path: "/customers/:id" },
	async (req: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (role !== "super_admin")
			throw APIError.permissionDenied("Super Admin only");
		// Prevent deletion if employees are assigned
		const empCount = await db.rawQueryRow<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM employees WHERE customer_id = $1`,
			req.id,
		);
		if ((empCount?.count ?? 0) > 0)
			throw APIError.failedPrecondition(
				`Cannot delete: ${empCount!.count} employee(s) are assigned to this customer`,
			);
		await db.exec`DELETE FROM customers WHERE id = ${req.id}`;
		return { ok: true };
	},
);

// ─── Employees ───────────────────────────────────────────────────────────────

interface EmployeeWithDetails {
	id: string;
	serial_no: number;
	name: string;
	position: string;
	customer_id: string;
	customer_name: string;
	customer_short_name: string;
	billing_months_per_year: number;
	billing_months_override: number | null;
	effective_billing_months: number;
	monthly_salary: number;
	monthly_billing: number;
	annual_billing: number;
	billing_year: number;
	// Optional salary component breakdown (payslip structure)
	basic_amount: number | null;
	housing_allowance: number | null;
	transport_allowance: number | null;
	other_allowance: number | null;
	// Contact (for the self-service timesheet portal)
	mobile_number: string | null;
	email: string | null;
	// Payslip identity fields
	national_id: string | null;
	band: string | null;
	location: string | null;
	payment_mode: string | null;
	// Profile
	nationality: string | null;
	family_status: string | null;
}

interface ListEmployeesResponse {
	employees: EmployeeWithDetails[];
}

export const listEmployees = api(
	{ expose: true, auth: true, method: "GET", path: "/employees" },
	async (): Promise<ListEmployeesResponse> => {
		const year = new Date().getFullYear();
		const rows = db.query<EmployeeWithDetails>`
      SELECT
        e.id, e.serial_no, e.name, e.position,
        e.mobile_number, e.email,
        e.national_id, e.band, e.location, e.payment_mode,
        e.nationality, e.family_status,
        e.billing_months_override,
        c.id                                                         AS customer_id,
        c.name                                                       AS customer_name,
        c.short_name                                                 AS customer_short_name,
        c.billing_months_per_year,
        COALESCE(e.billing_months_override, c.billing_months_per_year) AS effective_billing_months,
        COALESCE(s.monthly_amount, 0)::float8                         AS monthly_salary,
        COALESCE(br.monthly_rate, 0)::float8                          AS monthly_billing,
        COALESCE(br.annual_amount, 0)::float8                         AS annual_billing,
        COALESCE(br.billing_year, ${year})                           AS billing_year,
        s.basic_amount::float8                                        AS basic_amount,
        s.housing_allowance::float8                                   AS housing_allowance,
        s.transport_allowance::float8                                 AS transport_allowance,
        s.other_allowance::float8                                     AS other_allowance
      FROM employees e
      JOIN customers c ON e.customer_id = c.id
      LEFT JOIN salaries s
        ON s.employee_id = e.id AND s.effective_year = ${year}
      LEFT JOIN billing_records br
        ON br.employee_id = e.id AND br.billing_year = ${year}
      ORDER BY e.serial_no
    `;
		const employees: EmployeeWithDetails[] = [];
		for await (const row of rows) employees.push(row);
		return { employees };
	},
);

interface CreateEmployeeRequest {
	serial_no?: number;
	name: string;
	position: string;
	customer_id: string;
	billing_months_override?: number;
	monthly_salary: number;
	monthly_billing: number;
	// Optional salary component breakdown (should sum to monthly_salary)
	basic_amount?: number;
	housing_allowance?: number;
	transport_allowance?: number;
	other_allowance?: number;
	// Contact
	mobile_number?: string;
	email?: string;
	// Payslip identity fields
	national_id?: string;
	band?: string;
	location?: string;
	payment_mode?: string;
	// Profile
	nationality?: string;
	family_status?: string;
}

export const createEmployee = api(
	{ expose: true, auth: true, method: "POST", path: "/employees" },
	async (req: CreateEmployeeRequest): Promise<EmployeeWithDetails> => {
		const year = new Date().getFullYear();
		const month = new Date().getMonth() + 1;

		// Fetch customer to compute billing months
		const customer = await db.queryRow<Customer>`
      SELECT id, name, short_name, billing_months_per_year, notes
      FROM customers WHERE id = ${req.customer_id}
    `;
		if (!customer) throw APIError.notFound("customer not found");

		const effectiveBillingMonths =
			req.billing_months_override ?? customer.billing_months_per_year;
		const annualBilling = req.monthly_billing * effectiveBillingMonths;

		// Insert employee
		const emp = await db.queryRow<{ id: string }>`
      INSERT INTO employees (
        name, position, customer_id, billing_months_override, serial_no,
        mobile_number, email, national_id, band, location, payment_mode,
        nationality, family_status
      )
      VALUES (
        ${req.name}, ${req.position}, ${req.customer_id},
        ${req.billing_months_override ?? null},
        ${req.serial_no ?? null},
        ${req.mobile_number ?? null}, ${req.email ?? null},
        ${req.national_id ?? null}, ${req.band ?? null},
        ${req.location ?? null}, ${req.payment_mode ?? null},
        ${req.nationality ?? null}, ${req.family_status ?? null}
      )
      RETURNING id
    `;

		// Insert salary for current month/year
		await db.exec`
      INSERT INTO salaries (
        employee_id, customer_id, monthly_amount, effective_month, effective_year,
        basic_amount, housing_allowance, transport_allowance, other_allowance
      )
      VALUES (
        ${emp!.id}, ${req.customer_id}, ${req.monthly_salary}, ${month}, ${year},
        ${req.basic_amount ?? null}, ${req.housing_allowance ?? null},
        ${req.transport_allowance ?? null}, ${req.other_allowance ?? null}
      )
      ON CONFLICT (employee_id, effective_month, effective_year)
      DO UPDATE SET
        monthly_amount      = EXCLUDED.monthly_amount,
        basic_amount        = EXCLUDED.basic_amount,
        housing_allowance   = EXCLUDED.housing_allowance,
        transport_allowance = EXCLUDED.transport_allowance,
        other_allowance     = EXCLUDED.other_allowance
    `;

		// Insert billing record for current year
		await db.exec`
      INSERT INTO billing_records (employee_id, customer_id, monthly_rate, billing_months, annual_amount, billing_year)
      VALUES (${emp!.id}, ${req.customer_id}, ${req.monthly_billing}, ${effectiveBillingMonths}, ${annualBilling}, ${year})
      ON CONFLICT (employee_id, billing_year)
      DO UPDATE SET
        monthly_rate   = EXCLUDED.monthly_rate,
        billing_months = EXCLUDED.billing_months,
        annual_amount  = EXCLUDED.annual_amount
    `;

		// Return full record
		const result = await db.queryRow<EmployeeWithDetails>`
      SELECT
        e.id, e.serial_no, e.name, e.position,
        e.mobile_number, e.email,
        e.national_id, e.band, e.location, e.payment_mode,
        e.nationality, e.family_status,
        e.billing_months_override,
        c.id                                                         AS customer_id,
        c.name                                                       AS customer_name,
        c.short_name                                                 AS customer_short_name,
        c.billing_months_per_year,
        COALESCE(e.billing_months_override, c.billing_months_per_year) AS effective_billing_months,
        COALESCE(s.monthly_amount, 0)                                AS monthly_salary,
        COALESCE(br.monthly_rate, 0)                                 AS monthly_billing,
        COALESCE(br.annual_amount, 0)                                AS annual_billing,
        COALESCE(br.billing_year, ${year})                           AS billing_year,
        s.basic_amount::float8                                       AS basic_amount,
        s.housing_allowance::float8                                  AS housing_allowance,
        s.transport_allowance::float8                                AS transport_allowance,
        s.other_allowance::float8                                    AS other_allowance
      FROM employees e
      JOIN customers c ON e.customer_id = c.id
      LEFT JOIN salaries s
        ON s.employee_id = e.id AND s.effective_year = ${year}
      LEFT JOIN billing_records br
        ON br.employee_id = e.id AND br.billing_year = ${year}
      WHERE e.id = ${emp!.id}
    `;
		return result!;
	},
);

interface UpdateEmployeeRequest {
	id: string;
	name?: string;
	position?: string;
	customer_id?: string;
	billing_months_override?: number | null;
	monthly_salary?: number;
	monthly_billing?: number;
	// Optional salary component breakdown (should sum to monthly_salary)
	basic_amount?: number | null;
	housing_allowance?: number | null;
	transport_allowance?: number | null;
	other_allowance?: number | null;
	// Contact
	mobile_number?: string | null;
	email?: string | null;
	// Payslip identity fields
	national_id?: string | null;
	band?: string | null;
	location?: string | null;
	payment_mode?: string | null;
	// Profile
	nationality?: string | null;
	family_status?: string | null;
}

export const updateEmployee = api(
	{ expose: true, auth: true, method: "PUT", path: "/employees/:id" },
	async ({
		id,
		...req
	}: UpdateEmployeeRequest): Promise<EmployeeWithDetails> => {
		const year = new Date().getFullYear();
		const month = new Date().getMonth() + 1;

		// Fetch current employee
		const current = await db.queryRow<{
			customer_id: string;
			billing_months_override: number | null;
		}>`
      SELECT customer_id, billing_months_override FROM employees WHERE id = ${id}
    `;
		if (!current) throw APIError.notFound("employee not found");

		const customerId = req.customer_id ?? current.customer_id;
		const billingMonthsOverride =
			req.billing_months_override !== undefined
				? req.billing_months_override
				: current.billing_months_override;

		// Update employee fields
		await db.exec`
      UPDATE employees SET
        name                   = COALESCE(${req.name ?? null}, name),
        position               = COALESCE(${req.position ?? null}, position),
        customer_id            = ${customerId},
        billing_months_override = ${billingMonthsOverride},
        mobile_number          = CASE WHEN ${req.mobile_number !== undefined} THEN ${req.mobile_number ?? null} ELSE mobile_number END,
        email                  = CASE WHEN ${req.email !== undefined} THEN ${req.email ?? null} ELSE email END,
        national_id            = CASE WHEN ${req.national_id !== undefined} THEN ${req.national_id ?? null} ELSE national_id END,
        band                   = CASE WHEN ${req.band !== undefined} THEN ${req.band ?? null} ELSE band END,
        location               = CASE WHEN ${req.location !== undefined} THEN ${req.location ?? null} ELSE location END,
        payment_mode           = CASE WHEN ${req.payment_mode !== undefined} THEN ${req.payment_mode ?? null} ELSE payment_mode END,
        nationality            = CASE WHEN ${req.nationality !== undefined} THEN ${req.nationality ?? null} ELSE nationality END,
        family_status          = CASE WHEN ${req.family_status !== undefined} THEN ${req.family_status ?? null} ELSE family_status END
      WHERE id = ${id}
    `;

		// Update salary if provided
		if (req.monthly_salary !== undefined) {
			await db.exec`
        INSERT INTO salaries (
          employee_id, customer_id, monthly_amount, effective_month, effective_year,
          basic_amount, housing_allowance, transport_allowance, other_allowance
        )
        VALUES (
          ${id}, ${customerId}, ${req.monthly_salary}, ${month}, ${year},
          ${req.basic_amount ?? null}, ${req.housing_allowance ?? null},
          ${req.transport_allowance ?? null}, ${req.other_allowance ?? null}
        )
        ON CONFLICT (employee_id, effective_month, effective_year)
        DO UPDATE SET
          monthly_amount      = EXCLUDED.monthly_amount,
          basic_amount        = COALESCE(EXCLUDED.basic_amount, salaries.basic_amount),
          housing_allowance   = COALESCE(EXCLUDED.housing_allowance, salaries.housing_allowance),
          transport_allowance = COALESCE(EXCLUDED.transport_allowance, salaries.transport_allowance),
          other_allowance     = COALESCE(EXCLUDED.other_allowance, salaries.other_allowance)
      `;
		}

		// Update billing if provided
		if (req.monthly_billing !== undefined) {
			const customer = await db.queryRow<{ billing_months_per_year: number }>`
        SELECT billing_months_per_year FROM customers WHERE id = ${customerId}
      `;
			const effectiveBillingMonths =
				billingMonthsOverride ?? customer!.billing_months_per_year;
			const annualBilling = req.monthly_billing * effectiveBillingMonths;

			await db.exec`
        INSERT INTO billing_records (employee_id, customer_id, monthly_rate, billing_months, annual_amount, billing_year)
        VALUES (${id}, ${customerId}, ${req.monthly_billing}, ${effectiveBillingMonths}, ${annualBilling}, ${year})
        ON CONFLICT (employee_id, billing_year)
        DO UPDATE SET
          customer_id    = EXCLUDED.customer_id,
          monthly_rate   = EXCLUDED.monthly_rate,
          billing_months = EXCLUDED.billing_months,
          annual_amount  = EXCLUDED.annual_amount
      `;
		}

		// Return updated record
		const result = await db.queryRow<EmployeeWithDetails>`
      SELECT
        e.id, e.serial_no, e.name, e.position,
        e.mobile_number, e.email,
        e.national_id, e.band, e.location, e.payment_mode,
        e.nationality, e.family_status,
        e.billing_months_override,
        c.id                                                         AS customer_id,
        c.name                                                       AS customer_name,
        c.short_name                                                 AS customer_short_name,
        c.billing_months_per_year,
        COALESCE(e.billing_months_override, c.billing_months_per_year) AS effective_billing_months,
        COALESCE(s.monthly_amount, 0)                                AS monthly_salary,
        COALESCE(br.monthly_rate, 0)                                 AS monthly_billing,
        COALESCE(br.annual_amount, 0)                                AS annual_billing,
        COALESCE(br.billing_year, ${year})                           AS billing_year,
        s.basic_amount::float8                                       AS basic_amount,
        s.housing_allowance::float8                                  AS housing_allowance,
        s.transport_allowance::float8                                AS transport_allowance,
        s.other_allowance::float8                                    AS other_allowance
      FROM employees e
      JOIN customers c ON e.customer_id = c.id
      LEFT JOIN salaries s
        ON s.employee_id = e.id AND s.effective_year = ${year}
      LEFT JOIN billing_records br
        ON br.employee_id = e.id AND br.billing_year = ${year}
      WHERE e.id = ${id}
    `;
		return result!;
	},
);
// ─── Employee lookup by mobile (internal – timesheet portal auth) ───────────

export interface EmployeeContact {
	id: string;
	name: string;
	position: string;
	customer_id: string;
	customer_name: string;
	mobile_number: string | null;
	email: string | null;
}

/**
 * Internal endpoint used by the timesheet portal to resolve an employee
 * from the mobile number they log in with. Returns null-safe not-found.
 */
export const getEmployeeByMobile = api(
	// Internal-only (expose:false) and auth:false so it can be called from the
	// unauthenticated timesheet-portal OTP flow.
	{ expose: false, auth: false, method: "GET", path: "/internal/employees/by-mobile/:mobile" },
	async ({ mobile }: { mobile: string }): Promise<EmployeeContact> => {
		const normalized = mobile.replace(/[\s-]/g, "");
		const row = await db.queryRow<EmployeeContact>`
      SELECT e.id, e.name, e.position, e.mobile_number, e.email,
             c.id AS customer_id, c.name AS customer_name
      FROM employees e
      JOIN customers c ON e.customer_id = c.id
      WHERE REPLACE(REPLACE(e.mobile_number, ' ', ''), '-', '') = ${normalized}
    `;
		if (!row) throw APIError.notFound("no employee found with that mobile number");
		return row;
	},
);

// ─── Employee compensation (internal – letter generation) ───────────────────

export interface EmployeeCompensation {
	id: string;
	serial_no: number | null;
	name: string;
	position: string;
	customer_id: string;
	customer_name: string;
	employee_since: string;
	monthly_salary: number | null;
	salary_month: number | null;
	salary_year: number | null;
	basic_amount: number | null;
	housing_allowance: number | null;
	transport_allowance: number | null;
	other_allowance: number | null;
	// Payslip identity fields
	national_id: string | null;
	band: string | null;
	location: string | null;
	payment_mode: string | null;
	// Contact — used to email the payslip to the employee
	email: string | null;
}

/**
 * Internal endpoint used by the request service to assemble
 * experience letters / salary certificates. Returns the employee
 * with their most recent salary record (latest period wins).
 */
export const getEmployeeCompensation = api(
	{ expose: false, auth: true, method: "GET", path: "/internal/employees/:id/compensation" },
	async ({ id }: { id: string }): Promise<EmployeeCompensation> => {
		const row = await db.queryRow<EmployeeCompensation>`
      SELECT
        e.id, e.serial_no, e.name, e.position,
        c.id                          AS customer_id,
        c.name                        AS customer_name,
        e.created_at::TEXT            AS employee_since,
        s.monthly_amount::float8      AS monthly_salary,
        s.effective_month             AS salary_month,
        s.effective_year              AS salary_year,
        s.basic_amount::float8        AS basic_amount,
        s.housing_allowance::float8   AS housing_allowance,
        s.transport_allowance::float8 AS transport_allowance,
        s.other_allowance::float8     AS other_allowance,
        e.national_id, e.band, e.location, e.payment_mode, e.email
      FROM employees e
      JOIN customers c ON e.customer_id = c.id
      LEFT JOIN LATERAL (
        SELECT * FROM salaries s
        WHERE s.employee_id = e.id
        ORDER BY s.effective_year DESC, s.effective_month DESC
        LIMIT 1
      ) s ON TRUE
      WHERE e.id = ${id}
    `;
		if (!row) throw APIError.notFound("employee not found");
		return row;
	},
);

// ─── BDM ↔ Employee Assignments ───────────────────────────────────────────────

export interface BdmAssignment {
	bdm_user_id: string;
	employee_id: string;
	employee_name: string;
	customer_name: string | null;
	assigned_by: string | null;
	assigned_at: string;
}

/** Admin: list all BDM→employee assignments (optionally filter by BDM). */
export const listBdmAssignments = api(
	{ expose: true, auth: true, method: "GET", path: "/bdm/assignments" },
	async (req: {
		bdm_user_id?: string;
	}): Promise<{ assignments: BdmAssignment[] }> => {
		const { role } = getAuthData()!;
		if (!["admin", "super_admin"].includes(role))
			throw APIError.permissionDenied("Admin only");

		const rows = db.rawQuery<BdmAssignment>(
			`SELECT a.bdm_user_id, a.employee_id::text, e.name AS employee_name,
              c.name AS customer_name, a.assigned_by, a.assigned_at
         FROM bdm_assignments a
         JOIN employees e ON e.id = a.employee_id
         LEFT JOIN customers c ON c.id = e.customer_id
         WHERE ($1::text IS NULL OR a.bdm_user_id = $1)
         ORDER BY e.name`,
			req.bdm_user_id ?? null,
		);
		const assignments: BdmAssignment[] = [];
		for await (const row of rows) assignments.push(row);
		return { assignments };
	},
);

/** BDM: get my own assigned employees. */
export const getMyBdmEmployees = api(
	{ expose: true, auth: true, method: "GET", path: "/bdm/my-employees" },
	async (): Promise<{ assignments: BdmAssignment[] }> => {
		const { userID } = getAuthData()!;
		const rows = db.rawQuery<BdmAssignment>(
			`SELECT a.bdm_user_id, a.employee_id::text, e.name AS employee_name,
              c.name AS customer_name, a.assigned_by, a.assigned_at
         FROM bdm_assignments a
         JOIN employees e ON e.id = a.employee_id
         LEFT JOIN customers c ON c.id = e.customer_id
         WHERE a.bdm_user_id = $1
         ORDER BY e.name`,
			userID,
		);
		const assignments: BdmAssignment[] = [];
		for await (const row of rows) assignments.push(row);
		return { assignments };
	},
);

/** Admin: assign one or more employees to a BDM (upsert). */
export const assignEmployeesToBdm = api(
	{ expose: true, auth: true, method: "POST", path: "/bdm/assignments" },
	async (req: {
		bdm_user_id: string;
		employee_ids: string[];
	}): Promise<{ assigned: number }> => {
		const { userID, role } = getAuthData()!;
		if (!["admin", "super_admin"].includes(role))
			throw APIError.permissionDenied("Admin only");
		if (!req.employee_ids.length)
			throw APIError.invalidArgument("employee_ids must not be empty");

		let assigned = 0;
		for (const empId of req.employee_ids) {
			await db.exec`
        INSERT INTO bdm_assignments (bdm_user_id, employee_id, assigned_by)
        VALUES (${req.bdm_user_id}, ${empId}::uuid, ${userID})
        ON CONFLICT (bdm_user_id, employee_id) DO NOTHING
      `;
			assigned++;
		}
		return { assigned };
	},
);

/** Admin: remove an employee from a BDM. */
export const removeEmployeeFromBdm = api(
	{
		expose: true,
		auth: true,
		method: "DELETE",
		path: "/bdm/assignments/:bdmUserId/:employeeId",
	},
	async (req: {
		bdmUserId: string;
		employeeId: string;
	}): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!["admin", "super_admin"].includes(role))
			throw APIError.permissionDenied("Admin only");
		await db.exec`
      DELETE FROM bdm_assignments
      WHERE bdm_user_id = ${req.bdmUserId} AND employee_id = ${req.employeeId}::uuid
    `;
		return { ok: true };
	},
);

// ─── Employee allied documents ────────────────────────────────────────────────
// Iqama, Insurance, GOSI, Saudi Council of Engineers cert, air ticket, passport,
// … each with an expiry_date that drives renewal reminders (Phase 3 cron).

function isHrManager(role: string): boolean {
	return ["manager", "admin", "super_admin"].includes(role);
}

export interface EmployeeDocument {
	id: string;
	employee_id: string;
	document_type: string;
	document_number: string | null;
	issue_date: string | null;
	expiry_date: string | null;
	status: string;
	notes: string | null;
	has_file: boolean;
	approved_by: string | null;
	approved_at: string | null;
	rejected_by: string | null;
	rejected_at: string | null;
	rejection_reason: string | null;
	created_by: string | null;
	created_at: string;
	updated_at: string;
}

// file_base64 is excluded from list/detail payloads (heavy) — fetched separately.
const DOC_COLS = `
  id, employee_id, document_type, document_number,
  issue_date::TEXT  AS issue_date,
  expiry_date::TEXT AS expiry_date,
  status, notes,
  (file_base64 IS NOT NULL) AS has_file,
  approved_by, approved_at, rejected_by, rejected_at, rejection_reason,
  created_by, created_at, updated_at
`;

export const listEmployeeDocuments = api(
	{ expose: true, auth: true, method: "GET", path: "/employees/:employeeId/documents" },
	async ({ employeeId }: { employeeId: string }): Promise<{ documents: EmployeeDocument[] }> => {
		getAuthData()!;
		const rows = db.rawQuery<EmployeeDocument>(
			`SELECT ${DOC_COLS} FROM employee_documents
			 WHERE employee_id = $1::uuid
			 ORDER BY expiry_date NULLS LAST, document_type`,
			employeeId,
		);
		const documents: EmployeeDocument[] = [];
		for await (const r of rows) documents.push(r);
		return { documents };
	},
);

interface UpsertDocumentInput {
	employeeId: string;
	document_type: string;
	document_number?: string | null;
	issue_date?: string | null;
	expiry_date?: string | null;
	status?: string;
	notes?: string | null;
	file_base64?: string | null;
}

export const createEmployeeDocument = api(
	{ expose: true, auth: true, method: "POST", path: "/employees/:employeeId/documents" },
	async (req: UpsertDocumentInput): Promise<EmployeeDocument> => {
		const { userID, role } = getAuthData()!;
		if (!isHrManager(role)) throw APIError.permissionDenied("managers only");
		if (!req.document_type)
			throw APIError.invalidArgument("document_type is required");
		const id = crypto.randomUUID();
		await db.exec`
			INSERT INTO employee_documents (
				id, employee_id, document_type, document_number,
				issue_date, expiry_date, status, notes, file_base64, created_by
			) VALUES (
				${id}, ${req.employeeId}::uuid, ${req.document_type}, ${req.document_number ?? null},
				${req.issue_date ?? null}, ${req.expiry_date ?? null},
				${req.status ?? "active"}, ${req.notes ?? null}, ${req.file_base64 ?? null}, ${userID}
			)
		`;
		return fetchDocument(id);
	},
);

interface UpdateDocumentInput {
	id: string;
	document_type?: string;
	document_number?: string | null;
	issue_date?: string | null;
	expiry_date?: string | null;
	status?: string;
	notes?: string | null;
	file_base64?: string | null;
}

export const updateEmployeeDocument = api(
	{ expose: true, auth: true, method: "PUT", path: "/employee-documents/:id" },
	async (req: UpdateDocumentInput): Promise<EmployeeDocument> => {
		const { role } = getAuthData()!;
		if (!isHrManager(role)) throw APIError.permissionDenied("managers only");
		// Changing the expiry resets the reminder-dedup stamps so alerts re-fire
		// for the new date.
		const resetAlerts = req.expiry_date !== undefined;
		await db.exec`
			UPDATE employee_documents SET
				document_type   = COALESCE(${req.document_type ?? null}, document_type),
				document_number = CASE WHEN ${req.document_number !== undefined} THEN ${req.document_number ?? null} ELSE document_number END,
				issue_date      = CASE WHEN ${req.issue_date !== undefined} THEN ${req.issue_date ?? null} ELSE issue_date END,
				expiry_date     = CASE WHEN ${req.expiry_date !== undefined} THEN ${req.expiry_date ?? null} ELSE expiry_date END,
				status          = COALESCE(${req.status ?? null}, status),
				notes           = CASE WHEN ${req.notes !== undefined} THEN ${req.notes ?? null} ELSE notes END,
				file_base64     = CASE WHEN ${req.file_base64 !== undefined} THEN ${req.file_base64 ?? null} ELSE file_base64 END,
				alert_90_sent_at    = CASE WHEN ${resetAlerts} THEN NULL ELSE alert_90_sent_at END,
				alert_60_sent_at    = CASE WHEN ${resetAlerts} THEN NULL ELSE alert_60_sent_at END,
				alert_30_sent_at    = CASE WHEN ${resetAlerts} THEN NULL ELSE alert_30_sent_at END,
				breach_notified_at  = CASE WHEN ${resetAlerts} THEN NULL ELSE breach_notified_at END,
				last_daily_alert_at = CASE WHEN ${resetAlerts} THEN NULL ELSE last_daily_alert_at END,
				updated_at      = NOW()
			WHERE id = ${req.id}::uuid
		`;
		return fetchDocument(req.id);
	},
);

export const deleteEmployeeDocument = api(
	{ expose: true, auth: true, method: "DELETE", path: "/employee-documents/:id" },
	async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!isHrManager(role)) throw APIError.permissionDenied("managers only");
		await db.exec`DELETE FROM employee_documents WHERE id = ${id}::uuid`;
		return { ok: true };
	},
);

export const getEmployeeDocumentFile = api(
	{ expose: true, auth: true, method: "GET", path: "/employee-documents/:id/file" },
	async ({ id }: { id: string }): Promise<{ file_base64: string | null }> => {
		getAuthData()!;
		const row = await db.rawQueryRow<{ file_base64: string | null }>(
			`SELECT file_base64 FROM employee_documents WHERE id = $1::uuid`,
			id,
		);
		if (!row) throw APIError.notFound("document not found");
		return { file_base64: row.file_base64 };
	},
);

async function fetchDocument(id: string): Promise<EmployeeDocument> {
	const row = await db.rawQueryRow<EmployeeDocument>(
		`SELECT ${DOC_COLS} FROM employee_documents WHERE id = $1::uuid`,
		id,
	);
	if (!row) throw APIError.notFound("document not found");
	return row;
}

// ─── Family members ───────────────────────────────────────────────────────────

export interface FamilyMember {
	id: string;
	employee_id: string;
	name: string;
	relationship: string | null;
	is_dependent: boolean;
	id_number: string | null;
	date_of_birth: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

const FAMILY_COLS = `
  id, employee_id, name, relationship, is_dependent, id_number,
  date_of_birth::TEXT AS date_of_birth, notes, created_at, updated_at
`;

export const listFamilyMembers = api(
	{ expose: true, auth: true, method: "GET", path: "/employees/:employeeId/family" },
	async ({ employeeId }: { employeeId: string }): Promise<{ members: FamilyMember[] }> => {
		getAuthData()!;
		const rows = db.rawQuery<FamilyMember>(
			`SELECT ${FAMILY_COLS} FROM family_members WHERE employee_id = $1::uuid ORDER BY created_at`,
			employeeId,
		);
		const members: FamilyMember[] = [];
		for await (const r of rows) members.push(r);
		return { members };
	},
);

interface UpsertFamilyInput {
	employeeId: string;
	name: string;
	relationship?: string | null;
	is_dependent?: boolean;
	id_number?: string | null;
	date_of_birth?: string | null;
	notes?: string | null;
}

export const createFamilyMember = api(
	{ expose: true, auth: true, method: "POST", path: "/employees/:employeeId/family" },
	async (req: UpsertFamilyInput): Promise<FamilyMember> => {
		const { role } = getAuthData()!;
		if (!isHrManager(role)) throw APIError.permissionDenied("managers only");
		if (!req.name) throw APIError.invalidArgument("name is required");
		const id = crypto.randomUUID();
		await db.exec`
			INSERT INTO family_members (
				id, employee_id, name, relationship, is_dependent, id_number, date_of_birth, notes
			) VALUES (
				${id}, ${req.employeeId}::uuid, ${req.name}, ${req.relationship ?? null},
				${req.is_dependent ?? true}, ${req.id_number ?? null}, ${req.date_of_birth ?? null}, ${req.notes ?? null}
			)
		`;
		return fetchFamilyMember(id);
	},
);

interface UpdateFamilyInput {
	id: string;
	name?: string;
	relationship?: string | null;
	is_dependent?: boolean;
	id_number?: string | null;
	date_of_birth?: string | null;
	notes?: string | null;
}

export const updateFamilyMember = api(
	{ expose: true, auth: true, method: "PUT", path: "/family-members/:id" },
	async (req: UpdateFamilyInput): Promise<FamilyMember> => {
		const { role } = getAuthData()!;
		if (!isHrManager(role)) throw APIError.permissionDenied("managers only");
		await db.exec`
			UPDATE family_members SET
				name          = COALESCE(${req.name ?? null}, name),
				relationship  = CASE WHEN ${req.relationship !== undefined} THEN ${req.relationship ?? null} ELSE relationship END,
				is_dependent  = COALESCE(${req.is_dependent ?? null}, is_dependent),
				id_number     = CASE WHEN ${req.id_number !== undefined} THEN ${req.id_number ?? null} ELSE id_number END,
				date_of_birth = CASE WHEN ${req.date_of_birth !== undefined} THEN ${req.date_of_birth ?? null} ELSE date_of_birth END,
				notes         = CASE WHEN ${req.notes !== undefined} THEN ${req.notes ?? null} ELSE notes END,
				updated_at    = NOW()
			WHERE id = ${req.id}::uuid
		`;
		return fetchFamilyMember(req.id);
	},
);

export const deleteFamilyMember = api(
	{ expose: true, auth: true, method: "DELETE", path: "/family-members/:id" },
	async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
		const { role } = getAuthData()!;
		if (!isHrManager(role)) throw APIError.permissionDenied("managers only");
		await db.exec`DELETE FROM family_members WHERE id = ${id}::uuid`;
		return { ok: true };
	},
);

async function fetchFamilyMember(id: string): Promise<FamilyMember> {
	const row = await db.rawQueryRow<FamilyMember>(
		`SELECT ${FAMILY_COLS} FROM family_members WHERE id = $1::uuid`,
		id,
	);
	if (!row) throw APIError.notFound("family member not found");
	return row;
}

// ─── Document renewal alerts + approval workflow ──────────────────────────────
// Daily cron emails the responsible BDM/Account Manager (from bdm_assignments,
// falling back to admins) as each tracked document nears expiry: 90/60/30 days
// then a breach notice + daily reminders, deduped via the alert_*_sent_at
// columns (same pattern as the contract expiry cron).

const DOC_TYPE_LABEL: Record<string, string> = {
	Iqama: "Iqama",
	Insurance: "Medical Insurance",
	GOSI: "GOSI",
	Saudi_Council_Engineers: "Saudi Council of Engineers",
	Air_Ticket: "Annual Air Ticket",
	Passport: "Passport",
	Other: "Document",
};

function docLabel(t: string): string {
	return DOC_TYPE_LABEL[t] ?? t;
}

function docEmailShell(heading: string, rows: string): string {
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
        <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function drow(label: string, value: string): string {
	return `<tr>
    <td style="padding:6px 0;color:#64748b;font-size:13px;width:40%;">${label}</td>
    <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${value}</td>
  </tr>`;
}

/** Responsible recipients for an employee: assigned BDMs, then admins. */
async function resolveDocRecipients(employeeId: string): Promise<string[]> {
	const ids = new Set<string>();
	const rows = db.rawQuery<{ bdm_user_id: string }>(
		`SELECT bdm_user_id FROM bdm_assignments WHERE employee_id = $1::uuid`,
		employeeId,
	);
	for await (const r of rows) ids.add(r.bdm_user_id);
	try {
		const { users } = await user.listByRoles({
			roles: ["admin", "super_admin"],
		});
		for (const u of users) ids.add(u.id);
	} catch (err) {
		log.warn("doc alerts: admin lookup failed", { error: String(err) });
	}
	return [...ids];
}

interface AlertRow {
	id: string;
	employee_id: string;
	employee_name: string;
	document_type: string;
	document_number: string | null;
	expiry_date: string;
	days_remaining: number;
	alert_90_sent_at: string | null;
	alert_60_sent_at: string | null;
	alert_30_sent_at: string | null;
	breach_notified_at: string | null;
	last_daily_alert_at: string | null;
}

/** Which alert tier (if any) to fire for a document this run. */
function pickAlertTier(
	d: AlertRow,
	today: string,
): { column: string; tone: string } | null {
	const days = d.days_remaining;
	if (days <= 0) {
		if (!d.breach_notified_at) return { column: "breach_notified_at", tone: "breach" };
		// Already breached — one daily reminder at most.
		if (!d.last_daily_alert_at || d.last_daily_alert_at.slice(0, 10) < today)
			return { column: "last_daily_alert_at", tone: "daily" };
		return null;
	}
	if (days <= 30 && !d.alert_30_sent_at) return { column: "alert_30_sent_at", tone: "30" };
	if (days <= 60 && !d.alert_60_sent_at) return { column: "alert_60_sent_at", tone: "60" };
	if (days <= 90 && !d.alert_90_sent_at) return { column: "alert_90_sent_at", tone: "90" };
	return null;
}

/** Optional `status` SET clause to reflect the document's expiry state. */
function docStatusClause(days: number): string {
	if (days <= 0) return ", status = 'expired'";
	if (days <= 30)
		return ", status = CASE WHEN status = 'active' THEN 'expiring' ELSE status END";
	return "";
}

/** Build the alert email (subject + html) for a document about to expire. */
function buildDocAlert(d: AlertRow): { subject: string; html: string } {
	const days = d.days_remaining;
	const label = docLabel(d.document_type);
	const expired = days <= 0;
	const heading = expired
		? `EXPIRED: ${label} — ${d.employee_name}`
		: `${label} expiring in ${days} days — ${d.employee_name}`;
	const html = docEmailShell(
		heading,
		drow("Employee", d.employee_name) +
			drow("Document", label) +
			(d.document_number ? drow("Number", d.document_number) : "") +
			drow("Expiry", d.expiry_date) +
			drow(
				"Status",
				expired ? `Expired ${-days} day(s) ago` : `${days} day(s) remaining`,
			),
	);
	const subject = expired
		? `[Renewal] EXPIRED — ${label} — ${d.employee_name}`
		: `[Renewal] ${label} expiring in ${days}d — ${d.employee_name}`;
	return { subject, html };
}

async function runDocumentRenewalAlerts(): Promise<{
	checked: number;
	notified: number;
}> {
	const today = new Date().toISOString().slice(0, 10);
	const rows = db.rawQuery<AlertRow>(
		`SELECT d.id, d.employee_id, e.name AS employee_name,
		        d.document_type, d.document_number,
		        d.expiry_date::TEXT AS expiry_date,
		        (d.expiry_date - CURRENT_DATE)::int AS days_remaining,
		        d.alert_90_sent_at::TEXT AS alert_90_sent_at,
		        d.alert_60_sent_at::TEXT AS alert_60_sent_at,
		        d.alert_30_sent_at::TEXT AS alert_30_sent_at,
		        d.breach_notified_at::TEXT AS breach_notified_at,
		        d.last_daily_alert_at::TEXT AS last_daily_alert_at
		 FROM employee_documents d
		 JOIN employees e ON e.id = d.employee_id
		 WHERE d.expiry_date IS NOT NULL
		   AND d.status <> 'renewed'
		   AND d.expiry_date <= CURRENT_DATE + INTERVAL '90 days'`,
	);

	let checked = 0;
	let notified = 0;
	for await (const d of rows) {
		checked++;
		const tier = pickAlertTier(d, today);
		if (!tier) continue;

		const { subject, html } = buildDocAlert(d);
		const recipients = await resolveDocRecipients(d.employee_id);
		await Promise.all(
			recipients.map((uid) =>
				user.sendNotification({ to: uid, subject, html }).catch(() => {}),
			),
		);
		// Stamp the dedup column and reflect the expiry status.
		await db.rawExec(
			`UPDATE employee_documents SET ${tier.column} = NOW()${docStatusClause(d.days_remaining)}, updated_at = NOW() WHERE id = $1::uuid`,
			d.id,
		);
		if (recipients.length > 0) notified++;
	}
	return { checked, notified };
}

// Internal endpoint invoked by the daily cron.
export const checkDocumentRenewalsCron = api(
	{ expose: false, method: "POST", path: "/internal/employee-documents/alerts/cron" },
	async (): Promise<{ checked: number; notified: number }> => {
		const res = await runDocumentRenewalAlerts();
		log.info("document renewal alerts run", res);
		return res;
	},
);

const _docAlertCron = new CronJob("employee-document-renewals", {
	title: "Employee document renewal alerts (90/60/30 days + breach)",
	schedule: "0 8 * * *",
	endpoint: checkDocumentRenewalsCron,
});

// Manual trigger for testing (admin only).
export const triggerDocumentRenewals = api(
	{ expose: true, auth: true, method: "POST", path: "/employee-documents/alerts/run" },
	async (): Promise<{ checked: number; notified: number }> => {
		const { role } = getAuthData()!;
		if (!["admin", "super_admin"].includes(role))
			throw APIError.permissionDenied("admin only");
		return runDocumentRenewalAlerts();
	},
);

// ─── Renewal approval workflow ────────────────────────────────────────────────
// Ensures a document renewal is approved before its expiry: a renewal is
// requested (→ pending_renewal, notifies approvers), then approved (records the
// new expiry, resets alerts, → active) or rejected.

export const requestDocumentRenewal = api(
	{ expose: true, auth: true, method: "POST", path: "/employee-documents/:id/request-renewal" },
	async ({ id }: { id: string }): Promise<EmployeeDocument> => {
		const { role } = getAuthData()!;
		if (!isHrManager(role)) throw APIError.permissionDenied("managers only");
		const doc = await fetchDocument(id);
		await db.exec`
			UPDATE employee_documents
			SET status = 'pending_renewal', rejected_by = NULL, rejected_at = NULL,
			    rejection_reason = NULL, updated_at = NOW()
			WHERE id = ${id}::uuid
		`;
		const emp = await db.queryRow<{ name: string }>`
			SELECT name FROM employees WHERE id = ${doc.employee_id}::uuid
		`;
		const html = docEmailShell(
			"Document renewal requested — approval needed",
			drow("Employee", emp?.name ?? "—") +
				drow("Document", docLabel(doc.document_type)) +
				drow("Current expiry", doc.expiry_date ?? "—"),
		);
		try {
			const { users } = await user.listByRoles({
				roles: ["admin", "super_admin"],
			});
			await Promise.all(
				users.map((u) =>
					user
						.sendNotification({
							to: u.id,
							subject: `[Renewal] Approval needed — ${docLabel(doc.document_type)} — ${emp?.name ?? ""}`,
							html,
						})
						.catch(() => {}),
				),
			);
		} catch {
			/* non-fatal */
		}
		return fetchDocument(id);
	},
);

interface ApproveRenewalInput {
	id: string;
	/** New expiry date once renewed (YYYY-MM-DD). */
	new_expiry_date?: string;
	document_number?: string;
}

export const approveDocumentRenewal = api(
	{ expose: true, auth: true, method: "POST", path: "/employee-documents/:id/approve-renewal" },
	async (req: ApproveRenewalInput): Promise<EmployeeDocument> => {
		const { userID, role } = getAuthData()!;
		if (!["admin", "super_admin", "manager"].includes(role))
			throw APIError.permissionDenied("approver role required");
		// Approving records the new expiry, clears the reminder stamps so alerts
		// re-arm for the new date, and returns the document to active.
		await db.exec`
			UPDATE employee_documents SET
				expiry_date     = COALESCE(${req.new_expiry_date ?? null}, expiry_date),
				document_number = COALESCE(${req.document_number ?? null}, document_number),
				status          = 'active',
				approved_by     = ${userID}, approved_at = NOW(),
				rejected_by     = NULL, rejected_at = NULL, rejection_reason = NULL,
				alert_90_sent_at = NULL, alert_60_sent_at = NULL, alert_30_sent_at = NULL,
				breach_notified_at = NULL, last_daily_alert_at = NULL,
				updated_at      = NOW()
			WHERE id = ${req.id}::uuid
		`;
		const doc = await fetchDocument(req.id);
		// Notify the responsible BDM/AM that it is cleared.
		const recipients = await resolveDocRecipients(doc.employee_id);
		const html = docEmailShell(
			"Document renewal approved",
			drow("Document", docLabel(doc.document_type)) +
				drow("New expiry", doc.expiry_date ?? "—"),
		);
		await Promise.all(
			recipients.map((uid) =>
				user
					.sendNotification({
						to: uid,
						subject: `[Renewal] Approved — ${docLabel(doc.document_type)}`,
						html,
					})
					.catch(() => {}),
			),
		);
		return doc;
	},
);

interface RejectRenewalInput {
	id: string;
	reason?: string;
}

export const rejectDocumentRenewal = api(
	{ expose: true, auth: true, method: "POST", path: "/employee-documents/:id/reject-renewal" },
	async (req: RejectRenewalInput): Promise<EmployeeDocument> => {
		const { userID, role } = getAuthData()!;
		if (!["admin", "super_admin", "manager"].includes(role))
			throw APIError.permissionDenied("approver role required");
		await db.exec`
			UPDATE employee_documents SET
				status = 'active', rejected_by = ${userID}, rejected_at = NOW(),
				rejection_reason = ${req.reason ?? null}, updated_at = NOW()
			WHERE id = ${req.id}::uuid
		`;
		return fetchDocument(req.id);
	},
);
