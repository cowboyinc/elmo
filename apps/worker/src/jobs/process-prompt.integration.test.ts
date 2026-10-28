import { randomUUID } from "node:crypto";
import { db } from "@workspace/lib/db/db";
import { brands, organization, promptRuns, prompts, secrets } from "@workspace/lib/db/schema";
import {
	clearCredentialOverlay,
	encryptCredential,
	getCredential,
	refreshCredentialOverlay,
	setOrganizationCredential,
} from "@workspace/lib/secrets";
import { eq, inArray } from "drizzle-orm";
import type { Job } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProcessPromptData, processPromptJob } from "./process-prompt";

vi.mock("../boss", () => ({
	getBoss: () => ({ send: vi.fn().mockResolvedValue("job-id"), insert: vi.fn().mockResolvedValue(null) }),
}));

const keysSeen = vi.hoisted(() => new Map<string, string | undefined>());
vi.mock("@workspace/lib/providers", async (importOriginal) => {
	const original = await importOriginal<typeof import("@workspace/lib/providers")>();
	return {
		...original,
		getProvider: (id: string) =>
			id === "openai-api"
				? {
						isConfigured: () => true,
						run: async (_model: string, prompt: string) => {
							await new Promise((resolve) => setTimeout(resolve, prompt.includes("slow") ? 30 : 1));
							keysSeen.set(prompt, getCredential("OPENAI_API_KEY"));
							return { rawOutput: {}, webQueries: [] };
						},
					}
				: original.getProvider(id),
	};
});

async function createBrandWithPrompt(label: string): Promise<{ orgId: string; promptId: string }> {
	const orgId = `org-${randomUUID()}`;
	await db.insert(organization).values({ id: orgId, name: label, slug: orgId, createdAt: new Date() });
	await db.insert(brands).values({
		id: orgId,
		organizationId: orgId,
		name: label,
		website: "https://acme.example",
		onboarded: true,
	});
	const [{ id: promptId }] = await db
		.insert(prompts)
		.values({ brandId: orgId, value: label })
		.returning({ id: prompts.id });
	return { orgId, promptId };
}

const job = (promptId: string) => ({ data: { promptId } }) as Job<ProcessPromptData>;

const created: string[] = [];

beforeEach(() => {
	vi.stubEnv("ELMO_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
	vi.stubEnv("DEPLOYMENT_MODE", "local");
	vi.stubEnv("SCRAPE_TARGETS", "chatgpt:openai-api");
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	keysSeen.clear();
});

afterEach(async () => {
	if (created.length > 0) {
		await db.delete(secrets).where(inArray(secrets.organizationId, [...created, ""]));
		await db.delete(promptRuns).where(inArray(promptRuns.brandId, created));
		await db.delete(prompts).where(inArray(prompts.brandId, created));
		await db.delete(brands).where(inArray(brands.id, created));
		await db.delete(organization).where(inArray(organization.id, created));
		created.length = 0;
	}
	clearCredentialOverlay();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("processPromptJob credentials", () => {
	it("runs each brand's prompt with its own organization's key, and the instance's where it has none", async () => {
		const a = await createBrandWithPrompt("slow prompt for A");
		const b = await createBrandWithPrompt("prompt for B");
		created.push(a.orgId, b.orgId);
		await db.insert(secrets).values({
			organizationId: "",
			name: "OPENAI_API_KEY",
			encryptedValue: await encryptCredential("OPENAI_API_KEY", "instance-key"),
		});
		await setOrganizationCredential(a.orgId, "OPENAI_API_KEY", "key-for-a");
		await refreshCredentialOverlay();

		await Promise.all([processPromptJob([job(a.promptId)]), processPromptJob([job(b.promptId)])]);

		expect(Object.fromEntries(keysSeen)).toEqual({
			"slow prompt for A": "key-for-a",
			"prompt for B": "instance-key",
		});
		expect(getCredential("OPENAI_API_KEY")).toBe("instance-key");
		const saved = await db
			.selectDistinct({ brandId: promptRuns.brandId })
			.from(promptRuns)
			.where(inArray(promptRuns.brandId, created));
		expect(saved.map((run) => run.brandId).sort()).toEqual([a.orgId, b.orgId].sort());
	});

	it("runs a brand whose provider key exists only for its organization, calling the provider with that key", async () => {
		const a = await createBrandWithPrompt("prompt for A");
		created.push(a.orgId);
		vi.stubEnv("SCRAPE_TARGETS", "chatgpt:openrouter:openai/gpt-5");
		vi.stubEnv("OPENROUTER_API_KEY", "");
		await setOrganizationCredential(a.orgId, "OPENROUTER_API_KEY", "openrouter-key-for-a");
		await refreshCredentialOverlay();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({ choices: [{ message: { content: "Acme" } }], model: "gpt-5" }));

		await processPromptJob([job(a.promptId)]);

		const authorizations = fetchSpy.mock.calls.map(
			([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization,
		);
		expect(new Set(authorizations)).toEqual(new Set(["Bearer openrouter-key-for-a"]));
		const saved = await db.select({ id: promptRuns.id }).from(promptRuns).where(eq(promptRuns.brandId, a.orgId));
		expect(saved).toHaveLength(authorizations.length);
	});

	it("skips a target whose provider has no key for the organization or the instance, without calling the provider", async () => {
		const a = await createBrandWithPrompt("prompt for A");
		created.push(a.orgId);
		vi.stubEnv("SCRAPE_TARGETS", "chatgpt:openrouter:openai/gpt-5");
		vi.stubEnv("OPENROUTER_API_KEY", "");
		await refreshCredentialOverlay();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await processPromptJob([job(a.promptId)]);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith(
			`Skipping chatgpt:openrouter: no credential for openrouter in organization ${a.orgId} or instance`,
		);
		expect(await db.select().from(promptRuns).where(eq(promptRuns.brandId, a.orgId))).toEqual([]);
	});
});
