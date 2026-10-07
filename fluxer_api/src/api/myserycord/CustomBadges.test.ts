// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {beforeEach, describe, expect, test} from 'vitest';

interface BadgesResponse {
	badges: Array<{id: string; name: string; description: string; icon_rev: number}>;
	users: Record<string, Array<string>>;
}

// 1x1 transparent PNG.
const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('Myserycord custom badges', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});

	test('admin creates, gives, edits, takes back and deletes a badge', async () => {
		const admin = await createTestAccount(harness);
		await setUserACLs(harness, admin, ['admin:authenticate', 'user:lookup', 'user:update:flags']);
		const member = await createTestAccount(harness);

		const created = await createBuilder<BadgesResponse>(harness, admin.token)
			.post('/admin/myserycord/badges')
			.body({name: 'VIP', description: 'Early supporter', icon: PNG, icon_type: 'image/png'})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(created.badges).toHaveLength(1);
		const badge = created.badges[0];
		expect(badge).toMatchObject({name: 'VIP', description: 'Early supporter', icon_rev: 1});

		await createBuilder(harness, admin.token)
			.put(`/admin/myserycord/badges/${badge.id}/users/${member.userId}`)
			.body(null)
			.expect(HTTP_STATUS.OK)
			.execute();

		const pub = await createBuilderWithoutAuth<BadgesResponse>(harness)
			.get('/myserycord/badges')
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(pub.users[member.userId]).toEqual([badge.id]);

		const icon = await createBuilderWithoutAuth(harness).get(`/myserycord/badges/${badge.id}/icon`).executeRaw();
		expect(icon.response.status).toBe(200);
		expect(icon.response.headers.get('content-type')).toBe('image/png');

		const updated = await createBuilder<BadgesResponse>(harness, admin.token)
			.patch(`/admin/myserycord/badges/${badge.id}`)
			.body({name: 'Gold', icon: PNG, icon_type: 'image/png'})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(updated.badges[0]).toMatchObject({name: 'Gold', description: 'Early supporter', icon_rev: 2});

		const takenBack = await createBuilder<BadgesResponse>(harness, admin.token)
			.delete(`/admin/myserycord/badges/${badge.id}/users/${member.userId}`)
			.body(null)
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(takenBack.users).toEqual({});

		await createBuilder(harness, admin.token)
			.put(`/admin/myserycord/badges/${badge.id}/users/${member.userId}`)
			.body(null)
			.expect(HTTP_STATUS.OK)
			.execute();
		const deleted = await createBuilder<BadgesResponse>(harness, admin.token)
			.delete(`/admin/myserycord/badges/${badge.id}`)
			.body(null)
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(deleted).toEqual({badges: [], users: {}});
		const gone = await createBuilderWithoutAuth(harness).get(`/myserycord/badges/${badge.id}/icon`).executeRaw();
		expect(gone.response.status).toBe(404);
	});

	test('rejects an image whose bytes do not match its type', async () => {
		const admin = await createTestAccount(harness);
		await setUserACLs(harness, admin, ['admin:authenticate', 'user:update:flags']);
		const res = await createBuilder(harness, admin.token)
			.post('/admin/myserycord/badges')
			.body({name: 'Fake', icon: Buffer.from('<script>alert(1)</script>').toString('base64'), icon_type: 'image/png'})
			.executeRaw();
		expect(res.response.status).toBe(400);
	});

	test('users without the flags ACL cannot manage badges', async () => {
		const user = await createTestAccount(harness);
		const res = await createBuilder(harness, user.token)
			.post('/admin/myserycord/badges')
			.body({name: 'VIP', icon: PNG, icon_type: 'image/png'})
			.executeRaw();
		expect(res.response.status).toBe(403);
	});
});
