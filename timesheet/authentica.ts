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

	const res = await fetch(`${BASE_URL}/api/v2/send-otp`, {
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
		log.error("authentica send-otp failed", { status: res.status, body: text });
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

	const res = await fetch(`${BASE_URL}/api/v2/verify-otp`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Authorization": apiKey(),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		// A 4xx here usually means an incorrect/expired code.
		const text = await res.text().catch(() => "");
		log.info("authentica verify-otp rejected", { status: res.status, body: text });
		return false;
	}
	const data = (await res.json().catch(() => ({}))) as {
		verified?: boolean;
		success?: boolean;
	};
	return data.verified === true || data.success === true;
}
