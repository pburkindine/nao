import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/queries/user.queries', () => ({
	getUser: vi.fn(async () => ({ id: 'user-1', email: 'ada@example.com' })),
}));

import { env } from '../../src/env';
import { executeWarehouseSql } from '../../src/services/warehouse-sql.service';

const PDP_URL = 'https://pdp.test';
const AUDIT_URL = 'https://pdp.test/nao/audit';
const OPTIONS = {
	projectFolder: '/tmp/project',
	databaseId: 'analytics',
	enforceExcludedColumns: false,
	tableAccess: { enforced: false },
	rowSecurity: { enforced: false },
	policy: { userId: 'user-1', projectId: 'project-1', chatId: 'chat-1', origin: 'agent' },
	queryId: 'query_ab12cd34',
} as const;

beforeEach(() => {
	env.NAO_SQL_POLICY_URL = PDP_URL;
	env.NAO_SQL_POLICY_AUDIT_URL = AUDIT_URL;
});

afterEach(() => {
	env.NAO_SQL_POLICY_URL = undefined;
	env.NAO_SQL_POLICY_AUDIT_URL = undefined;
	vi.unstubAllGlobals();
});

describe('executeWarehouseSql with a SQL policy', () => {
	it('never sends a refused query to the warehouse', async () => {
		const fetch = stubFetch({ decision: { decision: false, context: { reason: 'not yours' } } });

		await expect(executeWarehouseSql('SELECT id FROM orders', { ...OPTIONS })).rejects.toThrow(
			'The query was refused by the SQL policy: not yours',
		);
		expect(bodiesTo(fetch, '/execute_sql')).toEqual([]);
	});

	it('runs, returns and records the SQL the policy rewrote', async () => {
		const fetch = stubFetch({ decision: { decision: true, context: { sql: 'SELECT id FROM orders LIMIT 10' } } });

		const result = await executeWarehouseSql('SELECT id FROM orders', { ...OPTIONS });

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

		await expect(executeWarehouseSql('SELECT id FROM ordres', { ...OPTIONS })).rejects.toThrow(/ordres/);
		expect(bodiesTo(fetch, AUDIT_URL)).toEqual([
			expect.objectContaining({ row_count: null, columns: null, error: expect.stringContaining('ordres') }),
		]);
	});

	it('runs the query as written when no policy is configured', async () => {
		env.NAO_SQL_POLICY_URL = undefined;
		const fetch = stubFetch({ decision: { decision: false } });

		const result = await executeWarehouseSql('SELECT id FROM orders', { ...OPTIONS });

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
