import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/queries/user.queries', () => ({
	getUser: vi.fn(async () => ({ id: 'user-1', email: 'ada@example.com' })),
}));

import { env } from '../../src/env';
import type { RunSqlQueryTag } from '../../src/services/sql-query-tag.service';
import { executeWarehouseSql } from '../../src/services/warehouse-sql.service';

const PDP_URL = 'https://pdp.test';
const AUDIT_URL = 'https://pdp.test/nao/audit';
const OPTIONS = {
	projectFolder: '/project',
	databaseId: 'analytics',
	enforceExcludedColumns: false,
	tableAccess: { enforced: false },
	columnSecurity: { enforced: false },
	rowSecurity: { enforced: false },
	policy: { userId: 'user-1', projectId: 'project-1', chatId: 'chat-1', origin: 'agent' },
	queryId: 'query_ab12cd34',
} as const;

const QUERY_TAG: RunSqlQueryTag = {
	config: { template: 'nao {{ user_email }} {{ database_id }}', position: 'end' },
	variables: {
		user_id: 'user-1',
		user_email: 'ada@example.com',
		user_groups: '',
		project_id: 'project-1',
		chat_id: 'chat-1',
		source: 'web',
	},
	defaultDatabaseId: '',
};

afterEach(() => {
	env.NAO_SQL_POLICY_URL = undefined;
	env.NAO_SQL_POLICY_AUDIT_URL = undefined;
	vi.unstubAllGlobals();
});

describe('executeWarehouseSql', () => {
	it.each([
		{
			name: 'sends the rendered tag of the run',
			queryTag: QUERY_TAG,
			expected: { comment: 'nao ada@example.com lake', position: 'end' },
		},
		{ name: 'sends no tag for a project that tags nothing', queryTag: null, expected: undefined },
	])('$name', async ({ queryTag, expected }) => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
			Response.json({ data: [], row_count: 0, columns: [] }),
		);
		vi.stubGlobal('fetch', fetchMock);

		await executeWarehouseSql('SELECT 1', { ...OPTIONS, databaseId: 'lake', queryTag });

		const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
		expect(body.sql).toBe('SELECT 1');
		expect(body.query_tag).toEqual(expected);
	});
});

describe('executeWarehouseSql with a SQL policy', () => {
	beforeEach(() => {
		env.NAO_SQL_POLICY_URL = PDP_URL;
		env.NAO_SQL_POLICY_AUDIT_URL = AUDIT_URL;
	});

	it('never sends a refused query to the warehouse', async () => {
		const fetch = stubFetch({ decision: { decision: false, context: { reason: 'not yours' } } });

		await expect(executeWarehouseSql('SELECT id FROM orders', OPTIONS)).rejects.toThrow(
			'The query was refused by the SQL policy: not yours',
		);
		expect(bodiesTo(fetch, '/execute_sql')).toEqual([]);
	});

	it('runs, returns and records the SQL the policy rewrote', async () => {
		const fetch = stubFetch({ decision: { decision: true, context: { sql: 'SELECT id FROM orders LIMIT 10' } } });

		const result = await executeWarehouseSql('SELECT id FROM orders', OPTIONS);

		expect(bodiesTo(fetch, '/execute_sql').map((body) => body.sql)).toEqual(['SELECT id FROM orders LIMIT 10']);
		expect(result.executedSql).toBe('SELECT id FROM orders LIMIT 10');
		expect(bodiesTo(fetch, AUDIT_URL)).toEqual([
			expect.objectContaining({
				sql: 'SELECT id FROM orders LIMIT 10',
				row_count: 1,
				columns: ['id'],
				error: null,
			}),
		]);
	});

	it('records a failed query and still fails', async () => {
		const fetch = stubFetch({
			decision: { decision: true },
			warehouse: Response.json({ detail: 'relation "ordres" does not exist' }, { status: 400 }),
		});

		await expect(executeWarehouseSql('SELECT id FROM ordres', OPTIONS)).rejects.toThrow(/ordres/);
		expect(bodiesTo(fetch, AUDIT_URL)).toEqual([
			expect.objectContaining({ row_count: null, columns: null, error: expect.stringContaining('ordres') }),
		]);
	});

	it('runs the query as written when no policy is configured', async () => {
		env.NAO_SQL_POLICY_URL = undefined;
		const fetch = stubFetch({ decision: { decision: false } });

		const result = await executeWarehouseSql('SELECT id FROM orders', OPTIONS);

		expect(result.executedSql).toBe('SELECT id FROM orders');
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([expect.stringMatching(/\/execute_sql$/)]);
	});
});

function stubFetch({ decision, warehouse }: { decision: unknown; warehouse?: Response }) {
	const fetch = vi.fn(async (url: string, _init: RequestInit) => {
		if (url.endsWith('/access/v1/evaluation')) {
			return Response.json(decision);
		}
		if (url === AUDIT_URL) {
			return new Response(null, { status: 204 });
		}
		return warehouse ?? Response.json({ data: [{ id: 1 }], row_count: 1, columns: ['id'] });
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function bodiesTo(fetch: ReturnType<typeof stubFetch>, urlEnd: string) {
	return fetch.mock.calls.filter(([url]) => url.endsWith(urlEnd)).map(([, init]) => JSON.parse(String(init.body)));
}
