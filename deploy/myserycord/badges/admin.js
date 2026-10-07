'use strict';
const API = '/admin/myserycord/api';
const $ = (s) => document.querySelector(s);
let state = {badges: {}, users: {}};

const el = (tag, props = {}, ...children) => {
	const e = Object.assign(document.createElement(tag), props);
	e.append(...children);
	return e;
};
const icon = (b, cls = 'icon') => el('img', {src: `/myserycord/icons/${b.icon}`, className: cls, alt: b.name, title: b.name});
const say = (text, err = false) => {
	$('#msg').textContent = text;
	$('#msg').className = err ? 'err' : '';
};

async function call(action, body) {
	const r = await fetch(`${API}/${action}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
	const j = await r.json().catch(() => ({}));
	if (r.status === 401) location.href = '/admin/login';
	if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
	await refresh();
	return j;
}
const guard = (fn) => async (...a) => {
	try {
		say('');
		await fn(...a);
	} catch (e) {
		say(e.message, true);
	}
};
const readFile = (file) =>
	new Promise((ok, ko) => {
		const r = new FileReader();
		r.onload = () => ok(r.result);
		r.onerror = ko;
		r.readAsDataURL(file);
	});

function badgeSelect() {
	return el('select', {}, ...Object.entries(state.badges).map(([id, b]) => el('option', {value: id}, b.name)));
}

function render() {
	const holders = {};
	for (const u of Object.values(state.users)) for (const id of u.badges) holders[id] = (holders[id] || 0) + 1;
	$('#badges').replaceChildren(
		...Object.entries(state.badges).map(([id, b]) => {
			const name = el('input', {type: 'text', value: b.name, maxLength: 64});
			const desc = el('input', {type: 'text', value: b.description || '', maxLength: 200});
			const file = el('input', {type: 'file', accept: 'image/png,image/webp,image/gif,image/svg+xml'});
			const save = el('button', {textContent: 'Enregistrer', onclick: guard(async () => {
				await call('update', {id, name: name.value, description: desc.value, icon: file.files[0] ? await readFile(file.files[0]) : null});
				say('Badge mis à jour.');
			})});
			const del = el('button', {className: 'ghost', textContent: 'Supprimer', onclick: guard(async () => {
				if (confirm(`Supprimer le badge « ${b.name} » et le retirer à ${holders[id] || 0} utilisateur(s) ?`)) await call('delete', {id});
			})});
			return el('tr', {}, el('td', {}, icon(b)), el('td', {}, name), el('td', {}, desc, file), el('td', {}, String(holders[id] || 0)), el('td', {}, el('div', {className: 'row'}, save, del)));
		}),
	);
	if (!Object.keys(state.badges).length) $('#badges').append(el('tr', {}, el('td', {colSpan: 5, className: 'muted'}, 'Aucun badge.')));
	$('#users').replaceChildren(
		...Object.entries(state.users).map(([uid, u]) =>
			el('tr', {},
				el('td', {}, el('strong', {}, u.username || '?'), el('div', {className: 'muted'}, uid)),
				el('td', {}, ...u.badges.filter((id) => state.badges[id]).map((id) =>
					el('span', {className: 'chip'}, icon(state.badges[id], ''), state.badges[id].name,
						el('button', {textContent: '×', title: 'Retirer', onclick: guard(() => call('unassign', {user_id: uid, badge_id: id}))})))),
			),
		),
	);
	if (!Object.keys(state.users).length) $('#users').append(el('tr', {}, el('td', {className: 'muted'}, 'Personne pour l’instant.')));
}

async function refresh() {
	const r = await fetch(`${API}/state`, {cache: 'no-store'});
	if (r.status === 401) return (location.href = '/admin/login');
	state = await r.json();
	$('#me').textContent = state.me;
	render();
}

$('#create').addEventListener('submit', guard(async (ev) => {
	ev.preventDefault();
	const f = ev.target;
	await call('create', {name: f.name.value, description: f.description.value, icon: await readFile(f.icon.files[0])});
	f.reset();
	say('Badge créé.');
}));

$('#search').addEventListener('submit', guard(async (ev) => {
	ev.preventDefault();
	const r = await fetch(`${API}/users?q=${encodeURIComponent(ev.target.q.value)}`);
	const users = await r.json();
	if (!r.ok) throw new Error(users.error || `HTTP ${r.status}`);
	if (!Object.keys(state.badges).length) throw new Error('Crée d’abord un badge.');
	$('#results').replaceChildren(
		...users.map((u) => {
			const tag = u.discriminator && u.discriminator !== '0' && u.discriminator !== '0000' ? `${u.username}#${u.discriminator}` : u.username;
			const sel = badgeSelect();
			return el('tr', {},
				el('td', {}, el('strong', {}, u.global_name || u.username), el('div', {className: 'muted'}, `${tag} · ${u.id}`)),
				el('td', {}, el('div', {className: 'row'}, sel, el('button', {textContent: 'Attribuer', onclick: guard(async () => {
					await call('assign', {user_id: u.id, username: tag, badge_id: sel.value});
					say(`Badge « ${state.badges[sel.value].name} » attribué à ${tag}.`);
				})}))),
			);
		}),
	);
	if (!users.length) $('#results').append(el('tr', {}, el('td', {className: 'muted'}, 'Aucun utilisateur trouvé.')));
}));

refresh();
