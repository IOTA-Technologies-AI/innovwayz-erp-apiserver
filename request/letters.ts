// ─────────────────────────────────────────────────────────────────────────────
// HR letter generation — Experience Letter & Salary Certificate.
//
// Renders branded A4 PDFs with pdfkit using the InnovWayz letterhead
// (logo, blue accent, registered address) mirroring the payslip design.
// Pure functions: data in → PDF Buffer out. No DB or network access here.
// ─────────────────────────────────────────────────────────────────────────────

import PDFDocument from "pdfkit";
import { LOGO_PNG_BASE64 } from "./logoAsset";

// ─── Company / branding constants ────────────────────────────────────────────

export const COMPANY = {
	name: "InnovWayz Technologies",
	addressLine1: "Building No: 9353, Office # 2, Shaddad Al Fahri, Farazdaq Street",
	addressLine2: "Al Malaz, Riyadh – 12642, Kingdom of Saudi Arabia",
	website: "www.innovwayz.com",
	email: "hr@innovwayz.com",
	signatoryTitle: "Human Resources Department",
} as const;

const BRAND = {
	navy: "#16437E", // headings / dark accents
	blue: "#1E63B0", // primary band colour (payslip blue)
	sky: "#2E8FE8", // light accent
	ink: "#1A2433", // body text
	gray: "#5B6B7F", // secondary text
	faint: "#8A97A6", // footer text
	line: "#DFE7F1", // hairlines
	panel: "#F4F8FC", // details panel fill
} as const;

const PAGE = {
	width: 595.28, // A4 portrait
	height: 841.89,
	marginX: 60,
	footerTop: 738,
} as const;

const CONTENT_W = PAGE.width - PAGE.marginX * 2;
const LOGO = Buffer.from(LOGO_PNG_BASE64, "base64");

// ─── Input data ──────────────────────────────────────────────────────────────

export interface LetterData {
	/** Request reference, printed on the letter (e.g. REQ-2026-000123). */
	reference: string;
	/** Issue date (defaults to now). */
	issueDate?: Date;
	employeeName: string;
	/** Formatted employee code, e.g. INW-0007. */
	employeeCode?: string | null;
	designation: string;
	/** Client the employee is deployed with (optional mention). */
	clientName?: string | null;
	/** ISO dates (YYYY-MM-DD). */
	dateOfJoining?: string | null;
	dateOfRelieving?: string | null;
	/** Purpose stated on the request (e.g. "Bank loan", "Embassy – Schengen visa"). */
	purpose?: string | null;
}

export interface SalaryCertificateData extends LetterData {
	currency: string;
	/** Gross monthly salary (excluding overtime/additions). */
	monthlySalary: number;
	breakdown?: {
		basic: number | null;
		housing: number | null;
		transport: number | null;
		other: number | null;
	} | null;
	/** Current-period overtime / other additions (from payroll). */
	overtime?: number;
	/** Excess leave days beyond the allowed quota (drives the loss-of-pay line). */
	lossOfPayDays?: number;
	/** Current-period salary advance recovered (from payroll). */
	salaryAdvance?: number;

	// ── Payslip fields ──────────────────────────────────────────────────────
	/** Pay-period month (1-12) and year for the "MONTH-YEAR" header. */
	periodMonth?: number;
	periodYear?: number;
	/** Salary disbursement date (ISO). */
	payDate?: string | null;
	/** Payment mode, e.g. "Bank Transfer". */
	mode?: string | null;
	/** Government ID / Iqama number ("ID #"). */
	nationalId?: string | null;
	/** Internal grade/band, e.g. "A2". */
	band?: string | null;
	/** Duty station, e.g. "Riyadh, Saudi Arabia". */
	location?: string | null;
	attendanceDays?: number | null;
	governmentHolidays?: number;
	annualLeaves?: number;
	sickLeaves?: number;
	/** Payroll days in the month (default 30). */
	daysPayable?: number;
	/** "Remote Work-50% Salary Applied" — halves the gross when true. */
	remoteWorkHalf?: boolean;
	/** "Employee Requests — CoC / Exit-Re-Entry etc." recovered this period. */
	employeeRequestsDeduction?: number;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmtLongDate(d: Date): string {
	return d.toLocaleDateString("en-GB", {
		day: "2-digit",
		month: "long",
		year: "numeric",
	});
}

function fmtShortDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
	});
}

