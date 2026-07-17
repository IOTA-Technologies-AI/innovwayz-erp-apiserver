// ─────────────────────────────────────────────────────────────────────────────
// Offer Letter PDF — branded employment offer with two e-signature blocks
// (candidate acceptance + InnovWayz countersignature). Deterministic: the
// same data + signatures always render the same document, so the "signed"
// PDF is reproducible and hashable. A final audit/certificate page is added
// once the envelope is completed.
// ─────────────────────────────────────────────────────────────────────────────

import PDFDocument from "pdfkit";
import { LOGO_PNG_BASE64 } from "./logoAsset";

export const COMPANY = {
	name: "InnovWayz Technologies",
	addressLine1: "Building No: 9353, Office # 2, Shaddad Al Fahri, Farazdaq Street",
	addressLine2: "Al Malaz, Riyadh – 12642, Kingdom of Saudi Arabia",
	website: "www.innovwayz.com",
	email: "hr@innovwayz.com",
} as const;

const BRAND = {
	navy: "#16437E",
	blue: "#1E63B0",
	sky: "#2E8FE8",
	ink: "#1A2433",
	gray: "#5B6B7F",
	faint: "#8A97A6",
	line: "#DFE7F1",
	panel: "#F4F8FC",
	green: "#1B7F5A",
} as const;

const PAGE = {
	width: 595.28,
	height: 841.89,
	marginX: 60,
	footerTop: 770,
} as const;

const CONTENT_W = PAGE.width - PAGE.marginX * 2;
const LOGO = Buffer.from(LOGO_PNG_BASE64, "base64");

export interface OfferSignature {
	/** PNG data URL (drawn) or the typed name. */
	value: string;
	type: "drawn" | "typed";
	name: string;
	signedAt?: string | null;
}

export interface OfferAudit {
	reference: string;
	envelopeId: string;
	candidateName: string;
	candidateEmail: string;
	candidateSignedAt?: string | null;
	candidateIp?: string | null;
	companySignatoryName?: string | null;
	countersignedAt?: string | null;
	documentHash?: string | null;
}

export interface OfferLetterData {
	reference: string;
	issueDate?: Date;
	candidateName: string;
	candidateEmail: string;
	jobTitle: string;
	department?: string | null;
	workLocation?: string | null;
	clientName?: string | null;
	employmentType: string;
	joiningDate?: string | null;
	offerExpiryDate?: string | null;
	probationMonths?: number | null;
	noticePeriodDays?: number | null;
	annualLeaveDays?: number | null;
	currency: string;
	monthlySalary: number;
	breakdown?: {
		basic: number | null;
		housing: number | null;
		transport: number | null;
		other: number | null;
	} | null;
	benefits?: string | null;
	additionalTerms?: string | null;
	signatoryName?: string | null;
	signatoryTitle?: string | null;
	// Signatures (present as signing progresses)
	companySignature?: OfferSignature | null;
	candidateSignature?: OfferSignature | null;
	// Audit certificate page (only when completed)
	audit?: OfferAudit | null;
}

const EMPLOYMENT_LABELS: Record<string, string> = {
	full_time: "Full-Time",
	part_time: "Part-Time",
	contract: "Contract",
	internship: "Internship",
};

function fmtLongDate(d: Date): string {
	return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}
function fmtShortDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString("en-GB", {
		day: "2-digit", month: "short", year: "numeric",
		hour: "2-digit", minute: "2-digit", timeZone: "Asia/Riyadh",
	}) + " (AST)";
}
function fmtMoney(n: number): string {
	return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function firstName(full: string): string {
	return full.trim().split(/\s+/)[0] ?? full;
}

/** Decode a PNG data URL to a Buffer, or null if it isn't one. */
function dataUrlToBuffer(value: string): Buffer | null {
	const m = /^data:image\/png;base64,(.+)$/i.exec(value.trim());
	if (!m) return null;
	try {
		return Buffer.from(m[1], "base64");
	} catch {
		return null;
	}
}

function drawLetterhead(doc: PDFKit.PDFDocument, reference: string, issueDate: Date): number {
	const { marginX } = PAGE;
	doc.image(LOGO, marginX, 44, { width: 42 });
	doc
		.font("Helvetica-Bold").fontSize(15.5).fillColor(BRAND.navy)
		.text("InnovWayz", marginX + 52, 50, { continued: true })
		.fillColor(BRAND.sky).text(" Technologies");
	doc.font("Helvetica").fontSize(8).fillColor(BRAND.gray)
		.text("Riyadh  •  Kingdom of Saudi Arabia", marginX + 52, 69);
	doc.fontSize(8).fillColor(BRAND.gray)
		.text(COMPANY.website, marginX, 52, { width: CONTENT_W, align: "right" })
		.text(COMPANY.email, marginX, 63, { width: CONTENT_W, align: "right" });
	doc.rect(marginX, 96, CONTENT_W - 110, 2.5).fill(BRAND.blue);
	doc.rect(marginX + CONTENT_W - 110, 96, 110, 2.5).fill(BRAND.sky);
	doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.ink)
		.text(`Ref: ${reference}`, marginX, 112);
	doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink)
		.text(`Date: ${fmtLongDate(issueDate)}`, marginX, 112, { width: CONTENT_W, align: "right" });
	return 146;
}

