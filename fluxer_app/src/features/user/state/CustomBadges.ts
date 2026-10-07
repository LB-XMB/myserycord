// SPDX-License-Identifier: AGPL-3.0-or-later

// Myserycord: custom badges created in the admin panel (Badges page), served by the
// API at /myserycord/badges and drawn next to the official badges.

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {makeAutoObservable, runInAction} from 'mobx';

export interface CustomBadge {
	id: string;
	name: string;
	description: string;
	iconUrl: string;
}

interface CustomBadgesResponse {
	badges: Array<{id: string; name: string; description: string; icon_rev: number}>;
	users: Record<string, Array<string>>;
}

const REFRESH_MS = 5 * 60 * 1000;
const logger = new Logger('CustomBadges');

class CustomBadges {
	private data: CustomBadgesResponse | null = null;
	private lastFetch = 0;

	constructor() {
		makeAutoObservable<CustomBadges, 'lastFetch'>(this, {lastFetch: false});
	}

	forUser(userId: string): Array<CustomBadge> {
		this.refreshIfStale();
		const data = this.data;
		if (!data) return [];
		const ids = data.users[userId];
		if (!ids) return [];
		const base = `${RuntimeConfig.apiEndpoint}/v${RuntimeConfig.apiCodeVersion}/myserycord/badges`;
		return data.badges
			.filter((badge) => ids.includes(badge.id))
			.map((badge) => ({
				id: badge.id,
				name: badge.name,
				description: badge.description,
				iconUrl: `${base}/${badge.id}/icon?rev=${badge.icon_rev}`,
			}));
	}

	private refreshIfStale(): void {
		const now = Date.now();
		if (now - this.lastFetch < REFRESH_MS) return;
		this.lastFetch = now;
		http
			.get<CustomBadgesResponse>('/myserycord/badges')
			.then((response) => runInAction(() => (this.data = response.body)))
			.catch((error: unknown) => logger.warn('Failed to fetch custom badges', error));
	}
}

export default new CustomBadges();