function fmtMoney(n: number): string {
	return n.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

const MONTHS_UPPER = [
	"JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
	"JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

/** Pay-period label for the payslip header, e.g. "JUNE-2026". */
function monthYearLabel(month: number, year: number): string {
	return `${MONTHS_UPPER[month - 1] ?? month}-${year}`;
}

/** dd-MMM-yyyy with dashes, e.g. "01-Jul-2026". */
function fmtDashDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d
		.toLocaleDateString("en-GB", {
			day: "2-digit",
			month: "short",
			year: "numeric",
		})
		.replace(/\s+/g, "-");
}

/** First (given) name, for the softer body sentences. */
function firstName(full: string): string {
	return full.trim().split(/\s+/)[0] ?? full;
}

const ONES = [
	"", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
	"Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
	"Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
	"", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty",
	"Ninety",
];

/** Integer → English words (sufficient for salary figures). */
export function numberToWords(n: number): string {
	if (n === 0) return "Zero";
	const chunk = (x: number): string => {
		let out = "";
		if (x >= 100) {
			out += `${ONES[Math.floor(x / 100)]} Hundred`;
			x %= 100;
			if (x) out += " ";
		}
		if (x >= 20) {
			out += TENS[Math.floor(x / 10)];
			x %= 10;
			if (x) out += ` ${ONES[x]}`;
		} else if (x > 0) {
			out += ONES[x];
		}
		return out;
	};
	const parts: string[] = [];
	const scales: Array<[number, string]> = [
		[1_000_000_000, "Billion"],
		[1_000_000, "Million"],
		[1_000, "Thousand"],
	];
	let rest = Math.floor(Math.abs(n));
	for (const [value, label] of scales) {
		if (rest >= value) {
			parts.push(`${chunk(Math.floor(rest / value))} ${label}`);
			rest %= value;
		}
	}
	if (rest > 0) parts.push(chunk(rest));
	return parts.join(" ");
}

// ─── Shared layout pieces ────────────────────────────────────────────────────

function drawLetterhead(doc: PDFKit.PDFDocument, reference: string, issueDate: Date): number {
	const { marginX } = PAGE;

	// Logo + wordmark
	doc.image(LOGO, marginX, 44, { width: 42 });
	doc
		.font("Helvetica-Bold")
		.fontSize(15.5)
		.fillColor(BRAND.navy)
		.text("InnovWayz", marginX + 52, 50, { continued: true })
		.fillColor(BRAND.sky)
		.text(" Technologies");
	doc
		.font("Helvetica")
		.fontSize(8)
		.fillColor(BRAND.gray)
		.text("Riyadh  •  Kingdom of Saudi Arabia", marginX + 52, 69);

	// Contact block, right-aligned
	doc
		.fontSize(8)
		.fillColor(BRAND.gray)
		.text(COMPANY.website, marginX, 52, { width: CONTENT_W, align: "right" })
		.text(COMPANY.email, marginX, 63, { width: CONTENT_W, align: "right" });

	// Two-tone brand rule
	doc.rect(marginX, 96, CONTENT_W - 110, 2.5).fill(BRAND.blue);
	doc.rect(marginX + CONTENT_W - 110, 96, 110, 2.5).fill(BRAND.sky);

	// Reference / date row
	doc
		.font("Helvetica-Bold")
		.fontSize(9)
		.fillColor(BRAND.ink)
		.text(`Ref: ${reference}`, marginX, 112);
	doc
		.font("Helvetica")
		.fontSize(9)
		.fillColor(BRAND.ink)
		.text(`Date: ${fmtLongDate(issueDate)}`, marginX, 112, {
			width: CONTENT_W,
			align: "right",
		});

	return 148; // y where content starts
}

function drawTitle(doc: PDFKit.PDFDocument, title: string, y: number, subtitle?: string): number {
	doc
		.font("Helvetica-Bold")
		.fontSize(13.5)
		.fillColor(BRAND.navy)
		.text(title.toUpperCase(), PAGE.marginX, y, {
			width: CONTENT_W,
			align: "center",
			characterSpacing: 2.5,
		});
	let next = y + 24;
	if (subtitle) {
		doc
			.font("Helvetica-Bold")
			.fontSize(10)
			.fillColor(BRAND.gray)
			.text(subtitle.toUpperCase(), PAGE.marginX, next, {
				width: CONTENT_W,
				align: "center",
				characterSpacing: 1.2,
			});
		next += 22;
	}
	return next + 8;
}

/** Xebia-style label/value details panel. Returns the y below the panel. */
function drawDetailsPanel(
	doc: PDFKit.PDFDocument,
	rows: Array<[string, string]>,
	y: number,
): number {
	const padX = 18;
	const padY = 14;
	const rowH = 21;
	const h = rows.length * rowH + padY * 2 - 6;

	doc.roundedRect(PAGE.marginX, y, CONTENT_W, h, 6).fill(BRAND.panel);
	doc
		.roundedRect(PAGE.marginX, y, CONTENT_W, h, 6)
		.lineWidth(0.8)
		.stroke(BRAND.line);

	let ry = y + padY;
	for (const [label, value] of rows) {
		doc
			.font("Helvetica-Bold")
			.fontSize(9.5)
			.fillColor(BRAND.gray)
			.text(label, PAGE.marginX + padX, ry, { width: 150 });
		doc
			.font("Helvetica")
			.fontSize(9.5)
			.fillColor(BRAND.ink)
			.text(`:  ${value}`, PAGE.marginX + padX + 150, ry, {
				width: CONTENT_W - padX * 2 - 150,
			});
		ry += rowH;
	}
	return y + h + 24;
}

function drawParagraphs(doc: PDFKit.PDFDocument, paragraphs: string[], y: number): number {
	doc.font("Helvetica").fontSize(10.5).fillColor(BRAND.ink);
	let cy = y;
	for (const p of paragraphs) {
		doc.text(p, PAGE.marginX, cy, {
			width: CONTENT_W,
			align: "justify",
			lineGap: 3,
		});
		cy = doc.y + 12;
	}
	return cy;
}

function drawSignature(doc: PDFKit.PDFDocument, y: number): void {
	doc
		.font("Helvetica-Bold")
		.fontSize(10.5)
		.fillColor(BRAND.ink)
		.text(`For ${COMPANY.name}`, PAGE.marginX, y);
	// Space for signature / company stamp
	doc
		.font("Helvetica-Bold")
		.fontSize(10)
		.fillColor(BRAND.navy)
		.text("Authorized Signatory", PAGE.marginX, y + 56);
	doc
		.font("Helvetica")
		.fontSize(9.5)
		.fillColor(BRAND.gray)
		.text(COMPANY.signatoryTitle, PAGE.marginX, y + 70);
}

function drawFooter(doc: PDFKit.PDFDocument, reference: string): void {
	const y = PAGE.footerTop;
	doc
		.font("Helvetica-Oblique")
		.fontSize(7.5)
		.fillColor(BRAND.faint)
		.text(
			`This document was generated electronically by InnovWayz ERP against request ${reference} ` +
				`and may be verified with the issuing office at ${COMPANY.email}.`,
			PAGE.marginX,
			y,
			{ width: CONTENT_W, align: "center" },
		);

	doc
		.moveTo(PAGE.marginX, y + 24)
		.lineTo(PAGE.width - PAGE.marginX, y + 24)
		.lineWidth(0.8)
		.stroke(BRAND.line);

	doc
		.font("Helvetica-Bold")
		.fontSize(8)
		.fillColor(BRAND.navy)
		.text(COMPANY.name, PAGE.marginX, y + 32, { width: CONTENT_W, align: "center" });
	doc
		.font("Helvetica")
		.fontSize(7.5)
		.fillColor(BRAND.faint)
		.text(COMPANY.addressLine1, PAGE.marginX, y + 44, { width: CONTENT_W, align: "center" })
		.text(COMPANY.addressLine2, PAGE.marginX, y + 54, { width: CONTENT_W, align: "center" })
		.text(`${COMPANY.website}   •   ${COMPANY.email}`, PAGE.marginX, y + 64, {
			width: CONTENT_W,
			align: "center",
		});
}

function render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({
			size: "A4",
			// Small bottom margin: the fixed footer block is drawn manually and
			// must not trigger pdfkit's automatic page break.
			margins: { top: 44, bottom: 15, left: PAGE.marginX, right: PAGE.marginX },
			info: { Author: COMPANY.name, Creator: "InnovWayz ERP" },
		});
		const chunks: Buffer[] = [];
		doc.on("data", (c: Buffer) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
		build(doc);
		doc.end();
	});
}

