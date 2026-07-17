// ─────────────────────────────────────────────────────────────────────────────
// Authentica (authentica.sa) OTP integration.
//   Send:   POST https://api.authentica.sa/api/v2/send-otp
//   Verify: POST https://api.authentica.sa/api/v2/verify-otp
//   Auth:   X-Authorization: <API_KEY>
// Multi-channel: sms | whatsapp | email. Phone numbers in E.164.
// ─────────────────────────────────────────────────────────────────────────────

import { secret } from "encore.dev/config";
import log from "encore.dev/log";

const authenticaApiKey = secret("AUTHENTICA_API_KEY");

const BASE_URL = "https://api.authentica.sa";

export type OtpChannel = "sms" | "whatsapp" | "email";

function apiKey(): string {
	const k = authenticaApiKey();
	if (!k) throw new Error("AUTHENTICA_API_KEY is not configured");
	return k;
}

const REQUEST_TIMEOUT_MS = 12_000;

/** fetch with a hard timeout so a stalled upstream never hangs the endpoint. */
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error("verification service timed out");
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/** Send an OTP over the requested channel. Throws on transport/API failure. */
export async function sendOtp(params: {
	channel: OtpChannel;
	phone?: string;
	email?: string;
}): Promise<void> {
	const body: Record<string, string> = { method: params.channel };
	if (params.channel === "email") {
		if (!params.email) throw new Error("email is required for the email channel");
		body.email = params.email;
	} else {
		if (!params.phone) throw new Error("phone is required for sms/whatsapp");
		body.phone = params.phone;
	}

	const res = await fetchWithTimeout(`${BASE_URL}/api/v2/send-otp`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Authorization": apiKey(),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		log.error("authentica send-otp failed", {
			status: res.status,
			channel: params.channel,
			body: text,
		});
		throw new Error(`failed to send verification code (${res.status})`);
	}
}

/** Verify an OTP. Returns true when Authentica confirms the code. */
export async function verifyOtp(params: {
	otp: string;
	phone?: string;
	email?: string;
}): Promise<boolean> {
	const body: Record<string, string> = { otp: params.otp };
	if (params.email) body.email = params.email;
	if (params.phone) body.phone = params.phone;

	const res = await fetchWithTimeout(`${BASE_URL}/api/v2/verify-otp`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Authorization": apiKey(),
		},
		body: JSON.stringify(body),
	});

	// Read the raw body once so we can both parse it and log it verbatim.
	// Authentica returns the verification result in the 2xx body, so a silent
	// shape mismatch here looks identical to a wrong code — always log it.
	const text = await res.text().catch(() => "");
	if (!res.ok) {
		// A 4xx here usually means an incorrect/expired code.
		log.info("authentica verify-otp rejected", { status: res.status, body: text });
		return false;
	}

	let data: {
		verified?: boolean;
		success?: boolean;
		data?: { verified?: boolean; success?: boolean };
	} = {};
	try {
		data = JSON.parse(text);
	} catch {
		log.error("authentica verify-otp: unparseable body", { status: res.status, body: text });
		return false;
	}

	// Accept the documented top-level shape ({ verified: true } / { success: true })
	// as well as Authentica's occasional { data: { ... } } wrapper. Only an
	// explicit boolean true counts — never weaken this to a truthy check.
	const verified =
		data.verified === true ||
		data.success === true ||
		data.data?.verified === true ||
		data.data?.success === true;

	if (!verified) {
		// 2xx but not recognised as a pass — this is the case that previously
		// failed silently. Log the real body so the actual shape is visible.
		log.warn("authentica verify-otp not verified", { status: res.status, body: text });
	}
	return verified;
}
