import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { Topic, Subscription } from "encore.dev/pubsub";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { UserCreatedTopic } from "../user/user";
import log from "encore.dev/log";

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
      INSERT INTO employees (name, position, customer_id, billing_months_override, serial_no, mobile_number, email)
      VALUES (
        ${req.name}, ${req.position}, ${req.customer_id},
        ${req.billing_months_override ?? null},
        ${req.serial_no ?? null},
        ${req.mobile_number ?? null}, ${req.email ?? null}
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
        email                  = CASE WHEN ${req.email !== undefined} THEN ${req.email ?? null} ELSE email END
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
        s.other_allowance::float8     AS other_allowance
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
