import {
  $, h, api, state, runLeave, onLeave, onSection, setSection, refreshUnread, refreshMe, updateVerifyMenu, initials,
  skeletonGrid, errorBox, applyUnreadTitle,
} from './js/core.js';
import { browseView } from './js/browse.js';
import { detailView } from './js/detail.js';
import { serviceForm, itemForm, editView } from './js/forms.js';
import { mineView, verifyView, adminView } from './js/account.js';
import { createInbox } from './js/inbox.js';

const app = document.getElementById('app');
let navId = 0; // ignores pages that finish loading after the person has moved on
let lastPath = '';
let inbox = null; // the messages page stays alive while moving between conversations

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function parseHash() {
  const hash = location.hash || '#/';
  const [pathPart, qs = ''] = hash.slice(1).split('?');
  return { parts: pathPart.split('/').filter(Boolean), params: new URLSearchParams(qs), qs };
}

const TITLES = {
  services: 'Services',
  market: 'Marketplace',
  mine: 'My listings',
  verify: 'Verify college ID',
  admin: 'ID requests',
  inbox: 'Messages',
};

async function route() {
  const { parts, params, qs } = parseHash();

  // Old and shorthand addresses
  if (parts.length === 0) return location.replace('#/services' + (qs ? '?' + qs : ''));
  if (parts[0] === 'new' && !parts[1]) return location.replace('#/new/service');

  // Moving between conversations: keep the inbox on screen and just switch thread.
  if (parts[0] === 'inbox' && inbox && inbox.node.isConnected) {
    setSection(null);
    await inbox.open(parts[1], parts[2]);
    return;
  }

  runLeave();
  inbox = null;
  const mine = ++navId;
  const path = parts.join('/');
  const reload = () => route();

  app.replaceChildren(skeletonGrid(parts[0] === 'services' || parts[0] === 'market' || parts[0] === 'mine' ? 6 : 2));

  let node;
  try {
    // Unverified students may have been approved since they logged in.
    if (!state.me.idVerified) await refreshMe().catch(() => {});

    const [a, b] = parts;
    if (a === 'services') {
      setSection('services');
      node = await browseView('service', params);
    } else if (a === 'market') {
      setSection('market');
      node = await browseView('item', params);
    } else if (a === 'listing' && b) {
      node = await detailView(b, reload);
    } else if (a === 'new' && b === 'service') {
      node = await serviceForm();
    } else if (a === 'new' && b === 'item') {
      node = await itemForm();
    } else if (a === 'edit' && b) {
      node = await editView(b);
    } else if (a === 'mine') {
      node = await mineView(reload);
    } else if (a === 'verify') {
      node = await verifyView(reload);
    } else if (a === 'admin') {
      node = await adminView(reload);
    } else if (a === 'inbox') {
      setSection(null);
      const ctl = await createInbox(b, parts[2]);
      onLeave(() => ctl.destroy());
      inbox = ctl;
      node = ctl.node;
    } else {
      node = errorBox('That page does not exist.');
    }
  } catch (ex) {
    if (ex.status === 401) return; // api() is already sending them to the login page
    node = errorBox(ex.message);
  }

  if (mine !== navId) {
    // The person went somewhere else while this page was loading.
    if (inbox && node === inbox.node) {
      runLeave();
      inbox = null;
    }
    return;
  }

  app.replaceChildren(node);
  if (TITLES[parts[0]]) document.title = `${TITLES[parts[0]]} · CampusGigs`;
  else if (!document.title.includes('CampusGigs')) document.title = 'CampusGigs';
  applyUnreadTitle();

  // Move focus to the page and scroll to top, but only when the page itself changed (not just a filter).
  if (path !== lastPath) {
    window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
  }
  lastPath = path;
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function applySection(section) {
  const active = section || state.lastSection;
  document.body.classList.toggle('market-mode', active === 'market');

  for (const tab of document.querySelectorAll('.tabs a')) {
    if (section && tab.dataset.tab === section) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  const post = $('#postBtn');
  const isMarket = active === 'market';
  post.textContent = isMarket ? 'Sell an item' : 'Post a service';
  post.href = isMarket ? '#/new/item' : '#/new/service';
  $('#fab').href = post.href;
  $('#fab').setAttribute('aria-label', post.textContent);
  $('#searchInput').placeholder = isMarket ? 'Search books, cycles, laptops…' : 'Search tutoring, design, coding…';
}

function setupHeader() {
  $('#menuBtn').textContent = initials(state.me.name);
  $('#menuName').textContent = state.me.name;
  $('#menuUni').textContent = state.me.university;
  $('#menuAdmin').hidden = !state.me.isAdmin;
  updateVerifyMenu();
  onSection(applySection);
  applySection(null);

  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    location.hash = `#/${state.lastSection}` + (q ? '?q=' + encodeURIComponent(q) : '');
  });

  const btn = $('#menuBtn');
  const pop = $('#menuPop');
  const setOpen = (open) => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => setOpen(pop.hidden));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) setOpen(false);
  });
  pop.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

(async function init() {
  try {
    const [meRes, meta] = await Promise.all([api('/auth/me'), api('/meta')]);
    state.me = meRes.user;
    state.meta = meta;
  } catch (ex) {
    if (ex.status === 401) return; // redirected to the login page
    app.replaceChildren(
      h(
        'div',
        { class: 'notice error', role: 'alert' },
        'CampusGigs could not load: ' + ex.message + ' Make sure the server is running the latest files, then refresh (Ctrl + Shift + R).'
      )
    );
    return;
  }
  setupHeader();
  refreshUnread();
  setInterval(() => {
    if (!document.hidden) refreshUnread();
  }, 20000);
  window.addEventListener('hashchange', route);
  route();
})();
