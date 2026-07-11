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
			req.name, req.short_name,
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
			`SELECT COUNT(*)::int AS count FROM employees WHERE customer_id = $1`, req.id,
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
        e.billing_months_override,
        c.id                                                         AS customer_id,
        c.name                                                       AS customer_name,
        c.short_name                                                 AS customer_short_name,
        c.billing_months_per_year,
        COALESCE(e.billing_months_override, c.billing_months_per_year) AS effective_billing_months,
        COALESCE(s.monthly_amount, 0)::float8                         AS monthly_salary,
        COALESCE(br.monthly_rate, 0)::float8                          AS monthly_billing,
        COALESCE(br.annual_amount, 0)::float8                         AS annual_billing,
        COALESCE(br.billing_year, ${year})                           AS billing_year
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
      INSERT INTO employees (name, position, customer_id, billing_months_override, serial_no)
      VALUES (
        ${req.name}, ${req.position}, ${req.customer_id},
        ${req.billing_months_override ?? null},
        ${req.serial_no ?? null}
      )
      RETURNING id
    `;

		// Insert salary for current month/year
		await db.exec`
      INSERT INTO salaries (employee_id, customer_id, monthly_amount, effective_month, effective_year)
      VALUES (${emp!.id}, ${req.customer_id}, ${req.monthly_salary}, ${month}, ${year})
      ON CONFLICT (employee_id, effective_month, effective_year)
      DO UPDATE SET monthly_amount = EXCLUDED.monthly_amount
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
        e.billing_months_override,
        c.id                                                         AS customer_id,
        c.name                                                       AS customer_name,
        c.short_name                                                 AS customer_short_name,
        c.billing_months_per_year,
        COALESCE(e.billing_months_override, c.billing_months_per_year) AS effective_billing_months,
        COALESCE(s.monthly_amount, 0)                                AS monthly_salary,
        COALESCE(br.monthly_rate, 0)                                 AS monthly_billing,
        COALESCE(br.annual_amount, 0)                                AS annual_billing,
        COALESCE(br.billing_year, ${year})                           AS billing_year
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
        billing_months_override = ${billingMonthsOverride}
      WHERE id = ${id}
    `;

		// Update salary if provided
		if (req.monthly_salary !== undefined) {
			await db.exec`
        INSERT INTO salaries (employee_id, customer_id, monthly_amount, effective_month, effective_year)
        VALUES (${id}, ${customerId}, ${req.monthly_salary}, ${month}, ${year})
        ON CONFLICT (employee_id, effective_month, effective_year)
        DO UPDATE SET monthly_amount = EXCLUDED.monthly_amount
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
        e.billing_months_override,
        c.id                                                         AS customer_id,
        c.name                                                       AS customer_name,
        c.short_name                                                 AS customer_short_name,
        c.billing_months_per_year,
        COALESCE(e.billing_months_override, c.billing_months_per_year) AS effective_billing_months,
        COALESCE(s.monthly_amount, 0)                                AS monthly_salary,
        COALESCE(br.monthly_rate, 0)                                 AS monthly_billing,
        COALESCE(br.annual_amount, 0)                                AS annual_billing,
        COALESCE(br.billing_year, ${year})                           AS billing_year
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
