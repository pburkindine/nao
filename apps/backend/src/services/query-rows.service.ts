import { type SortDirection, sortTableRows } from '@nao/shared/story-table-utils';

import { getQueryResultByQueryId } from '../queries/chat.queries';
import { getQueryToolOutputInChat } from '../queries/execute-sql.queries';
import type { QueryResult } from '../types/tools';
import { agentService } from './agent';

export interface QueryRowsRequest {
	chatId: string;
	toolCallId: string;
	queryId: string;
	offset: number;
	/** All rows from `offset` when omitted. */
	limit?: number;
	sort?: { column: string; direction: SortDirection };
}

export interface QueryRowsPage {
	columns: string[];
	rows: Record<string, unknown>[];
	totalRows: number;
}

export async function getQueryRowsPage(request: QueryRowsRequest): Promise<QueryRowsPage | null> {
	const result = await findQueryResult(request.chatId, request.toolCallId, request.queryId);
	return result ? pageOf(result, request) : null;
}

/** For callers that only know the query id, such as an MCP client given `queries[].id` by `ask_nao`. */
export async function getQueryRowsPageByQueryId(
	request: Omit<QueryRowsRequest, 'toolCallId'>,
): Promise<QueryRowsPage | null> {
	const result =
		(await getQueryResultByQueryId(request.chatId, request.queryId)) ??
		agentService.get(request.chatId)?.getQueryResult(request.queryId) ??
		null;
	return result ? pageOf(result, request) : null;
}

function pageOf(
	result: QueryResult,
	request: Omit<QueryRowsRequest, 'chatId' | 'toolCallId' | 'queryId'>,
): QueryRowsPage {
	const rows = request.sort ? sortTableRows(result.data, request.sort.column, request.sort.direction) : result.data;
	const end = request.limit === undefined ? undefined : request.offset + request.limit;
	return { columns: result.columns, rows: rows.slice(request.offset, end), totalRows: rows.length };
}

/** A query from the turn still running is only in the agent's memory: its part is saved when the turn ends. */
async function findQueryResult(chatId: string, toolCallId: string, queryId: string): Promise<QueryResult | null> {
	const persisted = await getQueryToolOutputInChat(chatId, toolCallId);
	if (persisted?.id === queryId && Array.isArray(persisted.columns) && Array.isArray(persisted.data)) {
		return { columns: persisted.columns, data: persisted.data };
	}
	return agentService.get(chatId)?.getQueryResult(queryId) ?? null;
}