function drawTitle(doc: PDFKit.PDFDocument, title: string, y: number): number {
	doc.font("Helvetica-Bold").fontSize(14).fillColor(BRAND.navy)
		.text(title.toUpperCase(), PAGE.marginX, y, {
			width: CONTENT_W, align: "center", characterSpacing: 2,
		});
	return y + 30;
}

function drawTermsPanel(doc: PDFKit.PDFDocument, rows: Array<[string, string]>, y: number): number {
	const padX = 18, padY = 12, rowH = 19;
	const colW = (CONTENT_W - padX * 2) / 2;
	const perCol = Math.ceil(rows.length / 2);
	const h = perCol * rowH + padY * 2 - 4;
	doc.roundedRect(PAGE.marginX, y, CONTENT_W, h, 6).fill(BRAND.panel);
	doc.roundedRect(PAGE.marginX, y, CONTENT_W, h, 6).lineWidth(0.8).stroke(BRAND.line);
	rows.forEach(([label, value], i) => {
		const col = Math.floor(i / perCol);
		const rowInCol = i % perCol;
		const x = PAGE.marginX + padX + col * colW;
		const ry = y + padY + rowInCol * rowH;
		doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND.gray)
			.text(label, x, ry, { width: 110, lineBreak: false });
		doc.font("Helvetica").fontSize(8.5).fillColor(BRAND.ink)
			.text(value, x + 112, ry, { width: colW - 118, lineBreak: false });
	});
	return y + h + 18;
}

function drawParagraphs(doc: PDFKit.PDFDocument, paragraphs: string[], y: number, size = 10): number {
	doc.font("Helvetica").fontSize(size).fillColor(BRAND.ink);
	let cy = y;
	for (const p of paragraphs) {
		doc.text(p, PAGE.marginX, cy, { width: CONTENT_W, align: "justify", lineGap: 2.5 });
		cy = doc.y + 9;
	}
	return cy;
}

/** Compensation mini-table (accruals → gross). Returns y below it. */
function drawCompensation(doc: PDFKit.PDFDocument, data: OfferLetterData, y: number): number {
	const rowH = 19, bandH = 21;
	const amountW = 150;
	const labelX = PAGE.marginX + 12;
	const amountX = PAGE.width - PAGE.marginX - amountW;
	const b = data.breakdown;
	const rows: Array<[string, number]> = [];
	if (b && (b.basic || b.housing || b.transport || b.other)) {
		if (b.basic) rows.push(["Basic Salary", b.basic]);
		if (b.housing) rows.push(["House Rent Allowance", b.housing]);
		if (b.transport) rows.push(["Transportation Allowance", b.transport]);
		if (b.other) rows.push(["Other Allowance", b.other]);
	} else {
		rows.push(["Monthly Salary (Consolidated)", data.monthlySalary]);
	}

	doc.rect(PAGE.marginX, y, CONTENT_W, bandH).fill(BRAND.blue);
	doc.font("Helvetica-Bold").fontSize(9).fillColor("#FFFFFF")
		.text("MONTHLY COMPENSATION", labelX, y + 6.5, { characterSpacing: 0.5 })
		.text(`AMOUNT (${data.currency})`, amountX, y + 6.5, { width: amountW - 12, align: "right" });
	let cy = y + bandH;
	for (const [label, amount] of rows) {
		doc.font("Helvetica").fontSize(9.5).fillColor(BRAND.ink)
			.text(label, labelX, cy + 5.5)
			.text(fmtMoney(amount), amountX, cy + 5.5, { width: amountW - 12, align: "right" });
		cy += rowH;
		doc.moveTo(PAGE.marginX, cy).lineTo(PAGE.width - PAGE.marginX, cy).lineWidth(0.6).stroke(BRAND.line);
	}
	doc.rect(PAGE.marginX, cy, CONTENT_W, bandH).fill(BRAND.navy);
	doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#FFFFFF")
		.text("GROSS MONTHLY SALARY", labelX, cy + 6, { characterSpacing: 0.5 })
		.text(`${data.currency} ${fmtMoney(data.monthlySalary)}`, amountX, cy + 6, { width: amountW - 12, align: "right" });
	return cy + bandH + 16;
}

