// SPDX-License-Identifier: AGPL-3.0-or-later

import {normalizeHTTPNetworkOrigin} from '@fluxer/instance_bootstrap/src/NetworkOrigin';

export const OFFICIAL_INSTANCE_NAME = 'Myserycord';

// Myserycord: l'instance "officielle" du fork est fluxer.lbxmb.fr.
export const OFFICIAL_INSTANCE_DISPLAY_HOST = 'fluxer.lbxmb.fr';

export const OFFICIAL_STABLE_MARKETING_ORIGIN = `https://${OFFICIAL_INSTANCE_DISPLAY_HOST}`;

export const OFFICIAL_CLIENT_API_ENDPOINTS = Object.freeze({
	stable: 'https://fluxer.lbxmb.fr/api',
	canary: 'https://fluxer.lbxmb.fr/api',
} as const);

export type OfficialReleaseChannel = keyof typeof OFFICIAL_CLIENT_API_ENDPOINTS;

export const OFFICIAL_MARKETING_ORIGINS = Object.freeze({
	stable: OFFICIAL_STABLE_MARKETING_ORIGIN,
	canary: OFFICIAL_STABLE_MARKETING_ORIGIN,
} as const) satisfies Record<OfficialReleaseChannel, string>;

export function officialMarketingOrigin(releaseChannel: string | null | undefined): string {
	return releaseChannel === 'stable' ? OFFICIAL_MARKETING_ORIGINS.stable : OFFICIAL_MARKETING_ORIGINS.canary;
}

const OFFICIAL_MIGRATED_WEB_APP_HOSTS = Object.freeze({
	stable: 'fluxer.lbxmb.fr',
	canary: 'fluxer.lbxmb.fr',
} as const) satisfies Record<OfficialReleaseChannel, string>;

const OFFICIAL_CLIENT_API_PATH = '/api';

const OFFICIAL_RELEASE_CHANNELS: ReadonlyArray<OfficialReleaseChannel> = Object.freeze(['stable', 'canary']);

const OFFICIAL_CLIENT_API_HOST_CHANNELS: ReadonlyMap<string, OfficialReleaseChannel> = new Map(
	OFFICIAL_RELEASE_CHANNELS.flatMap(
		(channel): Array<[string, OfficialReleaseChannel]> => [
			[new URL(OFFICIAL_CLIENT_API_ENDPOINTS[channel]).host, channel],
			[OFFICIAL_MIGRATED_WEB_APP_HOSTS[channel], channel],
		],
	),
);

export function officialClientApiEndpointForAlias(apiEndpoint: string): string | null {
	let url: URL;
	try {
		url = new URL(apiEndpoint.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
		return null;
	}
	if (url.pathname.replace(/\/+$/u, '') !== OFFICIAL_CLIENT_API_PATH) {
		return null;
	}
	const channel = OFFICIAL_CLIENT_API_HOST_CHANNELS.get(url.host);
	return channel === undefined ? null : OFFICIAL_CLIENT_API_ENDPOINTS[channel];
}

export const OFFICIAL_INSTANCE_HOSTS: ReadonlyArray<string> = Object.freeze([
	OFFICIAL_INSTANCE_DISPLAY_HOST,
]);

export function isOfficialInstanceHost(value: string): boolean {
	const origin = normalizeHTTPNetworkOrigin(value);
	if (origin == null) {
		return false;
	}
	const host = origin.slice(origin.indexOf('//') + 2).toLowerCase();
	return OFFICIAL_INSTANCE_HOSTS.some((officialHost) => officialHost === host);
}
