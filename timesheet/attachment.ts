// ─────────────────────────────────────────────────────────────────────────────
// Timesheet attachment handling: format allow-list (by magic bytes, not the
// client-declared type), size cap, and best-effort OCR verification via
// Tesseract.js. OCR never blocks submission — it produces reviewer flags.
// ─────────────────────────────────────────────────────────────────────────────

import log from "encore.dev/log";
// NOTE: tesseract.js is imported lazily inside ocrAndCompare (dynamic import)
// so this heavy WASM dependency is never part of the critical path — if it
// fails to load or bundle, OCR degrades to "unavailable" and the timesheet
// portal keeps working. It must never block deployment or submission.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export type AttachmentType = "image/png" | "image/jpeg" | "application/pdf";

/**
 * Determine the true file type from magic bytes. Returns null for anything
 * not on the allow-list — we never trust the client-supplied MIME type.
 */
export function sniffType(buf: Buffer): AttachmentType | null {
	if (buf.length < 5) return null;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
		return "image/png";
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
		return "application/pdf"; // %PDF
	return null;
}

export interface OcrExpectation {
	employeeName: string;
	totalWorkingDays: number;
	daysPresent: number;
	overtimeHours: number;
	monthName: string; // e.g. "July"
	year: number;
}

export interface OcrResult {
	status: "ok" | "pdf_manual_review" | "unavailable" | "skipped";
	text: string | null;
	flags: string[];
}

/** Extract every integer appearing in the text. */
function integersIn(text: string): Set<number> {
	const out = new Set<number>();
	for (const m of text.matchAll(/\d{1,4}/g)) out.add(Number.parseInt(m[0], 10));
	return out;
}

function compare(text: string, expect: OcrExpectation): string[] {
	const flags: string[] = [];
	const lower = text.toLowerCase();

	// Employee name — require the significant tokens to appear.
	const tokens = expect.employeeName
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length >= 3);
	const missing = tokens.filter((t) => !lower.includes(t));
	if (tokens.length > 0 && missing.length === tokens.length) {
		flags.push(
			`Employee name "${expect.employeeName}" was not found in the attachment.`,
		);
	}

	// Period — month name or numeric month should appear alongside the year.
	if (!lower.includes(expect.monthName.toLowerCase()) && !lower.includes(String(expect.year))) {
		flags.push(
			`The attachment does not clearly show the period ${expect.monthName} ${expect.year}.`,
		);
	}

	// Numeric attendance figures should be present.
	const nums = integersIn(text);
	if (expect.totalWorkingDays > 0 && !nums.has(expect.totalWorkingDays)) {
		flags.push(
			`Total working days entered (${expect.totalWorkingDays}) was not found in the attachment.`,
		);
	}
	if (expect.daysPresent > 0 && !nums.has(expect.daysPresent)) {
		flags.push(
			`Days present entered (${expect.daysPresent}) was not found in the attachment.`,
		);
	}
	if (expect.overtimeHours > 0 && !nums.has(Math.round(expect.overtimeHours))) {
		flags.push(
			`Overtime hours entered (${expect.overtimeHours}) was not found in the attachment.`,
		);
	}
	return flags;
}

/**
 * Best-effort OCR + comparison. PDFs are not rasterized (no engine in the
 * stack) so they are flagged for manual review. Any OCR failure is
 * non-fatal and returns an "unavailable" status with a review flag.
 */
export async function ocrAndCompare(
	buf: Buffer,
	type: AttachmentType,
	expect: OcrExpectation,
): Promise<OcrResult> {
	if (type === "application/pdf") {
		return {
			status: "pdf_manual_review",
			text: null,
			flags: [
				"Attachment is a PDF — automatic OCR was not run. Please verify the document against the entered values.",
			],
		};
	}

	try {
		// Lazy-load: only pull the OCR engine when an image is actually processed.
		const { createWorker } = await import("tesseract.js");
		const worker = await createWorker("eng");
		try {
			const { data } = await worker.recognize(buf);
			const text = data.text ?? "";
			return { status: "ok", text: text.slice(0, 5000), flags: compare(text, expect) };
		} finally {
			await worker.terminate();
		}
	} catch (err) {
		log.warn("timesheet OCR failed", { error: String(err) });
		return {
			status: "unavailable",
			text: null,
			flags: [
				"Automated OCR could not be run on this attachment; please verify it manually.",
			],
		};
	}
}