// ─── Experience Letter ───────────────────────────────────────────────────────

export function generateExperienceLetter(data: LetterData): Promise<Buffer> {
	return render((doc) => {
		const issueDate = data.issueDate ?? new Date();
		let y = drawLetterhead(doc, data.reference, issueDate);
		y = drawTitle(doc, "Experience Letter", y, "To Whomsoever It May Concern");

		const rows: Array<[string, string]> = [["Name", data.employeeName]];
		if (data.employeeCode) rows.push(["Employee ID", data.employeeCode]);
		rows.push(["Designation", data.designation]);
		if (data.clientName) rows.push(["Client / Project", data.clientName]);
		if (data.dateOfJoining) rows.push(["Date of Joining", fmtShortDate(data.dateOfJoining)]);
		if (data.dateOfRelieving) rows.push(["Date of Relieving", fmtShortDate(data.dateOfRelieving)]);
		y = drawDetailsPanel(doc, rows, y);

		const first = firstName(data.employeeName);
		const relieved = Boolean(data.dateOfRelieving);

		const opening = relieved
			? `This is to certify that ${data.employeeName} was employed with ${COMPANY.name}` +
				`${data.dateOfJoining ? ` from ${fmtShortDate(data.dateOfJoining)}` : ""}` +
				` to ${fmtShortDate(data.dateOfRelieving!)}, and at the time of leaving the services of the ` +
				`company was designated as ${data.designation}.`
			: `This is to certify that ${data.employeeName} ` +
				`${data.dateOfJoining ? `has been employed with ${COMPANY.name} since ${fmtShortDate(data.dateOfJoining)}` : `is currently employed with ${COMPANY.name}`}` +
				` and is presently designated as ${data.designation}.`;

		const paragraphs: string[] = [opening];
		if (data.clientName) {
			paragraphs.push(
				`During this tenure, ${first} has been engaged with ${data.clientName} on behalf of ` +
					`${COMPANY.name}, carrying out responsibilities with commitment and professionalism.`,
			);
		}
		paragraphs.push(
			`Throughout the period of employment, we found ${first} to be sincere, hardworking and ` +
				`professional, consistently demonstrating strong technical and analytical skills while ` +
				`working effectively as part of a team.`,
			relieved
				? `We appreciate the time ${first} has spent with us and hope the experience gained at ` +
					`${COMPANY.name} adds lasting value to ${first}'s career. We wish ${first} continued ` +
					`success in all future endeavors.`
				: `${first} continues to be a valued member of our organization, and this letter is issued ` +
					`${data.purpose ? `for the purpose of ${data.purpose} ` : "upon request "}without any ` +
					`liability on the part of ${COMPANY.name}.`,
		);

		y = drawParagraphs(doc, paragraphs, y);
		// Anchor the signature after the content, but never so low that the
		// ~80pt block collides with the fixed footer at PAGE.footerTop.
		drawSignature(doc, Math.min(y + 12, PAGE.footerTop - 90));
		drawFooter(doc, data.reference);
	});
}