/**
 * A signature block. Renders the drawn PNG or typed name above a rule,
 * with role, name, title and timestamp beneath. Shows "Pending signature"
 * when unsigned.
 */
function drawSignatureBlock(
	doc: PDFKit.PDFDocument,
	x: number,
	y: number,
	w: number,
	roleLabel: string,
	name: string,
	title: string | null,
	sig: OfferSignature | null | undefined,
): void {
	const lineY = y + 42;
	if (sig) {
		const img = sig.type === "drawn" ? dataUrlToBuffer(sig.value) : null;
		if (img) {
			try {
				doc.image(img, x, y, { fit: [w - 10, 38], align: "left", valign: "bottom" });
			} catch {
				/* fall through to typed */
			}
		} else {
			doc.font("Times-Italic").fontSize(22).fillColor(BRAND.navy)
				.text(sig.value || name, x, y + 10, { width: w, lineBreak: false });
		}
	} else {
		doc.font("Helvetica-Oblique").fontSize(9).fillColor(BRAND.faint)
			.text("Pending signature", x, y + 20);
	}
	doc.moveTo(x, lineY).lineTo(x + w, lineY).lineWidth(0.9).stroke(sig ? BRAND.navy : BRAND.line);
	doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.gray)
		.text(roleLabel.toUpperCase(), x, lineY + 6, { characterSpacing: 0.6 });
	doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.ink)
		.text(name || "—", x, lineY + 17);
	if (title) {
		doc.font("Helvetica").fontSize(8.5).fillColor(BRAND.gray).text(title, x, lineY + 30);
	}
	if (sig?.signedAt) {
		doc.font("Helvetica").fontSize(7.5).fillColor(BRAND.green)
			.text(`Signed electronically · ${fmtDateTime(sig.signedAt)}`, x, lineY + (title ? 43 : 30));
	}
}

function drawFooter(doc: PDFKit.PDFDocument, reference: string): void {
	const y = PAGE.footerTop;
	doc.moveTo(PAGE.marginX, y).lineTo(PAGE.width - PAGE.marginX, y).lineWidth(0.8).stroke(BRAND.line);
	doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.navy)
		.text(COMPANY.name, PAGE.marginX, y + 8, { width: CONTENT_W, align: "center" });
	doc.font("Helvetica").fontSize(7.5).fillColor(BRAND.faint)
		.text(COMPANY.addressLine1, PAGE.marginX, y + 20, { width: CONTENT_W, align: "center" })
		.text(COMPANY.addressLine2, PAGE.marginX, y + 30, { width: CONTENT_W, align: "center" })
		.text(`${COMPANY.website}   •   ${COMPANY.email}   •   Ref: ${reference}`, PAGE.marginX, y + 40, {
			width: CONTENT_W, align: "center",
		});
}

function render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({
			size: "A4",
			margins: { top: 44, bottom: 15, left: PAGE.marginX, right: PAGE.marginX },
			info: { Author: COMPANY.name, Creator: "InnovWayz ERP", Title: "Offer of Employment" },
		});
		const chunks: Buffer[] = [];
		doc.on("data", (c: Buffer) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
		build(doc);
		doc.end();
	});
}

