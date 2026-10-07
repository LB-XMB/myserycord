// SPDX-License-Identifier: AGPL-3.0-or-later

// Myserycord: custom badges created in the admin panel (/admin/myserycord/), served
// by the myserycord service next to the official images at /myserycord/badges.json.

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {makeAutoObservable, runInAction} from 'mobx';

export interface CustomBadge {
	id: string;
	name: string;
	description: string;
	iconUrl: string;
}

interface CustomBadgesPayload {
	badges: Record<string, {name: string; description?: string; icon_url: string}>;
	users: Record<string, Array<string>>;
}

const REFRESH_MS = 5 * 60 * 1000;
const logger = new Logger('CustomBadges');

class CustomBadges {
	private data: CustomBadgesPayload | null = null;
	private lastFetch = 0;

	constructor() {
		makeAutoObservable<CustomBadges, 'lastFetch'>(this, {lastFetch: false});
	}

	forUser(userId: string): Array<CustomBadge> {
		this.refreshIfStale();
		const data = this.data;
		if (!data) return [];
		return (data.users[userId] ?? []).flatMap((id) => {
			const badge = data.badges[id];
			return badge ? [{id, name: badge.name, description: badge.description ?? '', iconUrl: badge.icon_url}] : [];
		});
	}

	private refreshIfStale(): void {
		const now = Date.now();
		if (now - this.lastFetch < REFRESH_MS) return;
		this.lastFetch = now;
		fetch(`${RuntimeConfig.webAppEndpoint}/myserycord/badges.json`, {cache: 'no-cache'})
			.then((r) => (r.ok ? (r.json() as Promise<CustomBadgesPayload>) : null))
			.then((data) => {
				if (data) runInAction(() => (this.data = data));
			})
			.catch((error: unknown) => logger.warn('fetch failed', error));
	}
}

export default new CustomBadges();
