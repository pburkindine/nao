import { env } from '../env';
import type { PolicyContext, PolicyDecision, PolicyOutcome, PolicyQuery, QueryPolicy } from '../types/query-policy';
import { logger, serializeError } from '../utils/logger';
import { containsBlockedPassthroughCall, isReadOnlySqlQuery } from '../utils/sql-filter';
import { createAuthZenQueryPolicy } from './authzen-query-policy';

export class QueryPolicyDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QueryPolicyDeniedError';
	}
}

/**
 * Runs the query past each policy in order and returns the SQL to execute. Any deny wins; a rewrite is passed to
 * the next policy and must stay a read-only query. Fails closed: a policy that errors blocks the query.
 */
export async function authorizeQuery(
	query: PolicyQuery,
	context: PolicyContext,
	policies: QueryPolicy[] = configuredQueryPolicies(),
): Promise<string> {
	let sql = query.sql;
	for (const policy of policies) {
		const decision = await decide(policy, { ...query, sql }, context);
		if (decision.decision === 'deny') {
			throw new QueryPolicyDeniedError(
				`The query was refused by the SQL policy${decision.reason ? `: ${decision.reason}` : '.'}`,
			);
		}
		if (decision.decision === 'rewrite') {
			await assertReadOnlyRewrite(decision.sql);
			sql = decision.sql;
		}
	}
	return sql;
}

/** Fails open: a policy that can't record is logged and the answer goes through. */
export async function recordQuery(
	query: PolicyQuery,
	context: PolicyContext,
	outcome: PolicyOutcome,
	policies: QueryPolicy[] = configuredQueryPolicies(),
): Promise<void> {
	for (const policy of policies) {
		try {
			await policy.record?.(query, context, outcome);
		} catch (error) {
			logPolicyFailure('SQL policy could not record the query', policy, query, context, error);
		}
	}
}

export function configuredQueryPolicies(): QueryPolicy[] {
	if (!env.NAO_SQL_POLICY_URL) {
		return [];
	}
	return [
		createAuthZenQueryPolicy({
			pdpUrl: env.NAO_SQL_POLICY_URL,
			auditUrl: env.NAO_SQL_POLICY_AUDIT_URL,
			token: env.NAO_SQL_POLICY_TOKEN,
			timeoutMs: env.NAO_SQL_POLICY_TIMEOUT_MS,
		}),
	];
}

async function decide(policy: QueryPolicy, query: PolicyQuery, context: PolicyContext): Promise<PolicyDecision> {
	try {
		return await policy.authorize(query, context);
	} catch (error) {
		logPolicyFailure('SQL policy failed; the query was blocked', policy, query, context, error);
		throw new QueryPolicyDeniedError('The query was blocked: the SQL policy check is unavailable.');
	}
}

async function assertReadOnlyRewrite(sql: string): Promise<void> {
	if (containsBlockedPassthroughCall(sql) || !(await isReadOnlySqlQuery(sql))) {
		throw new QueryPolicyDeniedError(
			'The query was blocked: the SQL policy rewrote it into a query that is not read-only.',
		);
	}
}

function logPolicyFailure(
	message: string,
	policy: QueryPolicy,
	query: PolicyQuery,
	context: PolicyContext,
	error: unknown,
): void {
	logger.warn(message, {
		source: 'tool',
		projectId: context.projectId,
		userId: context.userId,
		context: { policy: policy.name, origin: context.origin, queryId: query.queryId, error: serializeError(error) },
	});
}
