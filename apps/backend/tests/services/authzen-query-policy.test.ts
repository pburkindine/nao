import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/queries/user.queries', () => ({
	getUser: vi.fn(async () => ({ id: 'user-1', email: 'ada@example.com' })),
}));

import { createAuthZenQueryPolicy } from '../../src/services/authzen-query-policy';
import type { PolicyContext } from '../../src/types/query-policy';

const QUERY = { sql: 'SELECT id FROM orders', databaseId: 'analytics', queryId: 'query_ab12cd34' };
const CONTEXT: PolicyContext = { userId: 'user-1', projectId: 'project-1', chatId: 'chat-1', origin: 'story' };
const OPTIONS = { pdpUrl: 'https://pdp.test/authzen', token: 'pdp-token', timeoutMs: 20 };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('AuthZEN query policy', () => {
	it('asks the evaluation endpoint about the user, the database and the SQL', async () => {
		const fetch = stubFetch(() => Response.json({ decision: true }));

		await expect(createAuthZenQueryPolicy(OPTIONS).authorize(QUERY, CONTEXT)).resolves.toEqual({
			decision: 'allow',
		});

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('https://pdp.test/authzen/access/v1/evaluation');
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer pdp-token');
		expect(JSON.parse(String(init.body))).toEqual({
			subject: { type: 'user', id: 'user-1', properties: { email: 'ada@example.com' } },
			action: { name: 'execute_sql' },
			resource: { type: 'database', id: 'analytics', properties: { sql: 'SELECT id FROM orders' } },
			context: {
				nao_policy_version: 1,
				origin: 'story',
				project_id: 'project-1',
				chat_id: 'chat-1',
				query_id: 'query_ab12cd34',
			},
		});
	});

	it.each([
		{
			name: 'a deny with its reason',
			body: { decision: false, context: { reason: 'orders is outside your data boundary' } },
			expected: { decision: 'deny', reason: 'orders is outside your data boundary' },
		},
		{
			name: 'a rewrite',
			body: { decision: true, context: { sql: 'SELECT id FROM orders LIMIT 10', reason: 'row cap' } },
			expected: { decision: 'rewrite', sql: 'SELECT id FROM orders LIMIT 10', reason: 'row cap' },
		},
	])('reads $name from the evaluation context', async ({ body, expected }) => {
		stubFetch(() => Response.json(body));

		await expect(createAuthZenQueryPolicy(OPTIONS).authorize(QUERY, CONTEXT)).resolves.toEqual(expected);
	});

	it.each([
		{ name: 'responds with an error status', respond: () => new Response('unavailable', { status: 503 }) },
		{ name: 'answers with something other than JSON', respond: () => new Response('ok') },
		{ name: 'answers without a boolean decision', respond: () => Response.json({ decision: 'allow' }) },
		{ name: 'times out', respond: waitForAbort },
	])('throws when the policy decision point $name', async ({ respond }) => {
		stubFetch(respond);

		await expect(createAuthZenQueryPolicy(OPTIONS).authorize(QUERY, CONTEXT)).rejects.toThrow();
	});

	it('posts one audit record per query to the audit endpoint', async () => {
		const fetch = stubFetch(() => new Response(null, { status: 204 }));
		const policy = createAuthZenQueryPolicy({ ...OPTIONS, auditUrl: 'https://pdp.test/nao/audit' });

		await policy.record?.(QUERY, CONTEXT, { rowCount: 3, columns: ['id'], durationMs: 12, error: null });

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('https://pdp.test/nao/audit');
		expect(JSON.parse(String(init.body))).toEqual({
			nao_policy_version: 1,
			sql: 'SELECT id FROM orders',
			database_id: 'analytics',
			query_id: 'query_ab12cd34',
			user_id: 'user-1',
			project_id: 'project-1',
			chat_id: 'chat-1',
			origin: 'story',
			row_count: 3,
			columns: ['id'],
			duration_ms: 12,
			error: null,
		});
	});

	it('records nothing without an audit endpoint', () => {
		expect(createAuthZenQueryPolicy(OPTIONS).record).toBeUndefined();
	});
});

function stubFetch(respond: (init: RequestInit) => Response | Promise<Response>) {
	const fetch = vi.fn(async (_url: string, init: RequestInit) => respond(init));
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function waitForAbort(init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
	});
}
