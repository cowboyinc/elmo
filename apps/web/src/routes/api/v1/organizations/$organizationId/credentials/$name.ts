/**
 * /api/v1/organizations/:organizationId/credentials/:name
 *
 * PUT     store the organization's own value for a provider credential
 * DELETE  remove it, so the organization falls back to the instance's value
 */
import { createFileRoute } from "@tanstack/react-router";
import { CREDENTIAL_ENV_NAMES } from "@workspace/config/env-registry";
import { deleteOrganizationCredential, EncryptionKeyError, setOrganizationCredential } from "@workspace/lib/secrets";
import { z } from "zod";
import { ApiError, createApiHandler, withMethodGuard } from "@/lib/api/handler";
import { requireOrganizationInScope } from "@/lib/api/scope";

const credentialParams = z.object({
	organizationId: z.string(),
	name: z.string().refine((name) => CREDENTIAL_ENV_NAMES.has(name), "Not an overridable credential"),
});

const credentialBody = z.object({ value: z.string().min(1, "value must be a non-empty string") });

const mapError = (err: unknown) =>
	err instanceof EncryptionKeyError ? new ApiError(409, "Conflict", err.message) : undefined;

export const Route = createFileRoute("/api/v1/organizations/$organizationId/credentials/$name")({
	server: {
		handlers: withMethodGuard({
			PUT: createApiHandler({
				params: credentialParams,
				body: credentialBody,
				scopes: ["write"],
				mapError,
				handle: async ({ params, body, auth }) => {
					requireOrganizationInScope(auth, params.organizationId);
					await setOrganizationCredential(params.organizationId, params.name, body.value);
					return { name: params.name };
				},
			}),

			DELETE: createApiHandler({
				params: credentialParams,
				scopes: ["write"],
				handle: async ({ params, auth }) => {
					requireOrganizationInScope(auth, params.organizationId);
					await deleteOrganizationCredential(params.organizationId, params.name);
					return { name: params.name };
				},
			}),
		}),
	},
});
