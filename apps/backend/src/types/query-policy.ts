/** Sent with every decision request and audit record, so a policy can stay compatible across nao releases. */
export const QUERY_POLICY_VERSION = 1;

export interface PolicyQuery {
	sql: string;
	databaseId?: string;
	queryId?: string;
}

export interface PolicyContext {
	userId: string;
	projectId: string;
	chatId: string | null;
	origin: 'agent' | 'story';
}

export type PolicyDecision =
	| { decision: 'allow' }
	| { decision: 'deny'; reason?: string }
	| { decision: 'rewrite'; sql: string; reason?: string };

export interface PolicyOutcome {
	rowCount: number | null;
	columns: string[] | null;
	durationMs: number;
	error: string | null;
}

export interface QueryPolicy {
	name: string;
	authorize(query: PolicyQuery, context: PolicyContext): Promise<PolicyDecision>;
	record?(query: PolicyQuery, context: PolicyContext, outcome: PolicyOutcome): Promise<void>;
}
