// Myserycord: adds a "Badges" entry under "Users" in the official admin sidebar.
(() => {
	const add = () => {
		if (document.querySelector('a[data-msc-nav]')) return;
		const users = [...document.querySelectorAll('a[href]')].find((a) => /\/admin\/users\/?$/.test(a.getAttribute('href')));
		if (!users) return;
		const link = users.cloneNode(true);
		link.setAttribute('data-msc-nav', '');
		link.setAttribute('href', '/admin/myserycord/');
		link.removeAttribute('hx-get');
		link.removeAttribute('hx-boost');
		link.removeAttribute('aria-current');
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