// ─── Salary Certificate → InnovWayz Payslip ──────────────────────────────────
//
// generateSalaryCertificate renders the monthly payslip layout: a PAYSLIP
// header with the pay-period, an employee-information grid, itemized EARNINGS
// and DEDUCTIONS tables, a full-width NET PAY band, the net-in-words line and a
// registered-address footer. Zero/absent amounts render with an em dash.

const PS_ROW_H = 19;
const PS_BAND_H = 21;
const PS_EMDASH = "—";

/** payslip header: logo + wordmark (left), PAYSLIP band + period (right). */
function drawPayslipHeader(doc: PDFKit.PDFDocument, periodLabel: string): number {
	const { marginX } = PAGE;
	const top = 46;

	doc.image(LOGO, marginX + 8, top, { width: 46 });
	doc
		.font("Helvetica-Bold")
		.fontSize(10.5)
		.fillColor(BRAND.navy)
		.text("INNOVWAYZ", marginX - 6, top + 50, { width: 78, align: "center" });
	doc
		.font("Helvetica")
		.fontSize(6.5)
		.fillColor(BRAND.gray)
		.text("TECHNOLOGIES", marginX - 6, top + 62, {
			width: 78,
			align: "center",
			characterSpacing: 1.5,
		});

	const bandX = marginX + 150;
	const bandW = PAGE.width - marginX - bandX;
	const bandH = 40;
	doc.rect(bandX, top, bandW, bandH).fill(BRAND.blue);
	doc
		.font("Helvetica-Bold")
		.fontSize(21)
		.fillColor("#FFFFFF")
		.text("PAYSLIP", bandX, top + 9, {
			width: bandW,
			align: "center",
			characterSpacing: 5,
		});
	doc
		.font("Helvetica-Bold")
		.fontSize(11)
		.fillColor(BRAND.gray)
		.text(periodLabel, bandX, top + bandH + 6, {
			width: bandW,
			align: "center",
			characterSpacing: 1,
		});

	return top + bandH + 28;
}

