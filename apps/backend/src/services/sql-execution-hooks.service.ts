import { z } from 'zod/v4';

import { env } from '../env';
import { logger, serializeError } from '../utils/logger';

export interface SqlHookContext {
	queryId: string;
	databaseId?: string;
	projectId: string;
	userId: string;
	chatId: string | null;
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

/** Fails closed: a hook that times out, errors or answers unreadably blocks the query. */
export async function runPreExecuteHook(sql: string, context: SqlHookContext): Promise<string> {
	const url = env.NAO_SQL_PRE_EXECUTE_URL;
	if (!url) {
		return sql;
	}

	let decision: z.infer<typeof preExecuteResponseSchema>;
	try {
		const response = await postHook(url, { sql, ...hookIds(context) });
		if (!response.ok) {
			throw new Error(`responded ${response.status}`);
		}
		decision = preExecuteResponseSchema.parse(await response.json());
	} catch (error) {
		logger.warn('SQL pre-execute hook failed; the query was blocked', {
			source: 'tool',
			projectId: context.projectId,
			userId: context.userId,
			context: { queryId: context.queryId, error: serializeError(error) },
		});
		throw new SqlHookDeniedError('The query was blocked: the SQL policy check is unavailable.');
	}

	if (decision.decision === 'deny') {
		throw new SqlHookDeniedError(
			`The query was refused by the SQL policy: ${decision.reason ?? 'no reason given'}`,
		);
	}
	return decision.sql ?? sql;
}

/** Fails open: a hook failure is logged and the original result stands. */
export async function runPostExecuteHook(
	sql: string,
	context: SqlHookContext,
	outcome: SqlHookOutcome,
): Promise<SqlHookResultOverride | null> {
	const url = env.NAO_SQL_POST_EXECUTE_URL;
	if (!url) {
		return null;
	}

	try {
		const response = await postHook(url, {
			sql,
			...hookIds(context),
			row_count: outcome.rowCount,
			columns: outcome.columns,
			duration_ms: outcome.durationMs,
			error: outcome.error,
		});
		if (!response.ok) {
			throw new Error(`responded ${response.status}`);
		}
		const body = await response.text();
		if (!body.trim()) {
			return null;
		}
		const { columns, data } = postExecuteResponseSchema.parse(JSON.parse(body));
		return columns && data ? { columns, data } : null;
	} catch (error) {
		logger.warn('SQL post-execute hook failed; the result was passed through', {
			source: 'tool',
			projectId: context.projectId,
			userId: context.userId,
			context: { queryId: context.queryId, error: serializeError(error) },
		});
		return null;
	}
}

function hookIds(context: SqlHookContext) {
	return {
		database_id: context.databaseId ?? null,
		query_id: context.queryId,
		project_id: context.projectId,
		user_id: context.userId,
		chat_id: context.chatId,
	};
}

function postHook(url: string, body: Record<string, unknown>): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(env.NAO_SQL_HOOK_TIMEOUT_MS),
	});
}
