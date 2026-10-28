import { db } from "@workspace/lib/db/db";
import { secrets } from "@workspace/lib/db/schema";
import {
	clearCredentialOverlay,
	getCredential,
	refreshCredentialOverlay,
	withOrganization,
} from "@workspace/lib/secrets";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../../../routes/api/v1/organizations/$organizationId/credentials/$name";
import type { ApiScope } from "../scopes";

const caller = vi.hoisted(() => ({ auth: null as unknown }));
vi.mock("@/lib/auth/api-auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth/api-auth")>()),
	resolveApiAuth: async () => ({ auth: caller.auth }),
}));

const handlers = Route.options.server?.handlers as Record<
	"PUT" | "DELETE",
	(ctx: { request: Request; params: Record<string, string> }) => Promise<Response>
>;

function keyFor(organizationId: string, scopes: ApiScope[]) {
	caller.auth = {
		kind: "organization",
		organizationId,
		organizationName: organizationId,
		scopes: new Set(scopes),
		brandIds: null,
		rateLimit: { limit: 100, window: "minute" },
		rateLimitRemaining: null,
	};
}

function call(method: "PUT" | "DELETE", organizationId: string, name: string, body?: unknown) {
	return handlers[method]({
		request: new Request("http://localhost/api/v1", {
			method,
			headers: { Authorization: "Bearer test" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		params: { organizationId, name },
	});
}

const readFor = (organizationId: string) => withOrganization(organizationId, () => getCredential("OPENAI_API_KEY"));

beforeEach(() => {
	vi.stubEnv("DEPLOYMENT_MODE", "local");
	vi.stubEnv("ELMO_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
	vi.stubEnv("OPENAI_API_KEY", "instance-key");
});

afterEach(async () => {
	await db.delete(secrets).where(eq(secrets.name, "OPENAI_API_KEY"));
	clearCredentialOverlay();
	vi.unstubAllEnvs();
});

describe("PUT and DELETE /organizations/:organizationId/credentials/:name", () => {
	it("sets the key's own organization's credential, then removes it", async () => {
		keyFor("org-a", ["write"]);

		const set = await call("PUT", "org-a", "OPENAI_API_KEY", { value: "key-for-a" });
		await refreshCredentialOverlay();
		expect(set.status).toBe(200);
		expect(await set.json()).toEqual({ name: "OPENAI_API_KEY" });
		expect(readFor("org-a")).toBe("key-for-a");
		expect(readFor("org-b")).toBe("instance-key");

		await call("PUT", "org-a", "OPENAI_API_KEY", { value: "rotated" });
		await refreshCredentialOverlay();
		expect(readFor("org-a")).toBe("rotated");

		expect((await call("DELETE", "org-a", "OPENAI_API_KEY")).status).toBe(200);
		await refreshCredentialOverlay();
		expect(readFor("org-a")).toBe("instance-key");
	});

	it("answers another organization's id as not found and stores nothing", async () => {
		keyFor("org-a", ["write"]);

		const response = await call("PUT", "org-b", "OPENAI_API_KEY", { value: "planted" });

		expect(response.status).toBe(404);
		expect(await db.select().from(secrets).where(eq(secrets.name, "OPENAI_API_KEY"))).toEqual([]);
	});

	it("refuses a read-only key and a name that is not a provider credential", async () => {
		keyFor("org-a", ["read"]);
		expect((await call("PUT", "org-a", "OPENAI_API_KEY", { value: "x" })).status).toBe(403);

		keyFor("org-a", ["write"]);
		expect((await call("PUT", "org-a", "DATABASE_URL", { value: "x" })).status).toBe(400);
	});
});
