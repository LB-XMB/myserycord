// Myserycord: draws custom badges in the official Fluxer web client, which knows
// nothing about them. Every place the client renders <UserProfileBadges> passes it a
// "data-flx" prop ending in "user-profile-badges" plus the user; we find those
// components in the React fiber tree and add our <img> next to the official badges.
(() => {
	'use strict';
	const DATA_URL = '/myserycord/badges.json';
	const MARK = 'data-msc-badges';
	let data = null;

	const load = () =>
		fetch(DATA_URL, {cache: 'no-cache'})
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d) {
					data = d;
					schedule();
				}
			})
			.catch(() => {});

	const fiberRoot = () => {
		for (const el of document.querySelectorAll('body > *')) {
			const key = Object.keys(el).find((k) => k.startsWith('__reactContainer$'));
			if (key) return el[key].stateNode;
		}
		return null;
	};

	const isBadgesHost = (fiber) => {
		const p = fiber.memoizedProps;
		return (
			p && typeof p === 'object' && typeof p['data-flx'] === 'string' &&
			p['data-flx'].endsWith('user-profile-badges') && p.user && p.user.id
		);
	};

	const firstHost = (fiber) => {
		for (let f = fiber; f; f = f.child) if (f.stateNode instanceof Element) return f.stateNode;
		return null;
	};

	const findHosts = (root) => {
		const found = [];
		let f = root.current;
		while (f) {
			if (isBadgesHost(f)) {
				found.push(f);
			} else if (f.child) {
				f = f.child;
				continue;
			}
			while (f && !f.sibling) f = f.return;
			f = f && f.sibling;
		}
		return found;
	};

	const parentHost = (fiber) => {
		for (let f = fiber.return; f; f = f.return) if (f.stateNode instanceof Element) return f.stateNode;
		return null;
	};

	const nextHost = (fiber) => {
		for (let s = fiber.sibling; s; s = s.sibling) {
			const el = firstHost(s);
			if (el) return el;
		}
		return null;
	};

	const sync = () => {
		const root = data && fiberRoot();
		if (!root) return;
		const keep = new Set();
		for (const fiber of findHosts(root)) {
			const p = fiber.memoizedProps;
			const ids = (data.users[p.user.id] || []).filter((id) => data.badges[id]);
			if (!ids.length) continue;
			const size = p.isModal && p.isMobile ? '1.75rem' : '1.25rem';
			const sig = `${p.user.id}:${ids.join(',')}:${size}`;
			// The official container exists only when the user has an official badge.
			let box = firstHost(fiber.child);
			if (!box || box.getAttribute('data-flx') !== 'user.user-profile-badges.div') {
				const parent = parentHost(fiber);
				if (!parent) continue;
				box = parent.querySelector(`:scope > div[${MARK}="own"]`);
				if (!box) {
					box = document.createElement('div');
					box.setAttribute(MARK, 'own');
					box.style.cssText = p.isModal
						? `display:flex;align-items:center;gap:${p.isMobile ? '.5rem' : '.25rem'}`
						: 'position:absolute;top:7.1875rem;right:.625rem;z-index:10;display:flex;gap:.25rem;' +
							'border-radius:.375rem;padding:.25rem;' +
							'background:color-mix(in srgb,var(--background-secondary) 80%,transparent)';
					parent.insertBefore(box, nextHost(fiber));
				}
			}
			keep.add(box);
			if (box.getAttribute('data-msc-sig') === sig) continue;
			box.setAttribute('data-msc-sig', sig);
			box.querySelectorAll(':scope > [data-msc-badge]').forEach((el) => el.remove());
			for (const id of ids) {
				const b = data.badges[id];
				const img = document.createElement('img');
				img.setAttribute('data-msc-badge', id);
				img.src = b.icon_url;
				img.alt = b.name;
				img.title = b.description ? `${b.name} : ${b.description}` : b.name;
				img.style.cssText = `width:${size};height:${size};object-fit:contain`;
				box.appendChild(img);
			}
		}
		// Clean up badges whose profile is gone or now shows someone else.
		document.querySelectorAll('[data-msc-sig]').forEach((box) => {
			if (keep.has(box)) return;
			if (box.getAttribute(MARK) === 'own') box.remove();
			else {
				box.removeAttribute('data-msc-sig');
				box.querySelectorAll(':scope > [data-msc-badge]').forEach((el) => el.remove());
			}
		});
	};

	let timer = 0;
	const schedule = () => {
		if (!timer) timer = setTimeout(() => {
			timer = 0;
			try {
				sync();
			} catch (e) {
				console.warn('[myserycord] badges', e);
			}
		}, 150);
	};

	new MutationObserver(schedule).observe(document.documentElement, {childList: true, subtree: true});
	load();
	setInterval(load, 5 * 60 * 1000);
})();