/** Full-width blue section bar with an optional right-aligned caption. */
function drawSectionBar(
	doc: PDFKit.PDFDocument,
	y: number,
	left: string,
	right?: string,
): number {
	doc.rect(PAGE.marginX, y, CONTENT_W, PS_BAND_H).fill(BRAND.blue);
	doc
		.font("Helvetica-Bold")
		.fontSize(9)
		.fillColor("#FFFFFF")
		.text(left, PAGE.marginX + 12, y + 6.5, { characterSpacing: 0.8 });
	if (right)
		doc.text(right, PAGE.marginX, y + 6.5, {
			width: CONTENT_W - 12,
			align: "right",
		});
	return y + PS_BAND_H;
}

/** Two-column label/value grid inside a light panel. */
function drawEmployeeInfo(
	doc: PDFKit.PDFDocument,
	y: number,
	leftRows: Array<[string, string]>,
	rightRows: Array<[string, string]>,
): number {
	const colW = CONTENT_W / 2;
	const rowsMax = Math.max(leftRows.length, rightRows.length);
	const panelH = rowsMax * PS_ROW_H + 8;

	doc.rect(PAGE.marginX, y, CONTENT_W, panelH).fill(BRAND.panel);
	doc.rect(PAGE.marginX, y, CONTENT_W, panelH).lineWidth(0.8).stroke(BRAND.line);
	doc
		.moveTo(PAGE.marginX + colW, y)
		.lineTo(PAGE.marginX + colW, y + panelH)
		.lineWidth(0.8)
		.stroke(BRAND.line);

	const drawCol = (rows: Array<[string, string]>, x: number) => {
		let ry = y + 6;
		for (const [label, value] of rows) {
			doc
				.font("Helvetica")
				.fontSize(8.5)
				.fillColor(BRAND.gray)
				.text(label, x + 12, ry + 4, { width: colW * 0.44, lineBreak: false });
			doc
				.font("Helvetica-Bold")
				.fontSize(8.5)
				.fillColor(BRAND.ink)
				.text(value, x + 12 + colW * 0.44, ry + 4, {
					width: colW * 0.5,
					lineBreak: false,
				});
			ry += PS_ROW_H;
		}
	};
	drawCol(leftRows, PAGE.marginX);
	drawCol(rightRows, PAGE.marginX + colW);
	return y + panelH;
}

