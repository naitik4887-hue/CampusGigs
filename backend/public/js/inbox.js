import { h, api, state, timeAgo, refreshUnread } from './core.js';

const clock = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

function dayLabel(d) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The messages page. It is built once and stays on screen while the person moves between
 * conversations, so switching is instant: no reload flash, no lost scroll position.
 * Sending is optimistic: your message appears immediately and shows "Sending…" until the server confirms.
 */
export async function createInbox(initialListingId, initialUserId) {
  let current = { listingId: null, userId: null };
  let threads = [];
  let view = null; // the open conversation
  let token = 0; // ignores out-of-date responses
  let tick = 0;
  let destroyed = false;

  const root = h('div', { class: 'inbox' });
  const listPane = h('aside', { class: 'threads', 'aria-label': 'Conversations' });
  const threadPane = h('section', { class: 'thread' });
  root.append(listPane, threadPane);
  const node = h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'Messages')), root);

  /* ---------------- conversation list ---------------- */

  function threadItem(t) {
    const active = String(t.listingId) === String(current.listingId) && String(t.other.id) === String(current.userId);
    return h(
      'a',
      {
        class: 'thread-item' + (t.unread ? ' unread' : ''),
        href: `#/inbox/${t.listingId}/${t.other.id}`,
        'aria-current': active ? 'true' : null,
      },
      h('div', { class: 'top' }, h('b', null, t.other.name), h('time', null, timeAgo(t.lastMessage.createdAt))),
      h(
        'div',
        { class: 'about' },
        h('span', { class: 'tag ' + (t.listingSection === 'item' ? 'market' : 'plain') }, t.listingSection === 'item' ? 'Marketplace' : 'Service'),
        h('span', null, t.listingTitle)
      ),
      h('div', { class: 'last' }, t.unread > 0 && h('span', { class: 'dot', title: `${t.unread} unread` }), (t.lastMessage.mine ? 'You: ' : '') + t.lastMessage.body)
    );
  }

  function renderList() {
    listPane.replaceChildren(
      threads.length
        ? threads.map(threadItem)
        : h(
            'div',
            { class: 'placeholder' },
            h('b', null, 'No conversations yet'),
            h('p', { class: 'hint' }, 'Message someone from a listing to start one. Messages about your own listings appear here too.'),
            h('a', { class: 'btn btn-sm', href: '#/services' }, 'Browse services'),
            ' ',
            h('a', { class: 'btn btn-sm', href: '#/market' }, 'Browse marketplace')
          )
    );
  }

  async function loadThreads() {
    const data = await api('/messages/threads');
    threads = data.threads;
    if (!destroyed) renderList();
  }

  /* ---------------- open conversation ---------------- */

  function buildThread(data) {
    const key = `${current.listingId}/${current.userId}`;
    const msgBox = h('div', { class: 'msgs', role: 'log', 'aria-label': `Conversation with ${data.other.name}` });
    const newPill = h('button', { class: 'new-pill', type: 'button', hidden: true, onclick: () => scrollToBottom() }, 'New message ↓');
    const v = { key, msgBox, newPill, pending: [], data, lastSig: '', stick: true, prevLen: undefined };
    view = v;

    const scrollToBottom = () => {
      msgBox.scrollTop = msgBox.scrollHeight;
      newPill.hidden = true;
    };
    v.scrollToBottom = scrollToBottom;
    msgBox.addEventListener('scroll', () => {
      if (msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 80) newPill.hidden = true;
    });

    const closedForMe = data.listing.status === 'closed' && data.listing.ownerId !== state.me.id;
    let composer;
    if (closedForMe) {
      composer = h('div', { class: 'banner', style: { margin: '12px' } }, data.listing.section === 'item' ? 'This item has been sold, so you can’t send new messages.' : 'This listing is closed, so you can’t send new messages.');
    } else {
      const ta = h('textarea', { rows: 1, maxlength: 1000, placeholder: 'Write a message…', 'aria-label': 'Message' });
      const autosize = () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
      };
      const form = h(
        'form',
        {
          class: 'compose',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            const text = ta.value;
            if (!text.trim()) return;
            ta.value = '';
            autosize();
            send(text);
          },
        },
        ta,
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send')
      );
      ta.addEventListener('input', autosize);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
      composer = form;
      v.ta = ta;
    }

    threadPane.replaceChildren(
      h(
        'div',
        { class: 'thread-head' },
        h('a', { class: 'back-mobile', href: '#/inbox' }, 'All conversations'),
        h('b', null, `${data.other.name} · ${data.other.university}`),
        h('a', { href: `#/listing/${data.listing.id}` }, data.listing.title + (data.listing.status === 'closed' ? ' (closed)' : ''))
      ),
      h('div', { class: 'msgs-wrap' }, msgBox, newPill),
      composer
    );
    if (v.ta && window.innerWidth > 720) v.ta.focus({ preventScroll: true });
  }

  function renderMessages() {
    const v = view;
    if (!v) return;
    const msgs = v.data.messages;
    const sig = msgs.map((m) => m.id + (m.read ? 'r' : '')).join(',') + '|' + v.pending.map((p) => p.id + p.status).join(',');
    if (sig === v.lastSig) return;
    v.lastSig = sig;

    const { msgBox } = v;
    const nearBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 80;
    const children = [];
    let lastDay = '';
    for (const m of msgs) {
      const d = new Date(m.createdAt);
      if (d.toDateString() !== lastDay) {
        lastDay = d.toDateString();
        children.push(h('div', { class: 'day-sep' }, dayLabel(d)));
      }
      children.push(h('div', { class: 'bubble ' + (m.mine ? 'mine' : 'theirs') }, m.body, h('time', { datetime: m.createdAt }, clock(m.createdAt))));
    }
    const last = msgs[msgs.length - 1];
    if (last && last.mine && v.pending.length === 0) children.push(h('div', { class: 'receipt' }, last.read ? 'Seen' : 'Sent'));

    for (const p of v.pending) {
      children.push(
        h(
          'div',
          { class: 'bubble mine pending' + (p.status === 'failed' ? ' failed' : '') },
          p.body,
          p.status === 'sending'
            ? h('time', null, 'Sending…')
            : h('span', { class: 'fail-note', title: p.error || '' }, 'Not sent. ', h('button', { class: 'link-btn', type: 'button', onclick: () => retry(p) }, 'Try again'))
        )
      );
    }
    if (!children.length) children.push(h('div', { class: 'placeholder' }, 'No messages yet. Say hello!'));

    msgBox.replaceChildren(children);

    const grew = v.prevLen !== undefined && msgs.length > v.prevLen && last && !last.mine;
    if (v.stick || nearBottom || v.prevLen === undefined) {
      v.scrollToBottom();
      v.stick = false;
    } else if (grew) {
      v.newPill.hidden = false;
    }
    v.prevLen = msgs.length;
  }

  async function loadThread(reset) {
    const { listingId, userId } = current;
    const mine = ++token;
    let data;
    try {
      data = await api(`/messages/thread?listingId=${encodeURIComponent(listingId)}&userId=${encodeURIComponent(userId)}`);
    } catch (err) {
      if (mine !== token || destroyed) return;
      if (reset) {
        view = null;
        threadPane.replaceChildren(
          h(
            'div',
            { class: 'placeholder' },
            err.status === 404 ? 'This conversation is no longer available.' : err.message,
            h('br'),
            h('a', { href: '#/inbox' }, 'Back to messages')
          )
        );
      }
      return;
    }
    if (mine !== token || destroyed) return;
    if (reset || !view || view.key !== `${listingId}/${userId}`) buildThread(data);
    view.data = data;
    renderMessages();
  }

  async function send(text) {
    const body = text.trim();
    const v = view;
    if (!v || !body) return;
    const { listingId, userId } = current;
    const p = { id: 'p' + Date.now() + Math.random(), body, status: 'sending' };
    v.pending.push(p);
    v.stick = true;
    renderMessages();
    try {
      await api('/messages', { method: 'POST', body: { listingId: Number(listingId), toUserId: Number(userId), body } });
      v.pending = v.pending.filter((x) => x !== p);
      if (view === v) {
        await loadThread(false);
        loadThreads().catch(() => {});
      }
    } catch (err) {
      p.status = 'failed';
      p.error = err.message;
      if (view === v) renderMessages();
    }
  }

  function retry(p) {
    if (!view) return;
    view.pending = view.pending.filter((x) => x !== p);
    view.lastSig = ''; // force a redraw
    renderMessages();
    send(p.body);
  }

  /** Called by the router. Switches conversation without rebuilding the page. */
  async function open(listingId, userId) {
    current = { listingId: listingId || null, userId: userId || null };
    const hasThread = Boolean(listingId && userId);
    root.classList.toggle('has-thread', hasThread);
    renderList(); // updates the highlighted conversation immediately
    if (!hasThread) {
      ++token;
      view = null;
      threadPane.replaceChildren(h('div', { class: 'placeholder' }, 'Select a conversation to read it.'));
      return;
    }
    await loadThread(true);
    loadThreads().catch(() => {});
    refreshUnread();
  }

  /* ---------------- keep it fresh ---------------- */

  const timer = setInterval(async () => {
    if (document.hidden || destroyed) return;
    tick++;
    try {
      if (current.listingId && current.userId) await loadThread(false);
      if (tick % 3 === 0) {
        await loadThreads();
        refreshUnread();
      }
    } catch (_) {
      /* ignore polling errors */
    }
  }, 5000);

  const onVisible = () => {
    if (document.hidden || destroyed) return;
    loadThreads().catch(() => {});
    if (current.listingId && current.userId) loadThread(false);
    refreshUnread();
  };
  document.addEventListener('visibilitychange', onVisible);

  function destroy() {
    destroyed = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  }

  await Promise.all([loadThreads(), open(initialListingId, initialUserId)]);
  return { node, open, destroy };
}
