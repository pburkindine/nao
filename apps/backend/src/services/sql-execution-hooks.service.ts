import { z } from 'zod/v4';

import { env } from '../env';
import { logger, serializeError } from '../utils/logger';
import { containsBlockedPassthroughCall, isReadOnlySqlQuery } from '../utils/sql-filter';

export interface SqlHookContext {
	userId: string;
	projectId: string;
	chatId: string | null;
	origin: 'agent' | 'story';
}

export interface SqlHookQuery {
	sql: string;
	databaseId?: string;
	queryId?: string;
}

export interface SqlHookOutcome {
	rowCount: number | null;
	columns: string[] | null;
	durationMs: number;
	error: string | null;
}

export interface SqlHookResultOverride {
	columns: string[];
	data: Record<string, unknown>[];
}

const preExecuteResponseSchema = z.discriminatedUnion('decision', [
	z.object({ decision: z.literal('allow'), sql: z.string().trim().min(1).optional() }),
	z.object({ decision: z.literal('deny'), reason: z.string().optional() }),
]);

const postExecuteResponseSchema = z
	.object({ columns: z.array(z.string()), data: z.array(z.record(z.string(), z.unknown())) })
	.partial();

export class SqlHookDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SqlHookDeniedError';
	}
}

/**
 * Returns the SQL to run. Fails closed: a hook that times out, errors or answers unreadably blocks the query,
 * and so does a rewrite that is not read-only.
 */
export async function runPreExecuteHook(query: SqlHookQuery, context: SqlHookContext): Promise<string> {
	const url = env.NAO_SQL_PRE_EXECUTE_URL;
	if (!url) {
		return query.sql;
	}

	const decision = await requestPreExecuteDecision(url, query, context);
	if (decision.decision === 'deny') {
		throw new SqlHookDeniedError(
			`The query was refused by the SQL policy: ${decision.reason ?? 'no reason given'}`,
		);
	}
	if (decision.sql && decision.sql !== query.sql) {
		await assertReadOnlyRewrite(decision.sql);
		return decision.sql;
	}
	return query.sql;
}

/** Fails open: a hook failure is logged and the original result stands. */
export async function runPostExecuteHook(
	query: SqlHookQuery,
	context: SqlHookContext,
	outcome: SqlHookOutcome,
): Promise<SqlHookResultOverride | null> {
	const url = env.NAO_SQL_POST_EXECUTE_URL;
	if (!url) {
		return null;
	}

	try {
		const response = await postHook(url, {
			...hookPayload(query, context),
			row_count: outcome.rowCount,
			columns: outcome.columns,
			duration_ms: outcome.durationMs,
			error: outcome.error,
		});
		const body = await response.text();
		if (!body.trim()) {
			return null;
		}
		const { columns, data } = postExecuteResponseSchema.parse(JSON.parse(body));
		return columns && data ? { columns, data } : null;
	} catch (error) {
		logHookFailure('SQL post-execute hook failed; the result was passed through', query, context, error);
		return null;
	}
}

async function requestPreExecuteDecision(url: string, query: SqlHookQuery, context: SqlHookContext) {
	try {
		const response = await postHook(url, hookPayload(query, context));
		return preExecuteResponseSchema.parse(await response.json());
	} catch (error) {
		logHookFailure('SQL pre-execute hook failed; the query was blocked', query, context, error);
		throw new SqlHookDeniedError('The query was blocked: the SQL policy check is unavailable.');
	}
}

async function assertReadOnlyRewrite(sql: string): Promise<void> {
	if (containsBlockedPassthroughCall(sql) || !(await isReadOnlySqlQuery(sql))) {
		throw new SqlHookDeniedError(
			'The query was blocked: the SQL policy rewrote it into a query that is not read-only.',
		);
	}
}

function hookPayload(query: SqlHookQuery, context: SqlHookContext) {
	return {
		sql: query.sql,
		database_id: query.databaseId ?? null,
		query_id: query.queryId ?? null,
		project_id: context.projectId,
		user_id: context.userId,
		chat_id: context.chatId,
		origin: context.origin,
	};
}

async function postHook(url: string, body: Record<string, unknown>): Promise<Response> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(env.NAO_SQL_HOOK_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`${url} responded ${response.status}`);
	}
	return response;
}

function logHookFailure(message: string, query: SqlHookQuery, context: SqlHookContext, error: unknown): void {
	logger.warn(message, {
		source: 'tool',
		projectId: context.projectId,
		userId: context.userId,
		context: { origin: context.origin, queryId: query.queryId, error: serializeError(error) },
	});
}