/** One earnings/deductions line: label (left), currency amount (right). */
function drawAmountRow(
	doc: PDFKit.PDFDocument,
	y: number,
	label: string,
	amount: number,
	currency: string,
): number {
	doc
		.font("Helvetica")
		.fontSize(9)
		.fillColor(BRAND.ink)
		.text(label, PAGE.marginX + 12, y + 5.5, {
			width: CONTENT_W - 150,
			lineBreak: false,
		});
	const cell = amount > 0 ? `${currency} ${fmtMoney(amount)}` : `${currency}  ${PS_EMDASH}`;
	doc.text(cell, PAGE.marginX, y + 5.5, { width: CONTENT_W - 12, align: "right" });
	const ny = y + PS_ROW_H;
	doc
		.moveTo(PAGE.marginX, ny)
		.lineTo(PAGE.marginX + CONTENT_W, ny)
		.lineWidth(0.6)
		.stroke(BRAND.line);
	return ny;
}

/** Solid total/net band with a label and a currency amount. */
function drawTotalBand(
	doc: PDFKit.PDFDocument,
	y: number,
	label: string,
	amount: number,
	currency: string,
	opts: { fill?: string; leftNote?: string; big?: boolean } = {},
): number {
	const h = opts.big ? PS_BAND_H + 5 : PS_BAND_H;
	doc.rect(PAGE.marginX, y, CONTENT_W, h).fill(opts.fill ?? BRAND.navy);
	const ty = y + (opts.big ? 8 : 6);
	if (opts.leftNote)
		doc
			.font("Helvetica")
			.fontSize(8)
			.fillColor("#DCE6F4")
			.text(opts.leftNote, PAGE.marginX + 12, ty + 1);
	doc
		.font("Helvetica-Bold")
		.fontSize(opts.big ? 11.5 : 9.5)
		.fillColor("#FFFFFF")
		.text(
			label,
			PAGE.marginX + 12,
			ty,
			opts.leftNote ? { width: CONTENT_W - 24, align: "center" } : { characterSpacing: 0.5 },
		);
	const cell = amount > 0 ? `${currency} ${fmtMoney(amount)}` : `${currency}  ${PS_EMDASH}`;
	doc.text(cell, PAGE.marginX, ty, { width: CONTENT_W - 12, align: "right" });
	return y + h;
}

/** Registered-address footer for the payslip. */
function drawPayslipFooter(doc: PDFKit.PDFDocument): void {
	const y = PAGE.footerTop + 6;
	doc
		.moveTo(PAGE.marginX, y)
		.lineTo(PAGE.width - PAGE.marginX, y)
		.lineWidth(0.8)
		.stroke(BRAND.line);
	doc
		.font("Helvetica")
		.fontSize(7.5)
		.fillColor(BRAND.gray)
		.text(COMPANY.website, PAGE.marginX, y + 10)
		.text(COMPANY.email, PAGE.marginX, y + 21)
		.text(
			`${COMPANY.addressLine1}, ${COMPANY.addressLine2}`,
			PAGE.marginX,
			y + 32,
			{ width: CONTENT_W - 60 },
		);
	doc.image(LOGO, PAGE.width - PAGE.marginX - 40, y + 12, { width: 40 });
}

