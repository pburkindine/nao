import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpContext } from '../helpers/fake-mcp-server';

const CHAT_ID = '6f1c2a4e-8b3d-4c5a-9e7f-1a2b3c4d5e6f';
const ROWS = Array.from({ length: 2500 }, (_, n) => ({ n }));

const mocks = vi.hoisted(() => ({
	getChatOwnerId: vi.fn(),
	getChatProjectId: vi.fn(),
	getQueryResultByQueryId: vi.fn(),
}));

vi.mock('../../src/db/db', () => ({ db: {} }));
vi.mock('../../src/queries/mcp-endpoint.queries', () => ({
	insertMcpCallLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/queries/chat.queries', () => mocks);
vi.mock('../../src/utils/logger', () => import('../helpers/logger-mock'));
vi.mock('../../src/services/agent', () => ({ agentService: { get: vi.fn() } }));
vi.mock('../../src/utils/llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/utils/llm')>()),
	getProjectAvailableModels: vi.fn().mockResolvedValue([]),
	resolveDefaultChatModel: vi.fn().mockResolvedValue(null),
}));

import { registerSubAgentTools } from '../../src/mcp/tools/sub-agent';

const connections: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
	await Promise.all(connections.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])));
	vi.clearAllMocks();
});

describe('MCP get_query_rows', () => {
	it('pages through every row of a query the chat ran', async () => {
		givenChat({ ownerId: 'user-1', projectId: 'project-1' });
		mocks.getQueryResultByQueryId.mockResolvedValue({ columns: ['n'], data: ROWS });
		const client = await connect();

		const pages = [];
		let offset: number | null = 0;
		while (offset !== null) {
			const page = await getQueryRows(client, { offset });
			pages.push(page);
			offset = page.next_offset;
		}

		expect(pages.map((page) => page.rows.length)).toEqual([1000, 1000, 500]);
		expect(pages.flatMap((page) => page.rows)).toEqual(ROWS);
		expect(pages[0]).toMatchObject({ columns: ['n'], total_rows: 2500, next_offset: 1000 });
		expect(mocks.getQueryResultByQueryId).toHaveBeenCalledWith(CHAT_ID, 'query_abc');
	});

	it('honours a smaller page size', async () => {
		givenChat({ ownerId: 'user-1', projectId: 'project-1' });
		mocks.getQueryResultByQueryId.mockResolvedValue({ columns: ['n'], data: ROWS });
		const client = await connect();

		const page = await getQueryRows(client, { offset: 2490, limit: 20 });

		expect(page).toEqual({ columns: ['n'], rows: ROWS.slice(2490), total_rows: 2500, next_offset: null });
	});

	it.each([
		['another user', { ownerId: 'user-2', projectId: 'project-1' }],
		['another project', { ownerId: 'user-1', projectId: 'project-2' }],
	])('refuses a chat of %s without reading the query', async (_label, chat) => {
		givenChat(chat);
		const client = await connect();

		const result = await client.callTool({
			name: 'get_query_rows',
			arguments: { chatId: CHAT_ID, query_id: 'query_abc' },
		});

		expect(result.isError).toBe(true);
		expect(mocks.getQueryResultByQueryId).not.toHaveBeenCalled();
	});

	it('reports a query the chat did not run as an error', async () => {
		givenChat({ ownerId: 'user-1', projectId: 'project-1' });
		mocks.getQueryResultByQueryId.mockResolvedValue(null);
		const client = await connect();

		const result = await client.callTool({
			name: 'get_query_rows',
			arguments: { chatId: CHAT_ID, query_id: 'query_missing' },
		});

		expect(result.isError).toBe(true);
	});
});

function givenChat({ ownerId, projectId }: { ownerId: string; projectId: string }) {
	mocks.getChatOwnerId.mockResolvedValue(ownerId);
	mocks.getChatProjectId.mockResolvedValue(projectId);
}

async function getQueryRows(
	client: Client,
	args: { offset: number; limit?: number },
): Promise<{ columns: string[]; rows: unknown[]; total_rows: number; next_offset: number | null }> {
	const result = await client.callTool({
		name: 'get_query_rows',
		arguments: { chatId: CHAT_ID, query_id: 'query_abc', ...args },
	});
	expect(result.isError).toBeFalsy();
	return result.structuredContent as Awaited<ReturnType<typeof getQueryRows>>;
}

async function connect(): Promise<Client> {
	const server = new McpServer({ name: 'test', version: '0.0.0' });
	await registerSubAgentTools(server, createMcpContext());
	const client = new Client({ name: 'test-client', version: '0.0.0' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	connections.push({ client, server });
	return client;
}
