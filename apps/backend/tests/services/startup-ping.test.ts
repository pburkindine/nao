import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { MODE: 'prod', NAO_DISABLE_STARTUP_PING: false } as Record<string, unknown>,
	getLicense: vi.fn(),
}));

vi.mock('../../src/db/db', () => ({ db: {} }));
vi.mock('../../src/env', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/env')>();
	return {
		...actual,
		get env() {
			return { ...actual.env, ...mocks.env };
		},
	};
});
vi.mock('../../src/services/license.service', () => ({ getLicense: mocks.getLicense }));

import { pingLicensesServer } from '../../src/services/ping';

describe('pingLicensesServer', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('sends nothing when NAO_DISABLE_STARTUP_PING is set', async () => {
		mocks.env.NAO_DISABLE_STARTUP_PING = true;
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await pingLicensesServer();

		expect(mocks.getLicense).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('still checks the licence when the switch is off', async () => {
		mocks.env.NAO_DISABLE_STARTUP_PING = false;
		mocks.getLicense.mockResolvedValue({ isOffline: true });
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await pingLicensesServer();

		expect(mocks.getLicense).toHaveBeenCalledOnce();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
