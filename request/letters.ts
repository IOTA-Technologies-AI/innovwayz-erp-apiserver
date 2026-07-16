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
	monthlySalary: number;
	breakdown?: {
		basic: number | null;
		housing: number | null;
		transport: number | null;
		other: number | null;
	} | null;
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
		drawSignature(doc, Math.min(y + 12, 620));
		drawFooter(doc, data.reference);
	});
}

// ─── Salary Certificate ──────────────────────────────────────────────────────

/** Payslip-style salary table. Returns the y below the table. */
function drawSalaryTable(doc: PDFKit.PDFDocument, data: SalaryCertificateData, y: number): number {
	const rowH = 22;
	const amountW = 150;
	const labelX = PAGE.marginX + 14;
	const amountX = PAGE.width - PAGE.marginX - amountW;

	const components: Array<[string, number]> = [];
	const b = data.breakdown;
	if (b && (b.basic || b.housing || b.transport || b.other)) {
		if (b.basic) components.push(["Basic Pay", b.basic]);
		if (b.housing) components.push(["House Rent Allowance", b.housing]);
		if (b.transport) components.push(["Travel & Other Allowance", b.transport]);
		if (b.other) components.push(["Other Allowance", b.other]);
	} else {
		components.push(["Monthly Salary (Consolidated)", data.monthlySalary]);
	}

	// Header band
	doc.rect(PAGE.marginX, y, CONTENT_W, rowH).fill(BRAND.blue);
	doc
		.font("Helvetica-Bold")
		.fontSize(9.5)
		.fillColor("#FFFFFF")
		.text("MONTHLY SALARY COMPONENTS", labelX, y + 6.5, { characterSpacing: 0.6 })
		.text(`AMOUNT (${data.currency})`, amountX, y + 6.5, {
			width: amountW - 14,
			align: "right",
		});
	let cy = y + rowH;

	// Component rows
	for (const [label, amount] of components) {
		doc
			.font("Helvetica")
			.fontSize(10)
			.fillColor(BRAND.ink)
			.text(label, labelX, cy + 6.5)
			.text(fmtMoney(amount), amountX, cy + 6.5, { width: amountW - 14, align: "right" });
		cy += rowH;
		doc
			.moveTo(PAGE.marginX, cy)
			.lineTo(PAGE.width - PAGE.marginX, cy)
			.lineWidth(0.7)
			.stroke(BRAND.line);
	}

	// Gross band
	doc.rect(PAGE.marginX, cy, CONTENT_W, rowH).fill(BRAND.navy);
	doc
		.font("Helvetica-Bold")
		.fontSize(10)
		.fillColor("#FFFFFF")
		.text("GROSS MONTHLY SALARY", labelX, cy + 6, { characterSpacing: 0.6 })
		.text(`${data.currency} ${fmtMoney(data.monthlySalary)}`, amountX, cy + 6, {
			width: amountW - 14,
			align: "right",
		});
	return cy + rowH + 14;
}

export function generateSalaryCertificate(data: SalaryCertificateData): Promise<Buffer> {
	return render((doc) => {
		const issueDate = data.issueDate ?? new Date();
		let y = drawLetterhead(doc, data.reference, issueDate);
		y = drawTitle(doc, "Salary Certificate", y, "To Whomsoever It May Concern");

		const rows: Array<[string, string]> = [["Name", data.employeeName]];
		if (data.employeeCode) rows.push(["Employee ID", data.employeeCode]);
		rows.push(["Designation", data.designation]);
		if (data.dateOfJoining) rows.push(["Date of Joining", fmtShortDate(data.dateOfJoining)]);
		y = drawDetailsPanel(doc, rows, y);

		y = drawParagraphs(
			doc,
			[
				`This is to certify that ${data.employeeName}` +
					`${data.employeeCode ? ` (Employee ID: ${data.employeeCode})` : ""} is a full-time ` +
					`employee of ${COMPANY.name}` +
					`${data.dateOfJoining ? `, employed since ${fmtShortDate(data.dateOfJoining)},` : ""} ` +
					`currently holding the position of ${data.designation}. The current monthly salary ` +
					`details of the employee are as follows:`,
			],
			y,
		);

		y = drawSalaryTable(doc, data, y);

		// Amount in words
		doc
			.font("Helvetica-Oblique")
			.fontSize(9.5)
			.fillColor(BRAND.gray)
			.text(
				`Say: Saudi Riyals ${numberToWords(Math.round(data.monthlySalary))} Only, per month.`,
				PAGE.marginX,
				y,
				{ width: CONTENT_W },
			);
		y = doc.y + 16;

		y = drawParagraphs(
			doc,
			[
				`This certificate is issued ${data.purpose ? `for the purpose of ${data.purpose}` : "at the request of the employee"} ` +
					`and does not constitute any guarantee, undertaking or liability on the part of ` +
					`${COMPANY.name}.`,
			],
			y,
		);

		drawSignature(doc, Math.min(y + 12, 620));
		drawFooter(doc, data.reference);
	});
}
