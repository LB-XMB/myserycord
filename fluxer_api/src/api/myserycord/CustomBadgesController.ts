// SPDX-License-Identifier: AGPL-3.0-or-later

// Myserycord: custom profile badges. Admins create badges (name, description, image)
// and give them to users; every client reads the public list and draws them next to
// the official badges. Everything lives in the instance configuration table, so the
// feature needs no schema migration and stays out of upstream files.

import {randomBytes} from 'node:crypto';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const STATE_KEY = 'myserycord_custom_badges';
const iconKey = (badgeId: string) => `myserycord_custom_badge_icon:${badgeId}`;
const ICON_MAX_BYTES = 128 * 1024;
const ICON_TYPES = ['image/png', 'image/webp', 'image/gif', 'image/svg+xml'] as const;

interface StoredBadge {
	name: string;
	description: string;
	icon_type: (typeof ICON_TYPES)[number];
	icon_rev: number;
}

interface State {
	badges: Record<string, StoredBadge>;
	users: Record<string, Array<string>>;
}

const BadgeIdType = z.string().regex(/^[a-f0-9]{12}$/);

const CustomBadgeResponse = z.object({
	id: BadgeIdType,
	name: z.string(),
	description: z.string(),
	icon_rev: z.number().int(),
});

const CustomBadgesResponse = z.object({
	badges: z.array(CustomBadgeResponse).describe('Every custom badge of the instance'),
	users: z.record(z.string(), z.array(BadgeIdType)).describe('Badge IDs worn by each user ID'),
});

const IconInput = z.object({
	icon: z
		.string()
		.max(Math.ceil((ICON_MAX_BYTES * 4) / 3) + 4)
		.describe('Base64 image, 128 KiB at most'),
	icon_type: z.enum(ICON_TYPES),
});

const CreateBadgeRequest = IconInput.extend({
	name: z.string().trim().min(1).max(64),
	description: z.string().trim().max(200).default(''),
});

const UpdateBadgeRequest = z.object({
	name: z.string().trim().min(1).max(64).optional(),
	description: z.string().trim().max(200).optional(),
	icon: IconInput.shape.icon.optional(),
	icon_type: IconInput.shape.icon_type.optional(),
});

const BadgeParam = z.object({badge_id: BadgeIdType});
const BadgeUserParam = z.object({badge_id: BadgeIdType, user_id: SnowflakeType});

async function readState(): Promise<State> {
	const raw = await getInstanceConfigRepository().getConfig(STATE_KEY);
	if (!raw) return {badges: {}, users: {}};
	const state = JSON.parse(raw) as State;
	return {badges: state.badges ?? {}, users: state.users ?? {}};
}

// ponytail: read-modify-write without a lock; a few admins editing badges at once is
// the only race, and the loser's change is just lost.
async function writeState(state: State): Promise<void> {
	await getInstanceConfigRepository().setConfig(STATE_KEY, JSON.stringify(state));
}

function toResponse(state: State): z.infer<typeof CustomBadgesResponse> {
	return {
		badges: Object.entries(state.badges).map(([id, b]) => ({
			id,
			name: b.name,
			description: b.description,
			icon_rev: b.icon_rev,
		})),
		users: state.users,
	};
}

/** Returns the image bytes, or an error message when they are not the declared image type. */
function decodeIcon(icon: string, type: StoredBadge['icon_type']): Buffer | string {
	const bytes = Buffer.from(icon, 'base64');
	if (bytes.length === 0 || bytes.length > ICON_MAX_BYTES) {
		return 'The image must be between 1 byte and 128 KiB';
	}
	const head = bytes.subarray(0, 2048).toString('latin1');
	const ok =
		type === 'image/png'
			? head.startsWith('\x89PNG')
			: type === 'image/gif'
				? head.startsWith('GIF8')
				: type === 'image/webp'
					? head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP'
					: head.includes('<svg');
	return ok ? bytes : 'The image content does not match its type';
}

