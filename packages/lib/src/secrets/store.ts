import { AsyncLocalStorage } from "node:async_hooks";
import { CREDENTIAL_ENV_NAMES } from "@workspace/config/env-registry";
import { and, eq } from "drizzle-orm";
import { db } from "../db/db";
import { secrets } from "../db/schema";
import {
	decryptSecret,
	ENCRYPTION_KEY_ENV,
	type EncryptedPayload,
	EncryptionKeyError,
	encryptSecret,
	getKeyring,
	type Keyring,
	UnknownKeyError,
} from "./crypto";

// Providers read every credential through getCredential: the current
// organization's stored override, else the instance's, else process.env. The
// overlays of stored overrides are rebuilt on an interval by
// refreshCredentialOverlay (see ./refresh), keyed by organization id with '' for
// the instance.
let overlays = new Map<string, Map<string, string>>();
const currentOrganization = new AsyncLocalStorage<string>();

/** Credentials read inside `fn` resolve for this organization first. */
export function withOrganization<T>(organizationId: string, fn: () => T): T {
	return currentOrganization.run(organizationId, fn);
}

/** Current organization's override, else the instance's, else process.env. Sync so `isConfigured()` stays sync. */
export function getCredential(name: string): string | undefined {
	const organizationId = currentOrganization.getStore() ?? "";
	return overlays.get(organizationId)?.get(name) ?? overlays.get("")?.get(name) ?? process.env[name];
}

/** The environment with stored overrides applied, so a startup check counts a
 *  credential saved in the database the same as one set in .env. */
export function withStoredCredentials(
	env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	return { ...env, ...Object.fromEntries(overlays.get("") ?? []) };
}

export function clearCredentialOverlay(): void {
	overlays.clear();
}

/** AAD binds each ciphertext to the env var it stands in for and to its
 *  organization, so a payload can't be replayed under a different name or
 *  organization even by someone with DB write access. The instance scope keeps
 *  the bare `secret:<name>` form, so rows stored before organizations existed
 *  still decrypt. */
function aadForScope(organizationId: string, name: string): string {
	return organizationId ? `secret:${organizationId}:${name}` : `secret:${name}`;
}

/** Rebuild the overlays from the secrets table. A row whose name is not a known
 *  credential, or that will not decrypt, contributes nothing rather than
 *  throwing, so one bad row can't take out the others. The overlay is swapped
 *  only after every row has been read, so a failed load leaves it untouched. */
export async function refreshCredentialOverlay(): Promise<void> {
	let keyring: Keyring | null = null;
	try {
		keyring = getKeyring();
	} catch (e) {
		if (!(e instanceof EncryptionKeyError)) throw e;
		console.error(`[secrets] ${e.message} — every stored credential is unreadable until this is corrected`);
	}
	// No key means nothing can be stored, so there is no query to make.
	if (!keyring) {
		clearCredentialOverlay();
		return;
	}

	const rows = await db
		.select({ organizationId: secrets.organizationId, name: secrets.name, encryptedValue: secrets.encryptedValue })
		.from(secrets);

	const next = new Map<string, Map<string, string>>();
	for (const row of rows) {
		if (!CREDENTIAL_ENV_NAMES.has(row.name)) continue;
		const label = row.organizationId ? `${row.organizationId}/${row.name}` : row.name;
		try {
			const value = await decryptSecret(row.encryptedValue, {
				keyring,
				aad: aadForScope(row.organizationId, row.name),
			});
			const scope = next.get(row.organizationId) ?? new Map<string, string>();
			next.set(row.organizationId, scope.set(row.name, value));
		} catch (e) {
			console.error(
				e instanceof UnknownKeyError
					? `[secrets] stored secret "${label}" is ${e.message} — restore that key there to finish the rotation`
					: `[secrets] stored secret "${label}" will not decrypt under the key it names — it may be corrupt or tampered with`,
			);
		}
	}

	overlays = next;
}

/** Encrypt one credential for the write path, for the instance by default. Throws
 *  when the name is not an overridable credential, or when no encryption key is set. */
export async function encryptCredential(name: string, value: string, organizationId = ""): Promise<EncryptedPayload> {
	if (!CREDENTIAL_ENV_NAMES.has(name)) {
		throw new Error(`"${name}" is not an overridable credential`);
	}
	const keyring = getKeyring();
	if (!keyring) {
		throw new EncryptionKeyError(`${ENCRYPTION_KEY_ENV} is not set — cannot store encrypted credentials`);
	}
	return encryptSecret(value, { key: keyring.primary, aad: aadForScope(organizationId, name) });
}

/** Store an organization's override of one credential, replacing any it already has. */
export async function setOrganizationCredential(organizationId: string, name: string, value: string): Promise<void> {
	const encryptedValue = await encryptCredential(name, value, organizationId);
	await db
		.insert(secrets)
		.values({ organizationId, name, encryptedValue })
		.onConflictDoUpdate({ target: [secrets.organizationId, secrets.name], set: { encryptedValue } });
}

/** Remove an organization's override, so it falls back to the instance's. */
export async function deleteOrganizationCredential(organizationId: string, name: string): Promise<void> {
	await db.delete(secrets).where(and(eq(secrets.organizationId, organizationId), eq(secrets.name, name)));
}
