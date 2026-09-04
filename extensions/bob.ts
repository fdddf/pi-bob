/**
 * IBM Bob provider for pi, with SSO login and automatic token refresh.
 *
 * The login flow is not standard OAuth: no client_id, no PKCE, no /authorize.
 * Bob hands the client a one-shot `code` on a loopback callback and trades it
 * for a JWT. See README.md for the full sequence.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// dist/bob.js: DEFAULT_GATEWAY_BASE_URL / DEFAULT_WEB_LOGIN_URL, overridable by these same env vars.
const GATEWAY = process.env.VITE_GATEWAY_BASE_URL ?? "https://api.us-east.bob.ibm.com";
const WEB_LOGIN = process.env.VITE_WEB_LOGIN_URL ?? "https://bob.ibm.com";

// AuthManager.baseUrl = `${gatewayBaseUrl}/authn`
const AUTHN = `${GATEWAY}/authn`;
const LOGIN_PATH = "login";            // AUTH_LOGIN_PATH
const TOKEN_PATH = "v1/auth/token";    // AUTH_TOKEN_PATH
const REFRESH_PATH = "v1/auth/refresh"; // AUTH_REFRESH_PATH
const CALLBACK_PATH = "/bob-callback"; // AUTH_CALLBACK_PATH

const UA = "Mozilla/5.0 (compatible; bob-client/1.0)";
// Verified 2026-09-02: the WAF in front of /inference/v1 rejects "BobShell/1.0" and "node" with a
// Cloudflare 403 while accepting this and "axios/1.7.7". /authn and /admin/v1 are more permissive,
// but one UA for everything keeps it simple.
const SSO_TIMEOUT_MS = 900_000; // bob.js: kic
const MANUAL_ENTRY_DELAY_MS = 15_000; // bob.js: Ric

const CACHE_DIR = join(homedir(), ".pi", "agent");
const INSTANCE_FILE = join(CACHE_DIR, "bob-instance-id");
const TEAM_FILE = join(CACHE_DIR, "bob-team-id");

interface TokenResponse {
	token: string; // the JWT actually sent as `Authorization: Bearer …`
	refresh_token: string;
	idp_access_token?: string; // upstream IdP tokens — bob keeps them, the gateway does not want them
	idp_id_token?: string;
}

/** bob.js decodes `token` and requires the `user` and `exp` claims. */
function jwtClaims(token: string): { user: string; exp: number } {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("malformed JWT");
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	if (!claims.user || !claims.exp) throw new Error("JWT missing required claims (user, exp)");
	return claims;
}

/**
 * Loopback callback server. bob.js binds port 0 on 127.0.0.1 and passes the
 * resulting URL to the login page as `callback_uri`, so no port is registered
 * anywhere and any ephemeral one works.
 */
function startCallbackServer(): Promise<{ port: number; wait: Promise<URLSearchParams>; close(): void }> {
	return new Promise((ready, fail) => {
		let resolveParams: (p: URLSearchParams) => void;
		let rejectParams: (e: Error) => void;
		const wait = new Promise<URLSearchParams>((res, rej) => {
			resolveParams = res;
			rejectParams = rej;
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><body>Signed in to Bob. You can close this tab.</body></html>");
			resolveParams(url.searchParams);
		});

		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") return fail(new Error("Failed to get server address"));
			const timer = setTimeout(() => rejectParams(new Error("SSO login timed out")), SSO_TIMEOUT_MS);
			timer.unref?.();
			ready({ port: addr.port, wait, close: () => { clearTimeout(timer); server.close(); } });
		});
	});
}

function openBrowser(url: string) {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<TokenResponse> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": UA },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
	return (await res.json()) as TokenResponse;
}

function toCredentials(t: TokenResponse): OAuthCredentials {
	return { access: t.token, refresh: t.refresh_token, expires: jwtClaims(t.token).exp * 1000 };
}

/**
 * Bearer auth alone is not enough: the gateway also wants x-instance-id /
 * x-team-id for routing and budgeting. bob.js pulls them from
 * UserProfileService (GET /admin/v1/profile); we cache them to files so the
 * provider's `!cat …` headers can read them back on every request.
 */
async function cacheProfileIds(access: string) {
	const res = await fetch(`${GATEWAY}/admin/v1/profile`, {
		headers: { Authorization: `Bearer ${access}`, "User-Agent": UA },
	});
	if (!res.ok) throw new Error(`profile ${res.status}: ${await res.text()}`);
	const profile = (await res.json()) as {
		user_id: string;
		instances: { instance_id: string; teams?: { id: string }[] }[];
	};
	const instance = profile.instances?.[0];
	if (!instance) throw new Error("no instance on this Bob account");
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(INSTANCE_FILE, instance.instance_id);
	writeFileSync(TEAM_FILE, instance.teams?.[0]?.id ?? "");
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("bob", {
		name: "IBM Bob",
		baseUrl: `${GATEWAY}/inference/v1`,
		api: "openai-completions",
		authHeader: true, // pi sends `Authorization: Bearer <access>`, matching BearerAuthStrategy
		headers: {
			"x-instance-id": `!cat ${INSTANCE_FILE}`,
			"x-team-id": `!cat ${TEAM_FILE}`,
			"User-Agent": UA,
		},
		models: [
			{
				id: "premium-ide",
				name: "Bob Premium (Claude Sonnet)",
				reasoning: false,
				input: ["text", "image"],
				contextWindow: 200000,
				maxTokens: 32000,
				cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
				// pi reads `compat` per model, not per provider. The gateway validates the
				// request body strictly and answers any unknown property with a bodyless 422,
				// so anything OpenAI-only has to be turned off here.
				compat: {
					supportsStrictMode: false, // `tools[].function.strict` → 422
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					maxTokensField: "max_tokens",
				},
			},
		],
		oauth: {
			name: "IBM Bob (SSO)",

			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				const state = randomUUID();
				const server = await startCallbackServer();
				try {
					const callbackUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
					const url = `${WEB_LOGIN}/${LOGIN_PATH}?${new URLSearchParams({ callback_uri: callbackUri, state })}`;

					callbacks.onAuth({ url });
					openBrowser(url);
					callbacks.onProgress?.("Complete sign-in in your browser…");

					// bob.js races the loopback callback against a manual paste of the whole redirected URL.
					const manual = new Promise<URLSearchParams>((resolve, reject) => {
						const timer = setTimeout(async () => {
							try {
								const pasted = await callbacks.onPrompt({
									message: "Or paste the full callback URL from your browser:",
								});
								if (pasted) resolve(new URL(pasted).searchParams);
							} catch (e) {
								reject(e as Error);
							}
						}, MANUAL_ENTRY_DELAY_MS);
						timer.unref?.();
					});

					const params = await Promise.race([server.wait, manual]);

					if (params.get("state") !== state) throw new Error("State parameter mismatch — possible CSRF attack");
					const error = params.get("error");
					if (error) throw new Error(params.get("error_description") ?? error);
					const code = params.get("code");
					if (!code) throw new Error("Missing authorization code in callback");

					const creds = toCredentials(await postJson(`${AUTHN}/${TOKEN_PATH}`, { code }));
					await cacheProfileIds(creds.access);
					callbacks.onProgress?.(`Logged in as ${jwtClaims(creds.access).user}`);
					return creds;
				} finally {
					server.close();
				}
			},

			async refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
				const creds = toCredentials(
					await postJson(`${AUTHN}/${REFRESH_PATH}`, { refresh_token: credentials.refresh }, signal),
				);
				await cacheProfileIds(creds.access);
				return creds;
			},

			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},
		},
	});
}
