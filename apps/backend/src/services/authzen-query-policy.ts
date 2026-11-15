import { z } from 'zod/v4';

import { getUser } from '../queries/user.queries';
import {
	type PolicyContext,
	type PolicyDecision,
	type PolicyOutcome,
	type PolicyQuery,
	QUERY_POLICY_VERSION,
	type QueryPolicy,
} from '../types/query-policy';

interface AuthZenQueryPolicyOptions {
	pdpUrl: string;
	auditUrl?: string;
	token?: string;
	timeoutMs: number;
}

/** AuthZEN leaves `context` to the implementation: nao reads a refusal reason and an optional rewrite from it. */
const evaluationResponseSchema = z.object({
	decision: z.boolean(),
	context: z.object({ reason: z.string().optional(), sql: z.string().trim().min(1).optional() }).optional(),
});

/** A policy decision point reached over the OpenID AuthZEN 1.0 Access Evaluation API, with an optional audit endpoint. */
export function createAuthZenQueryPolicy(options: AuthZenQueryPolicyOptions): QueryPolicy {
	const auditUrl = options.auditUrl;
	return {
		name: 'authzen',
		authorize: async (query, context) => {
			const body = await buildEvaluationRequest(query, context);
			const response = await post(evaluationEndpoint(options.pdpUrl), body, options);
			return toDecision(evaluationResponseSchema.parse(await response.json()));
		},
		...(auditUrl && {
			record: async (query, context, outcome) => {
				await post(auditUrl, buildAuditRecord(query, context, outcome), options);
			},
		}),
	};
}

async function buildEvaluationRequest(query: PolicyQuery, context: PolicyContext) {
	const user = await getUser({ id: context.userId });
	return {
		subject: { type: 'user', id: context.userId, properties: { email: user?.email ?? null } },
		action: { name: 'execute_sql' },
		resource: { type: 'database', id: query.databaseId ?? 'default', properties: { sql: query.sql } },
		context: {
			nao_policy_version: QUERY_POLICY_VERSION,
			origin: context.origin,
			project_id: context.projectId,
			chat_id: context.chatId,
			query_id: query.queryId ?? null,
		},
	};
}

function buildAuditRecord(query: PolicyQuery, context: PolicyContext, outcome: PolicyOutcome) {
	return {
		nao_policy_version: QUERY_POLICY_VERSION,
		sql: query.sql,
		database_id: query.databaseId ?? null,
		query_id: query.queryId ?? null,
		user_id: context.userId,
		project_id: context.projectId,
		chat_id: context.chatId,
		origin: context.origin,
		row_count: outcome.rowCount,
		columns: outcome.columns,
		duration_ms: outcome.durationMs,
		error: outcome.error,
	};
}

function toDecision(evaluation: z.infer<typeof evaluationResponseSchema>): PolicyDecision {
	const reason = evaluation.context?.reason;
	if (!evaluation.decision) {
		return { decision: 'deny', reason };
	}
	const rewrite = evaluation.context?.sql;
	return rewrite ? { decision: 'rewrite', sql: rewrite, reason } : { decision: 'allow' };
}

async function post(url: string, body: unknown, options: AuthZenQueryPolicyOptions): Promise<Response> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(options.token && { Authorization: `Bearer ${options.token}` }),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(options.timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`${url} responded ${response.status}`);
	}
	return response;
}

function evaluationEndpoint(pdpUrl: string): string {
	return new URL('access/v1/evaluation', pdpUrl.endsWith('/') ? pdpUrl : `${pdpUrl}/`).toString();
}
