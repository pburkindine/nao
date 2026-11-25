import { LOCAL_DATABASE_ID } from '@nao/shared/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/license.service', () => ({
	hasFeature: vi.fn(async () => false),
	LICENSE_FEATURES: { excludeColumns: 'exclude-columns' },
}));
vi.mock('../../src/queries/execute-sql.queries', () => ({
	EXECUTE_SEMANTIC_QUERY_TOOL_NAME: 'execute_semantic_query',
	getExecuteSqlPartByQueryIdInChat: vi.fn(async () => null),
	updateExecuteSqlPart: vi.fn(),
}));
vi.mock('../../src/queries/project.queries', () => ({
	getAgentSettings: vi.fn(),
}));
vi.mock('../../src/agents/tools/query-app-db', () => ({
	queryAppDb: vi.fn(),
}));
vi.mock('../../src/services/local-query.service', () => ({
	runQueryOnLocalFiles: vi.fn(),
}));
vi.mock('../../src/utils/logger', async () => ({
	...(await import('../helpers/logger-mock')),
	serializeError: (error: unknown) => ({ message: String(error) }),
}));

import executeSqlTool, { executeQuery } from '../../src/agents/tools/execute-sql';
import { env } from '../../src/env';
import { getExecuteSqlPartByQueryIdInChat, updateExecuteSqlPart } from '../../src/queries/execute-sql.queries';
import { hasFeature, LICENSE_FEATURES } from '../../src/services/license.service';
import { runQueryOnLocalFiles } from '../../src/services/local-query.service';
import type { WarehouseTableAccess } from '../../src/services/user-group-context-access.service';
import type { ToolContext } from '../../src/types/tools';
import { logger } from '../../src/utils/logger';
import { createToolContext, executeTool } from '../helpers/tool-context';

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('execute_sql excluded-column enforcement', () => {
	it.each([
		{ licensed: false, storedSetting: true, expected: false },
		{ licensed: true, storedSetting: undefined, expected: true },
		{ licensed: true, storedSetting: false, expected: false },
		{ licensed: true, storedSetting: true, expected: true },
	] as const)(
		'sends $expected when licensed=$licensed and stored setting=$storedSetting',
		async ({ licensed, storedSetting, expected }) => {
			vi.mocked(hasFeature).mockResolvedValue(licensed);
			const fetch = stubWarehouseFetch();

			await executeQuery({ sql_query: 'SELECT 1' }, createLicenseContext(storedSetting));

			expect(hasFeature).toHaveBeenCalledWith(LICENSE_FEATURES.excludeColumns, { projectId: 'project-1' });
			expect(sentBody(fetch)).toMatchObject({ enforce_excluded_columns: expected });
		},
	);

	it.each([
		{
			name: 'unlicensed bypass',
			access: { enforced: false } as WarehouseTableAccess,
			expected: { enforced: false },
		},
		{
			name: 'licensed strict restricted empty',
			access: { enforced: true, strict: true, tables: [] } as WarehouseTableAccess,
			expected: { enforced: true, tables: [] },
		},
		{
			name: 'licensed non-strict filtered access',
			access: {
				enforced: true,
				strict: false,
				tables: [{ databaseType: 'postgres', database: 'analytics', schema: 'public', table: 'orders' }],
			} as WarehouseTableAccess,
			expected: { enforced: false },
		},
		{
			name: 'licensed expanded schema or table grants',
			access: {
				enforced: true,
				strict: true,
				tables: [{ databaseType: 'postgres', database: 'analytics', schema: 'public', table: 'orders' }],
			} as WarehouseTableAccess,
			expected: {
				enforced: true,
				tables: [{ database_type: 'postgres', database: 'analytics', schema: 'public', table: 'orders' }],
			},
		},
	])('sends server-resolved table access for $name', async ({ access, expected }) => {
		vi.mocked(hasFeature).mockResolvedValue(false);
		const fetch = stubWarehouseFetch();

		await executeQuery({ sql_query: 'SELECT 1' }, createLicenseContext(undefined, access));

		expect(sentBody(fetch).table_access).toEqual(expected);
	});

	it('rejects an unsafe malformed access discriminant before sending', async () => {
		vi.mocked(hasFeature).mockResolvedValue(false);
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const malformedAccess = { enforced: 0 } as unknown as WarehouseTableAccess;

		await expect(
			executeQuery({ sql_query: 'SELECT 1' }, createLicenseContext(undefined, malformedAccess)),
		).rejects.toThrow('invalid enforced discriminant');
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('execute_sql in-place edit of a query created in the current turn', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ data: [{ n: 1 }], row_count: 1, columns: ['n'] })),
		);
	});

	it('re-runs a same-turn SQL query under its id when it is not persisted yet', async () => {
		const context = createToolContext();
		const created = await executeQuery({ sql_query: 'SELECT 1 AS n' }, context);

		const edited = await executeTool(executeSqlTool, { sql_query: 'SELECT 2 AS n', query_id: created.id }, context);

		expect(getExecuteSqlPartByQueryIdInChat).toHaveBeenCalledWith('chat-1', created.id);
		expect(edited.id).toBe(created.id);
		expect(context.queryResults.get(created.id)).toEqual({
			columns: ['n'],
			data: [{ n: 1 }],
			sqlQuery: 'SELECT 2 AS n',
		});
		expect(updateExecuteSqlPart).not.toHaveBeenCalled();
	});

	it('refuses to edit a same-turn semantic query as SQL', async () => {
		const context = createToolContext();
		const created = await executeQuery({ sql_query: 'SELECT 1 AS n' }, context, {
			semanticQuery: { metrics: ['orders'] },
		});

		await expect(
			executeTool(executeSqlTool, { sql_query: 'SELECT 2 AS n', query_id: created.id }, context),
		).rejects.toThrow(`Query ${created.id} is a semantic query and cannot be edited as SQL`);
	});

	it('still reports unknown query ids', async () => {
		await expect(
			executeTool(
				executeSqlTool,
				{ sql_query: 'SELECT 2 AS n', query_id: 'query_missing0' },
				createToolContext(),
			),
		).rejects.toThrow('Query query_missing0 not found in this chat');
	});
});

