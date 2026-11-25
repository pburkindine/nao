import type { WarehouseColumnSecurity, WarehouseRowSecurity } from '@nao/shared';

import { env } from '../env';
import type { PolicyContext, PolicyOutcome } from '../types/query-policy';
import { assertWarehouseTableAccess, type WarehouseTableAccess } from './context-access';
import { authorizeQuery, recordQuery } from './query-policy.service';
import { type RunSqlQueryTag, serializeRunSqlQueryTag } from './sql-query-tag.service';

interface WarehouseSqlOptions {
	projectFolder: string;
	databaseId?: string;
	envVars?: Record<string, string>;
	warehouseAccessToken?: string | null;
	enforceExcludedColumns: boolean;
	tableAccess: WarehouseTableAccess;
	columnSecurity: WarehouseColumnSecurity;
	rowSecurity: WarehouseRowSecurity;
	queryTag?: RunSqlQueryTag | null;
}

export interface WarehouseSqlResult {
	data: Record<string, unknown>[];
	row_count: number;
	columns: string[];
	dialect?: string;
}

export interface WarehouseSqlValidation {
	valid: true;
	dialect: string;
}

export class WarehouseSqlError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'WarehouseSqlError';
	}
}

interface WarehouseSqlExecutionOptions extends WarehouseSqlOptions {
	/** Required, so no warehouse query can run without the user and origin the SQL policy decides for. */
	policy: PolicyContext;
	queryId?: string;
}

/** Runs a warehouse query past the deployment's SQL policy, then records how it went; `executedSql` is what ran. */
export async function executeWarehouseSql(
	sql: string,
	options: WarehouseSqlExecutionOptions,
): Promise<WarehouseSqlResult & { executedSql: string }> {
	const query = { sql, databaseId: options.databaseId, queryId: options.queryId };
	const executedSql = await authorizeQuery(query, options.policy);
	const executedQuery = { ...query, sql: executedSql };
	const startedAt = performance.now();
	const elapsed = () => Math.round(performance.now() - startedAt);

	let result: WarehouseSqlResult;
	try {
		result = await requestWarehouseSql<WarehouseSqlResult>('/execute_sql', executedSql, options);
	} catch (error) {
		await recordQuery(executedQuery, options.policy, failedOutcome(error, elapsed()));
		throw error;
	}
	await recordQuery(executedQuery, options.policy, {
		rowCount: result.row_count,
		columns: result.columns,
		durationMs: elapsed(),
		error: null,
	});
	return { ...result, executedSql };
}

export async function validateWarehouseSql(sql: string, options: WarehouseSqlOptions): Promise<WarehouseSqlValidation> {
	return requestWarehouseSql<WarehouseSqlValidation>('/validate_sql', sql, options);
}

export async function validateWarehouseRowPredicate(
	predicate: string,
	constraintColumns: string[],
	databaseType: string,
): Promise<string> {
	const response = await fetch(`http://localhost:${env.FASTAPI_PORT}/validate_row_predicate`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Nao-Internal-Secret': env.BETTER_AUTH_SECRET,
		},
		body: JSON.stringify({
			predicate,
			constraint_columns: constraintColumns,
			database_type: databaseType,
		}),
	});
	if (!response.ok) {
		const errorData = await response.json().catch(() => ({ detail: response.statusText }));
		throw new WarehouseSqlError(
			response.status,
			`Warehouse row predicate denied: ${describeError(errorData.detail)}`,
		);
	}
	const result = (await response.json()) as { normalized_predicate: string };
	return result.normalized_predicate;
}

async function requestWarehouseSql<T>(
	path: '/execute_sql' | '/validate_sql',
	sql: string,
	options: WarehouseSqlOptions,
): Promise<T> {
	const response = await fetch(`http://localhost:${env.FASTAPI_PORT}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Nao-Internal-Secret': env.BETTER_AUTH_SECRET,
		},
		body: JSON.stringify({
			sql,
			nao_project_folder: options.projectFolder,
			enforce_excluded_columns: options.enforceExcludedColumns,
			table_access: serializeTableAccess(assertWarehouseTableAccess(options.tableAccess)),
			column_security: serializeColumnSecurity(options.columnSecurity),
			row_security: serializeRowSecurity(options.rowSecurity),
			...(options.databaseId && { database_id: options.databaseId }),
			...(options.envVars && Object.keys(options.envVars).length > 0 && { env_vars: options.envVars }),
			...(options.warehouseAccessToken && { user_access_token: options.warehouseAccessToken }),
			...(options.queryTag && { query_tag: serializeRunSqlQueryTag(options.queryTag, options.databaseId) }),
		}),
	});

	if (!response.ok) {
		const errorData = await response.json().catch(() => ({ detail: response.statusText }));
		throw new WarehouseSqlError(
			response.status,
			`Warehouse SQL request denied: ${describeError(errorData.detail)}`,
		);
	}

	return response.json() as Promise<T>;
}

function failedOutcome(error: unknown, durationMs: number): PolicyOutcome {
	return {
		rowCount: null,
		columns: null,
		durationMs,
		error: error instanceof Error ? error.message : String(error),
	};
}

function serializeColumnSecurity(columnSecurity: WarehouseColumnSecurity) {
	if (columnSecurity.enforced === false) {
		return { enforced: false as const };
	}
	return {
		enforced: true as const,
		tables: columnSecurity.tables.map((table) => ({
			database_type: table.databaseType,
			database: table.database,
			schema: table.schema,
			table: table.table,
			restricted_columns: table.restrictedColumns,
			access: table.access,
			...(table.access === 'restricted' ? { denied_columns: table.deniedColumns } : {}),
			...(table.access === 'blocked' ? { reason: table.reason } : {}),
		})),
	};
}

function serializeRowSecurity(rowSecurity: WarehouseRowSecurity) {
	if (rowSecurity.enforced === false) {
		return { enforced: false as const };
	}
	return {
		enforced: true as const,
		tables: rowSecurity.tables.map((table) => ({
			database_type: table.databaseType,
			database: table.database,
			schema: table.schema,
			table: table.table,
			constraint_columns: table.constraintColumns,
			access: table.access,
			...(table.access === 'predicate' ? { predicate: table.predicate } : {}),
			...(table.access === 'blocked' ? { reason: table.reason } : {}),
		})),
	};
}

function serializeTableAccess(access: WarehouseTableAccess) {
	const enforced = (access as { enforced: unknown }).enforced;
	if (enforced === false) {
		return { enforced: false as const };
	}
	if (
		enforced === true &&
		'strict' in access &&
		typeof access.strict === 'boolean' &&
		'tables' in access &&
		Array.isArray(access.tables)
	) {
		if (!access.strict) {
			return { enforced: false as const };
		}
		return {
			enforced: true as const,
			tables: access.tables.map((table) => ({
				database_type: table.databaseType,
				database: table.database,
				schema: table.schema,
				table: table.table,
			})),
		};
	}
	throw new Error('Warehouse table access has an invalid enforced discriminant.');
}

function describeError(detail: unknown): string {
	return typeof detail === 'string' ? detail : JSON.stringify(detail);
}
