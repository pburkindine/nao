import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger', async () => ({
	...(await import('../helpers/logger-mock')),
	serializeError: (error: unknown) => ({ message: String(error) }),
}));

import { authorizeQuery, recordQuery } from '../../src/services/query-policy.service';
import type { PolicyContext, PolicyDecision, QueryPolicy } from '../../src/types/query-policy';
import { logger } from '../../src/utils/logger';

const QUERY = { sql: 'SELECT id FROM orders', databaseId: 'analytics', queryId: 'query_ab12cd34' };
const CONTEXT: PolicyContext = { userId: 'user-1', projectId: 'project-1', chatId: 'chat-1', origin: 'agent' };
const OUTCOME = { rowCount: 3, columns: ['id'], durationMs: 12, error: null };

beforeEach(() => {
	vi.clearAllMocks();
});

describe('authorizeQuery', () => {
	it('returns the SQL unchanged when no policy is configured', async () => {
		await expect(authorizeQuery(QUERY, CONTEXT, [])).resolves.toBe('SELECT id FROM orders');
	});

	it.each([
		{ name: 'first', decisions: [deny('outside your data boundary'), allow()] },
		{ name: 'last', decisions: [allow(), deny('outside your data boundary')] },
	])('refuses the query when the $name policy denies it', async ({ decisions }) => {
		await expect(authorizeQuery(QUERY, CONTEXT, decisions.map(policyDeciding))).rejects.toThrow(
			'The query was refused by the SQL policy: outside your data boundary',
		);
	});

	it('hands each policy the SQL the one before it rewrote', async () => {
		const scope = policyDeciding({ decision: 'rewrite', sql: "SELECT id FROM orders WHERE region = 'EU'" });
		const limit = policyDeciding({
			decision: 'rewrite',
			sql: "SELECT id FROM orders WHERE region = 'EU' LIMIT 100",
		});

		const sql = await authorizeQuery(QUERY, CONTEXT, [scope, limit]);

		expect(sql).toBe("SELECT id FROM orders WHERE region = 'EU' LIMIT 100");
		expect(limit.authorize).toHaveBeenCalledWith(
			{ ...QUERY, sql: "SELECT id FROM orders WHERE region = 'EU'" },
			CONTEXT,
		);
	});

	it.each([
		{ name: 'writes', sql: 'DELETE FROM orders' },
		{ name: 'opens another server connection', sql: "SELECT * FROM postgres_query('db', 'SELECT 1')" },
	])('blocks a rewrite that $name', async ({ sql }) => {
		await expect(authorizeQuery(QUERY, CONTEXT, [policyDeciding({ decision: 'rewrite', sql })])).rejects.toThrow(
			'The query was blocked: the SQL policy rewrote it into a query that is not read-only.',
		);
	});

	it('blocks the query when a policy fails', async () => {
		const failing: QueryPolicy = { name: 'failing', authorize: vi.fn().mockRejectedValue(new Error('PDP down')) };

		await expect(authorizeQuery(QUERY, CONTEXT, [allowAll(), failing])).rejects.toThrow(
			'The query was blocked: the SQL policy check is unavailable.',
		);
		expect(logger.warn).toHaveBeenCalledWith(
			'SQL policy failed; the query was blocked',
			expect.objectContaining({ context: expect.objectContaining({ policy: 'failing' }) }),
		);
	});
});

describe('recordQuery', () => {
	it('gives every policy that records the query, its context and its outcome', async () => {
		const audit = { ...allowAll(), record: vi.fn().mockResolvedValue(undefined) };

		await recordQuery(QUERY, CONTEXT, OUTCOME, [allowAll(), audit]);

		expect(audit.record).toHaveBeenCalledWith(QUERY, CONTEXT, OUTCOME);
	});

	it('logs a policy that fails to record and still records with the next one', async () => {
		const failing = { ...allowAll(), name: 'failing', record: vi.fn().mockRejectedValue(new Error('audit down')) };
		const audit = { ...allowAll(), record: vi.fn().mockResolvedValue(undefined) };

		await expect(recordQuery(QUERY, CONTEXT, OUTCOME, [failing, audit])).resolves.toBeUndefined();

		expect(audit.record).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledWith('SQL policy could not record the query', expect.anything());
	});
});

function policyDeciding(decision: PolicyDecision) {
	return { name: decision.decision, authorize: vi.fn().mockResolvedValue(decision) } satisfies QueryPolicy;
}

function allowAll(): QueryPolicy {
	return policyDeciding(allow());
}

function allow(): PolicyDecision {
	return { decision: 'allow' };
}

function deny(reason: string): PolicyDecision {
	return { decision: 'deny', reason };
}