describe('execute_sql blocks catalog/server-passthrough calls unconditionally', () => {
	const exploitSql =
		"SELECT * FROM postgres_query('__ducklake_metadata_lake', 'SELECT rolname, rolpassword FROM pg_authid')";

	it.each([
		[
			'rejects the exploit payload when write permissions are disabled',
			{ sql: { dangerouslyWritePermEnabled: false } },
		],
		[
			'still rejects the exploit payload when write permissions are enabled',
			{ sql: { dangerouslyWritePermEnabled: true } },
		],
		['still rejects the exploit payload when no agent settings are configured', null],
	])('%s', async (_name, agentSettings) => {
		await expect(
			executeQuery({ sql_query: exploitSql }, createToolContext({ agentSettings: agentSettings as never })),
		).rejects.toThrow(/passthrough/);
	});
});

describe('execute_sql warehouse hooks', () => {
	afterEach(() => {
		env.NAO_SQL_PRE_EXECUTE_URL = undefined;
		env.NAO_SQL_POST_EXECUTE_URL = undefined;
		env.NAO_SQL_HOOK_TIMEOUT_MS = 5000;
	});

	it('sends the SQL and its ids to the pre-execute hook and runs the query it allows', async () => {
		env.NAO_SQL_PRE_EXECUTE_URL = PRE_EXECUTE_URL;
		const fetch = stubHookedFetch({ pre: () => Response.json({ decision: 'allow' }) });

		const output = await executeQuery({ sql_query: 'SELECT id FROM orders' }, createToolContext());

		expect(hookBodies(fetch, PRE_EXECUTE_URL)).toEqual([
			{
				sql: 'SELECT id FROM orders',
				database_id: null,
				query_id: output.id,
				project_id: 'project-1',
				user_id: 'user-1',
				chat_id: 'chat-1',
				origin: 'agent',
			},
		]);
		expect(warehouseBodies(fetch).map((body) => body.sql)).toEqual(['SELECT id FROM orders']);
	});

	it('refuses a denied query with the hook reason and never reaches the warehouse', async () => {
		env.NAO_SQL_PRE_EXECUTE_URL = PRE_EXECUTE_URL;
		const fetch = stubHookedFetch({
			pre: () => Response.json({ decision: 'deny', reason: 'orders is outside your data boundary' }),
		});

		await expect(executeQuery({ sql_query: 'SELECT id FROM orders' }, createToolContext())).rejects.toThrow(
			'The query was refused by the SQL policy: orders is outside your data boundary',
		);
		expect(warehouseBodies(fetch)).toEqual([]);
	});

	it('runs and records the replacement SQL the hook returns', async () => {
		env.NAO_SQL_PRE_EXECUTE_URL = PRE_EXECUTE_URL;
		const fetch = stubHookedFetch({
			pre: () => Response.json({ decision: 'allow', sql: "SELECT id FROM orders WHERE region = 'EU' LIMIT 10" }),
		});
		const context = createToolContext();

		const output = await executeQuery({ sql_query: 'SELECT id FROM orders' }, context);

		expect(warehouseBodies(fetch).map((body) => body.sql)).toEqual([
			"SELECT id FROM orders WHERE region = 'EU' LIMIT 10",
		]);
		expect(context.queryResults.get(output.id)?.sqlQuery).toBe(
			"SELECT id FROM orders WHERE region = 'EU' LIMIT 10",
		);
		expect(output.applied_limit).toBe(10);
	});

	it('blocks replacement SQL that is not read-only', async () => {
		env.NAO_SQL_PRE_EXECUTE_URL = PRE_EXECUTE_URL;
		const fetch = stubHookedFetch({ pre: () => Response.json({ decision: 'allow', sql: 'DELETE FROM orders' }) });

		await expect(executeQuery({ sql_query: 'SELECT id FROM orders' }, createToolContext())).rejects.toThrow(
			'The query was blocked: the SQL policy rewrote it into a query that is not read-only.',
		);
		expect(warehouseBodies(fetch)).toEqual([]);
	});

	it.each([
		{ name: 'responds with an error status', pre: () => new Response('unavailable', { status: 503 }) },
		{ name: 'answers with something other than JSON', pre: () => new Response('ok') },
		{ name: 'answers with an unknown decision', pre: () => Response.json({ decision: 'maybe' }) },
		{
			name: 'cannot be reached',
			pre: () => {
				throw new TypeError('fetch failed');
			},
		},
		{ name: 'times out', pre: waitForAbort },
	])('blocks the query when the pre-execute hook $name', async ({ pre }) => {
		env.NAO_SQL_PRE_EXECUTE_URL = PRE_EXECUTE_URL;
		env.NAO_SQL_HOOK_TIMEOUT_MS = 20;
		const fetch = stubHookedFetch({ pre });

		await expect(executeQuery({ sql_query: 'SELECT id FROM orders' }, createToolContext())).rejects.toThrow(
			'The query was blocked: the SQL policy check is unavailable.',
		);
		expect(warehouseBodies(fetch)).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			'SQL pre-execute hook failed; the query was blocked',
			expect.anything(),
		);
	});

	it('reports the outcome to the post-execute hook and hands the agent its redacted result', async () => {
		env.NAO_SQL_POST_EXECUTE_URL = POST_EXECUTE_URL;
		const fetch = stubHookedFetch({ post: () => Response.json({ columns: ['id'], data: [{ id: 1 }] }) });
		const context = createToolContext();

		const output = await executeQuery({ sql_query: 'SELECT id, email FROM customers' }, context);

		expect(hookBodies(fetch, POST_EXECUTE_URL)).toEqual([
			expect.objectContaining({
				sql: 'SELECT id, email FROM customers',
				query_id: output.id,
				row_count: 1,
				columns: ['id', 'email'],
				duration_ms: expect.any(Number),
				error: null,
			}),
		]);
		expect(output).toMatchObject({ columns: ['id'], data: [{ id: 1 }], row_count: 1 });
		expect(context.queryResults.get(output.id)?.data).toEqual([{ id: 1 }]);
	});

	it.each([
		{ name: 'answers with no body', post: () => new Response(null, { status: 204 }) },
		{ name: 'fails', post: () => new Response('unavailable', { status: 503 }) },
	])('passes the result through when the post-execute hook $name', async ({ post }) => {
		env.NAO_SQL_POST_EXECUTE_URL = POST_EXECUTE_URL;
		stubHookedFetch({ post });

		const output = await executeQuery({ sql_query: 'SELECT id, email FROM customers' }, createToolContext());

		expect(output).toMatchObject({ columns: ['id', 'email'], data: [WAREHOUSE_ROW], row_count: 1 });
	});

	it('reports a failed query to the post-execute hook and still fails the tool call', async () => {
		env.NAO_SQL_POST_EXECUTE_URL = POST_EXECUTE_URL;
		const fetch = stubHookedFetch({
			post: () => new Response(null, { status: 204 }),
			warehouse: () => Response.json({ detail: 'column "emial" does not exist' }, { status: 400 }),
		});

		await expect(executeQuery({ sql_query: 'SELECT emial FROM customers' }, createToolContext())).rejects.toThrow(
			/column "emial" does not exist/,
		);
		expect(hookBodies(fetch, POST_EXECUTE_URL)).toEqual([
			expect.objectContaining({
				row_count: null,
				columns: null,
				error: expect.stringContaining('column "emial" does not exist'),
			}),
		]);
	});

	it('skips both hooks for the local database', async () => {
		env.NAO_SQL_PRE_EXECUTE_URL = PRE_EXECUTE_URL;
		env.NAO_SQL_POST_EXECUTE_URL = POST_EXECUTE_URL;
		const fetch = stubHookedFetch({});
		vi.mocked(runQueryOnLocalFiles).mockResolvedValue({ result: { columns: ['n'], data: [{ n: 1 }] } } as never);

		await executeQuery({ sql_query: 'SELECT 1 AS n', database_id: LOCAL_DATABASE_ID }, createToolContext());

		expect(fetch).not.toHaveBeenCalled();
	});
});