export function generateOfferLetter(data: OfferLetterData): Promise<Buffer> {
	return render((doc) => {
		const issueDate = data.issueDate ?? new Date();
		let y = drawLetterhead(doc, data.reference, issueDate);
		y = drawTitle(doc, "Offer of Employment", y);

		// Salutation
		doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink)
			.text(`Dear ${data.candidateName},`, PAGE.marginX, y);
		y = doc.y + 8;

		const first = firstName(data.candidateName);
		y = drawParagraphs(doc, [
			`We are pleased to offer you the position of ${data.jobTitle} at ${COMPANY.name}. ` +
				`This letter sets out the principal terms of our offer, which we believe reflects the ` +
				`value we place on the skills and experience you bring.`,
		], y);

		// Terms grid
		const terms: Array<[string, string]> = [
			["Position", data.jobTitle],
			["Employment Type", EMPLOYMENT_LABELS[data.employmentType] ?? data.employmentType],
		];
		if (data.department) terms.push(["Department", data.department]);
		if (data.clientName) terms.push(["Client / Project", data.clientName]);
		if (data.workLocation) terms.push(["Work Location", data.workLocation]);
		if (data.joiningDate) terms.push(["Joining Date", fmtShortDate(data.joiningDate)]);
		if (data.probationMonths) terms.push(["Probation", `${data.probationMonths} month(s)`]);
		if (data.noticePeriodDays) terms.push(["Notice Period", `${data.noticePeriodDays} day(s)`]);
		if (data.annualLeaveDays) terms.push(["Annual Leave", `${data.annualLeaveDays} day(s) / year`]);
		if (data.offerExpiryDate) terms.push(["Offer Valid Until", fmtShortDate(data.offerExpiryDate)]);
		y = drawTermsPanel(doc, terms, y);

		y = drawCompensation(doc, data, y);

		if (data.benefits) {
			y = drawParagraphs(doc, [`Benefits: ${data.benefits}`], y, 9.5);
		}
		if (data.additionalTerms) {
			y = drawParagraphs(doc, [data.additionalTerms], y, 9.5);
		}

		y = drawParagraphs(doc, [
			`This offer${data.offerExpiryDate ? `, valid until ${fmtShortDate(data.offerExpiryDate)},` : ""} ` +
				`is contingent upon successful completion of any pre-employment checks and applicable ` +
				`regulatory requirements in the Kingdom of Saudi Arabia. We look forward to welcoming ` +
				`${first} to the team.`,
			`Please indicate your acceptance of this offer by signing electronically below.`,
		], y);

		// Signature blocks
		const blockW = (CONTENT_W - 40) / 2;
		const sigY = Math.min(y + 8, PAGE.footerTop - 120);
		drawSignatureBlock(
			doc, PAGE.marginX, sigY, blockW,
			`For ${COMPANY.name}`,
			data.signatoryName ?? "Authorized Signatory",
			data.signatoryTitle ?? "Human Resources",
			data.companySignature,
		);
		drawSignatureBlock(
			doc, PAGE.marginX + blockW + 40, sigY, blockW,
			"Accepted by Candidate",
			data.candidateName,
			data.jobTitle,
			data.candidateSignature,
		);

		drawFooter(doc, data.reference);

		// Audit certificate page
		if (data.audit) {
			doc.addPage();
			let ay = drawLetterhead(doc, data.reference, issueDate);
			ay = drawTitle(doc, "Certificate of Completion", ay);
			doc.font("Helvetica").fontSize(9.5).fillColor(BRAND.gray)
				.text(
					"This certificate records the electronic-signature audit trail for the offer letter above. " +
						"Each event is logged with its actor and timestamp.",
					PAGE.marginX, ay, { width: CONTENT_W, align: "center" },
				);
			ay = doc.y + 18;
			const a = data.audit;
			const rows: Array<[string, string]> = [
				["Envelope ID", a.envelopeId],
				["Reference", a.reference],
				["Candidate", `${a.candidateName} <${a.candidateEmail}>`],
			];
			if (a.candidateSignedAt) rows.push(["Candidate signed", fmtDateTime(a.candidateSignedAt)]);
			if (a.candidateIp) rows.push(["Candidate IP", a.candidateIp]);
			if (a.companySignatoryName) rows.push(["Countersigned by", a.companySignatoryName]);
			if (a.countersignedAt) rows.push(["Countersigned", fmtDateTime(a.countersignedAt)]);
			if (a.documentHash) rows.push(["Document SHA-256", a.documentHash]);
			const padX = 18, padY = 14, rowH = 24;
			const h = rows.length * rowH + padY * 2 - 8;
			doc.roundedRect(PAGE.marginX, ay, CONTENT_W, h, 6).fill(BRAND.panel);
			doc.roundedRect(PAGE.marginX, ay, CONTENT_W, h, 6).lineWidth(0.8).stroke(BRAND.line);
			let ry = ay + padY;
			for (const [label, value] of rows) {
				doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND.gray)
					.text(label, PAGE.marginX + padX, ry, { width: 130 });
				doc.font("Helvetica").fontSize(8.5).fillColor(BRAND.ink)
					.text(value, PAGE.marginX + padX + 135, ry, { width: CONTENT_W - padX * 2 - 135 });
				ry += rowH;
			}
			drawFooter(doc, data.reference);
		}
	});
}