const invalid = (message: string) => ({code: 'INVALID_FORM_BODY', message});
const UNKNOWN_BADGE = {code: 'UNKNOWN_BADGE', message: 'Unknown badge'};

const ADMIN_OPENAPI = {security: 'adminApiKey', tags: 'Admin'} as const;

export function CustomBadgesController(app: HonoApp) {
	app.get(
		'/myserycord/badges',
		RateLimitMiddleware(RateLimitConfigs.INSTANCE_INFO),
		OpenAPI({
			operationId: 'list_custom_badges',
			summary: 'List custom badges',
			responseSchema: CustomBadgesResponse,
			statusCode: 200,
			security: [],
			tags: 'Instance',
			description: 'Myserycord: custom badges of the instance and the users who wear them.',
		}),
		async (ctx) => {
			ctx.header('Cache-Control', 'public, max-age=60');
			return ctx.json(toResponse(await readState()));
		},
	);

	app.get(
		'/myserycord/badges/:badge_id/icon',
		RateLimitMiddleware(RateLimitConfigs.INSTANCE_INFO),
		Validator('param', BadgeParam),
		OpenAPI({
			operationId: 'get_custom_badge_icon',
			summary: 'Get custom badge image',
			responseSchema: z.file().describe('The badge image'),
			responseContentType: 'image/*',
			statusCode: 200,
			security: [],
			tags: 'Instance',
			description: 'Myserycord: image of a custom badge. Cache it by icon_rev.',
		}),
		async (ctx) => {
			const {badge_id} = ctx.req.valid('param');
			const badge = (await readState()).badges[badge_id];
			const icon = badge ? await getInstanceConfigRepository().getConfig(iconKey(badge_id)) : null;
			if (!badge || !icon) return ctx.json(UNKNOWN_BADGE, 404);
			const payload: ArrayBuffer = Uint8Array.from(Buffer.from(icon, 'base64')).buffer;
			return ctx.newResponse(payload, 200, {
				'Content-Type': badge.icon_type,
				'Cache-Control': 'public, max-age=86400',
				// An uploaded SVG opened on its own must not run scripts.
				'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
				'X-Content-Type-Options': 'nosniff',
			});
		},
	);

	app.get(
		'/admin/myserycord/badges',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_LOOKUP),
		requireAdminACL(AdminACLs.USER_LOOKUP),
		OpenAPI({
			...ADMIN_OPENAPI,
			operationId: 'list_admin_custom_badges',
			summary: 'List custom badges',
			responseSchema: CustomBadgesResponse,
			statusCode: 200,
			description: 'Myserycord: custom badges and their holders. Requires USER_LOOKUP permission.',
		}),
		async (ctx) => ctx.json(toResponse(await readState())),
	);

	app.post(
		'/admin/myserycord/badges',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_MODIFY),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('json', CreateBadgeRequest),
		OpenAPI({
			...ADMIN_OPENAPI,
			operationId: 'create_admin_custom_badge',
			summary: 'Create custom badge',
			responseSchema: CustomBadgesResponse,
			statusCode: 200,
			description: 'Myserycord: creates a custom badge. Requires USER_UPDATE_FLAGS permission.',
		}),
		async (ctx) => {
			const body = ctx.req.valid('json');
			const icon = decodeIcon(body.icon, body.icon_type);
			if (typeof icon === 'string') return ctx.json(invalid(icon), 400);
			const id = randomBytes(6).toString('hex');
			const state = await readState();
			await getInstanceConfigRepository().setConfig(iconKey(id), icon.toString('base64'));
			state.badges[id] = {name: body.name, description: body.description, icon_type: body.icon_type, icon_rev: 1};
			await writeState(state);
			return ctx.json(toResponse(state));
		},
	);

	app.patch(
		'/admin/myserycord/badges/:badge_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_MODIFY),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('param', BadgeParam),
		Validator('json', UpdateBadgeRequest),
		OpenAPI({
			...ADMIN_OPENAPI,
			operationId: 'update_admin_custom_badge',
			summary: 'Update custom badge',
			responseSchema: CustomBadgesResponse,
			statusCode: 200,
			description: 'Myserycord: renames a custom badge or replaces its image. Requires USER_UPDATE_FLAGS permission.',
		}),
		async (ctx) => {
			const {badge_id} = ctx.req.valid('param');
			const body = ctx.req.valid('json');
			const state = await readState();
			const badge = state.badges[badge_id];
			if (!badge) return ctx.json(UNKNOWN_BADGE, 404);
			if (body.icon) {
				const type = body.icon_type ?? badge.icon_type;
				const icon = decodeIcon(body.icon, type);
				if (typeof icon === 'string') return ctx.json(invalid(icon), 400);
				await getInstanceConfigRepository().setConfig(iconKey(badge_id), icon.toString('base64'));
				badge.icon_type = type;
				badge.icon_rev += 1;
			}
			if (body.name !== undefined) badge.name = body.name;
			if (body.description !== undefined) badge.description = body.description;
			await writeState(state);
			return ctx.json(toResponse(state));
		},
	);

	app.delete(
		'/admin/myserycord/badges/:badge_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_MODIFY),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('param', BadgeParam),
		OpenAPI({
			...ADMIN_OPENAPI,
			operationId: 'delete_admin_custom_badge',
			summary: 'Delete custom badge',
			responseSchema: CustomBadgesResponse,
			statusCode: 200,
			description:
				'Myserycord: deletes a custom badge and takes it from everyone. Requires USER_UPDATE_FLAGS permission.',
		}),
		async (ctx) => {
			const {badge_id} = ctx.req.valid('param');
			const state = await readState();
			delete state.badges[badge_id];
			for (const [userId, ids] of Object.entries(state.users)) {
				const rest = ids.filter((id) => id !== badge_id);
				if (rest.length) state.users[userId] = rest;
				else delete state.users[userId];
			}
			await writeState(state);
			// The image row stays behind empty rather than adding a delete path to the repository.
			await getInstanceConfigRepository().setConfig(iconKey(badge_id), '');
			return ctx.json(toResponse(state));
		},
	);

	app.put(
		'/admin/myserycord/badges/:badge_id/users/:user_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_MODIFY),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('param', BadgeUserParam),
		OpenAPI({
			...ADMIN_OPENAPI,
			operationId: 'add_admin_custom_badge_user',
			summary: 'Give custom badge',
			responseSchema: CustomBadgesResponse,
			statusCode: 200,
			description: 'Myserycord: gives a custom badge to a user. Requires USER_UPDATE_FLAGS permission.',
		}),
		async (ctx) => {
			const {badge_id, user_id} = ctx.req.valid('param');
			const state = await readState();
			if (!state.badges[badge_id]) return ctx.json(UNKNOWN_BADGE, 404);
			const userId = user_id.toString();
			const ids = state.users[userId] ?? [];
			if (!ids.includes(badge_id)) state.users[userId] = [...ids, badge_id];
			await writeState(state);
			return ctx.json(toResponse(state));
		},
	);

	app.delete(
		'/admin/myserycord/badges/:badge_id/users/:user_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_MODIFY),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('param', BadgeUserParam),
		OpenAPI({
			...ADMIN_OPENAPI,
			operationId: 'remove_admin_custom_badge_user',
			summary: 'Take custom badge',
			responseSchema: CustomBadgesResponse,
			statusCode: 200,
			description: 'Myserycord: takes a custom badge from a user. Requires USER_UPDATE_FLAGS permission.',
		}),
		async (ctx) => {
			const {badge_id, user_id} = ctx.req.valid('param');
			const state = await readState();
			const userId = user_id.toString();
			const rest = (state.users[userId] ?? []).filter((id) => id !== badge_id);
			if (rest.length) state.users[userId] = rest;
			else delete state.users[userId];
			await writeState(state);
			return ctx.json(toResponse(state));
		},
	);
}