const PRE_EXECUTE_URL = 'http://policy.test/pre-execute';
const POST_EXECUTE_URL = 'http://policy.test/post-execute';
const WAREHOUSE_ROW = { id: 1, email: 'ada@example.com' };

type HookResponder = (init: RequestInit) => Response | Promise<Response>;

function stubHookedFetch(responders: { pre?: HookResponder; post?: HookResponder; warehouse?: () => Response }) {
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		if (url === PRE_EXECUTE_URL && responders.pre) {
			return responders.pre(init);
		}
		if (url === POST_EXECUTE_URL && responders.post) {
			return responders.post(init);
		}
		return (
			responders.warehouse?.() ?? Response.json({ data: [WAREHOUSE_ROW], row_count: 1, columns: ['id', 'email'] })
		);
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function hookBodies(fetch: ReturnType<typeof stubHookedFetch>, url: string) {
	return fetch.mock.calls.filter(([calledUrl]) => calledUrl === url).map(([, init]) => JSON.parse(String(init.body)));
}

function warehouseBodies(fetch: ReturnType<typeof stubHookedFetch>) {
	return fetch.mock.calls
		.filter(([calledUrl]) => calledUrl.endsWith('/execute_sql'))
		.map(([, init]) => JSON.parse(String(init.body)));
}

function waitForAbort(init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
	});
}

function createLicenseContext(
	storedSetting: boolean | undefined,
	warehouseTableAccess: WarehouseTableAccess = { enforced: false },
): ToolContext {
	return createToolContext({
		agentSettings: storedSetting === undefined ? {} : { sql: { enforceExcludedColumns: storedSetting } },
		warehouseTableAccess,
	});
}

function stubWarehouseFetch() {
	const fetch = vi.fn(async () => Response.json({ data: [], row_count: 0, columns: [] }));
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function sentBody(fetch: ReturnType<typeof stubWarehouseFetch>) {
	const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	return JSON.parse(String(init.body));
}