export function generateSalaryCertificate(data: SalaryCertificateData): Promise<Buffer> {
	return render((doc) => {
		const issueDate = data.issueDate ?? new Date();
		const currency = data.currency || "SAR";

		// ── Amounts ────────────────────────────────────────────────────────────
		const b = data.breakdown;
		const hasBreakdown = Boolean(b && (b.basic || b.housing || b.transport || b.other));
		const basic = hasBreakdown ? (b!.basic ?? 0) : data.monthlySalary;
		const housing = hasBreakdown ? (b!.housing ?? 0) : 0;
		const travelOther = hasBreakdown ? (b!.transport ?? 0) + (b!.other ?? 0) : 0;
		const overtime = data.overtime ?? 0;
		const gross = basic + housing + travelOther + overtime;

		const salaryAdvance = data.salaryAdvance ?? 0;
		const employeeRequests = data.employeeRequestsDeduction ?? 0;
		const remoteWork = data.remoteWorkHalf ? gross * 0.5 : 0;
		const lopDays = data.lossOfPayDays ?? 0;
		const lossOfPay = (gross / 30) * lopDays;
		const totalDeductions = salaryAdvance + employeeRequests + remoteWork + lossOfPay;
		const net = Math.round((gross - totalDeductions) * 100) / 100;

		// ── Header ───────────────────────────────────────────────────────────────
		const periodLabel =
			data.periodMonth && data.periodYear
				? monthYearLabel(data.periodMonth, data.periodYear)
				: monthYearLabel(issueDate.getMonth() + 1, issueDate.getFullYear());
		let y = drawPayslipHeader(doc, periodLabel);

		// ── Employee information ──────────────────────────────────────────────────
		const payDate = data.payDate ? fmtDashDate(data.payDate) : fmtDashDate(issueDate.toISOString());
		const joining = data.dateOfJoining ? fmtDashDate(data.dateOfJoining) : "—";
		const leftRows: Array<[string, string]> = [
			["Employee Name", data.employeeName],
			["Mode", data.mode || "Bank Transfer"],
			["Location", data.location || "Riyadh, Saudi Arabia"],
			["Attendance Days", data.attendanceDays != null ? String(data.attendanceDays) : "—"],
			["Government Holidays", String(data.governmentHolidays ?? 0)],
			["Annual Leaves", String(data.annualLeaves ?? 0)],
			["Sick Leaves", String(data.sickLeaves ?? 0)],
		];
		const rightRows: Array<[string, string]> = [
			["Pay Date", payDate],
			["Designation", data.designation],
			["ID #", data.nationalId || "—"],
			["Employee Band", data.band || "—"],
			["Joining Date", joining],
		];
		if (data.employeeCode) rightRows.push(["Employee ID", data.employeeCode]);
		y = drawSectionBar(doc, y + 4, "EMPLOYEE INFORMATION");
		y = drawEmployeeInfo(doc, y, leftRows, rightRows);

		// ── Earnings ──────────────────────────────────────────────────────────────
		y = drawSectionBar(doc, y + 8, "EARNINGS", `AMOUNT (${currency})`);
		y = drawAmountRow(doc, y, "Basic Pay", basic, currency);
		y = drawAmountRow(doc, y, "House Rent Allowance", housing, currency);
		y = drawAmountRow(doc, y, "Travel & Other Allowance", travelOther, currency);
		y = drawAmountRow(doc, y, "Overtime", overtime, currency);
		y = drawTotalBand(doc, y, "GROSS PAY", gross, currency, {
			leftNote: `CURRENT MONTH DAYS PAYABLE: ${data.daysPayable ?? 30}`,
		});

		// ── Deductions ────────────────────────────────────────────────────────────
		const lopLabel = lopDays
			? `Loss Of Pay Days (Leaves) — ${lopDays} Day${lopDays === 1 ? "" : "s"}`
			: "Loss Of Pay Days (Leaves)";
		y = drawSectionBar(doc, y + 8, "DEDUCTIONS", `AMOUNT (${currency})`);
		y = drawAmountRow(doc, y, "Salary Advance", salaryAdvance, currency);
		y = drawAmountRow(doc, y, "Employee Requests - CoC, Exit / Re-Entry etc.", employeeRequests, currency);
		y = drawAmountRow(doc, y, "Remote Work-50% Salary Applied", remoteWork, currency);
		y = drawAmountRow(doc, y, lopLabel, lossOfPay, currency);
		y = drawTotalBand(doc, y, "TOTAL DEDUCTIONS", totalDeductions, currency);

		// ── Net pay + words ───────────────────────────────────────────────────────
		y = drawTotalBand(doc, y + 10, "NET PAY", net, currency, {
			fill: BRAND.blue,
			big: true,
		});
		const currencyWords = currency === "SAR" ? "Saudi Riyals" : currency;
		doc
			.font("Helvetica-Bold")
			.fontSize(9.5)
			.fillColor(BRAND.ink)
			.text(
				`${currencyWords}: ${numberToWords(Math.round(net))} Only`,
				PAGE.marginX,
				y + 8,
				{ width: CONTENT_W, align: "right" },
			);

		// ── Auto-generated note ────────────────────────────────────────────────────
		doc
			.font("Helvetica-Oblique")
			.fontSize(8)
			.fillColor(BRAND.faint)
			.text(
				"-- This document has been automatically generated by InnovWayz Payroll; therefore, a signature is not required. --",
				PAGE.marginX,
				y + 30,
				{ width: CONTENT_W, align: "center" },
			);

		drawPayslipFooter(doc);
	});
}
