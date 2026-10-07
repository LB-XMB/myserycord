// Myserycord: adds a "Badges" entry under "Users" in the official admin sidebar.
(() => {
	const add = () => {
		if (document.querySelector('a[data-msc-nav]')) return;
		// The sidebar brand ("Fluxer Admin") also links to /users: match the "Users" entry by its text.
		const users = [...document.querySelectorAll('a[href]')].find(
			(a) => /\/admin\/users\/?$/.test(a.getAttribute('href')) && a.textContent.trim() === 'Users',
		);
		if (!users) return;
		const link = users.cloneNode(true);
		link.setAttribute('data-msc-nav', '');
		link.setAttribute('href', '/admin/myserycord/');
		link.removeAttribute('hx-get');
		link.removeAttribute('hx-boost');
		link.removeAttribute('aria-current');
		link.removeAttribute('data-active');
		// When "Users" is the current page its classes carry the active style: take Guilds' instead.
		const plain = document.querySelector('a[href$="/admin/guilds"]:not([data-active])');
		if (plain) link.className = plain.className;
		const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.nodeValue.trim() === 'Users') n.nodeValue = n.nodeValue.replace('Users', 'Badges');
		}
		const item = users.parentElement && users.parentElement.tagName === 'LI' ? users.parentElement : null;
		if (item) {
			const li = item.cloneNode(false);
			li.appendChild(link);
			item.after(li);
		} else {
			users.after(link);
		}
	};
	add();
	document.addEventListener('htmx:afterSwap', add);
})();
