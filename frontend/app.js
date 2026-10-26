(() => {
  'use strict';

  const CURRENCY = '₹';
  const app = document.getElementById('app');
  const $ = (sel, root = document) => root.querySelector(sel);

  let me = null; // current user
  let meta = null; // categories etc. from the server
  let navId = 0; // guards against out-of-order renders
  let cleanup = null; // function to stop timers when leaving a page

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  // Builds DOM safely (text is never parsed as HTML).
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = '/';
      throw new Error('Please log in.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  function timeAgo(iso) {
    const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const hr = Math.floor(m / 60);
    if (hr < 24) return `${hr} hr ago`;
    const d = Math.floor(hr / 24);
    if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`;
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const money = (n) => CURRENCY + Number(n).toLocaleString('en-IN');
  function priceLabel(l) {
    if (l.priceType === 'fixed') return money(l.price);
    if (l.priceType === 'hourly') return money(l.price) + ' per hour';
    if (l.priceType === 'free') return 'Free';
    return 'Price negotiable';
  }
  const kindLabel = (k) => (k === 'offer' ? 'Offering' : 'Looking for');
  const modeLabel = (m) => ({ campus: 'On campus', online: 'Online', both: 'Campus or online' }[m] || m);
  const firstName = (name) => String(name).split(' ')[0];
  const initials = (name) =>
    String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  function catColor(cat) {
    const i = meta.categories.indexOf(cat);
    return `hsl(${(i < 0 ? 0 : i) * 40} 55% 42%)`;
  }

  const errorBox = (text) =>
    h('div', { class: 'notice error', role: 'alert' }, text, ' ', h('a', { href: '#/' }, 'Back to services'));

  /* ------------------------------------------------------------------ */
  /* Browse                                                              */
  /* ------------------------------------------------------------------ */

  function listingCard(l) {
    return h(
      'a',
      { class: 'card', href: `#/listing/${l.id}`, style: { '--cat': catColor(l.category) } },
      h(
        'div',
        { class: 'tags' },
        h('span', { class: 'tag' + (l.kind === 'request' ? ' request' : '') }, kindLabel(l.kind)),
        l.status === 'closed' && h('span', { class: 'tag closed' }, 'Closed'),
        h('span', { class: 'cat-name' }, l.category)
      ),
      h('h3', null, l.title),
      h('p', { class: 'desc' }, l.description),
      h(
        'div',
        { class: 'card-foot' },
        h('span', { class: 'price' }, priceLabel(l)),
        h('span', { class: 'seller' }, `${firstName(l.seller.name)}, ${l.seller.university}`)
      )
    );
  }

  async function browseView(params) {
    const f = {
      q: params.get('q') || '',
      category: params.get('category') || '',
      kind: params.get('kind') || '',
      sort: params.get('sort') || 'new',
      uni: params.get('uni') || '',
      page: Math.max(1, parseInt(params.get('page'), 10) || 1),
    };
    $('#searchInput').value = f.q;

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
    const data = await api('/listings?' + qs.toString());

    // Update filters by changing the URL hash; the router re-renders.
    const go = (changes) => {
      const next = { ...f, page: 1, ...changes };
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) {
        if (!v || (k === 'sort' && v === 'new') || (k === 'page' && Number(v) === 1)) continue;
        p.set(k, v);
      }
      const s = p.toString();
      location.hash = '#/' + (s ? '?' + s : '');
    };

    const kinds = [['', 'All'], ['offer', 'Offering'], ['request', 'Looking for']];
    const seg = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Type' },
      kinds.map(([val, label]) => h('button', { type: 'button', 'aria-pressed': String(f.kind === val), onclick: () => go({ kind: val }) }, label))
    );

    const chips = h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Category' },
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.category === ''), onclick: () => go({ category: '' }) }, 'All categories'),
      meta.categories.map((c) =>
        h(
          'button',
          { type: 'button', class: 'chip', style: { '--cat': catColor(c) }, 'aria-pressed': String(f.category === c), onclick: () => go({ category: c }) },
          h('i'),
          c
        )
      )
    );

    const sortSel = h(
      'select',
      { 'aria-label': 'Sort by', onchange: (e) => go({ sort: e.target.value }) },
      [['new', 'Newest first'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low']].map(([v, t]) =>
        h('option', { value: v, selected: f.sort === v }, t)
      )
    );
    const uniCheck = h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: f.uni === 'mine', onchange: (e) => go({ uni: e.target.checked ? 'mine' : '' }) }),
      `Only ${me.university}`
    );

    const heading = f.q ? `Results for “${f.q}”` : 'Find help from students';
    const count = `${data.total} service${data.total === 1 ? '' : 's'}`;

    let results;
    if (data.listings.length) {
      results = h('div', { class: 'grid' }, data.listings.map(listingCard));
    } else {
      results = h(
        'div',
        { class: 'empty' },
        h('h3', null, 'No services match yet'),
        h('p', null, 'Try different words or filters, or post what you are looking for and let people reach out.'),
        h('a', { class: 'btn btn-primary', href: '#/new' }, 'Post a service')
      );
    }

    const pager =
      data.pages > 1 &&
      h(
        'div',
        { class: 'pager' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: data.page <= 1, onclick: () => go({ page: data.page - 1 }) }, 'Previous'),
        `Page ${data.page} of ${data.pages}`,
        h('button', { class: 'btn btn-sm', type: 'button', disabled: data.page >= data.pages, onclick: () => go({ page: data.page + 1 }) }, 'Next')
      );

    return h(
      'div',
      null,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, heading), h('p', null, count))),
      h('div', { class: 'filters' }, h('div', { class: 'filter-row' }, seg, h('div', { class: 'toolbar' }, uniCheck, sortSel)), chips),
      results,
      pager
    );
  }

  /* ------------------------------------------------------------------ */
  /* Listing detail                                                      */
  /* ------------------------------------------------------------------ */

  async function detailView(id) {
    const { listing: l } = await api('/listings/' + encodeURIComponent(id));

    const side = h('div', { class: 'aside-stack' });
    const person = h(
      'div',
      { class: 'person' },
      h('span', { class: 'avatar lg', 'aria-hidden': 'true' }, initials(l.seller.name)),
      h('div', null, h('b', null, l.seller.name), h('span', null, l.seller.university))
    );

    if (l.isOwner) {
      const setStatus = async (status) => {
        try {
          await api(`/listings/${l.id}/status`, { method: 'PATCH', body: { status } });
          toast(status === 'closed' ? 'Listing closed' : 'Listing reopened');
          route();
        } catch (err) {
          toast(err.message);
        }
      };
      side.append(
        h(
          'div',
          { class: 'panel' },
          h('b', null, 'This is your listing'),
          h('p', { class: 'hint' }, 'Messages from interested students show up in your inbox.'),
          h(
            'div',
            { class: 'actions' },
            h('a', { class: 'btn btn-primary', href: '#/inbox' }, 'Open messages'),
            h('a', { class: 'btn', href: `#/edit/${l.id}` }, 'Edit listing'),
            l.status === 'active'
              ? h('button', { class: 'btn', type: 'button', onclick: () => setStatus('closed') }, 'Close listing')
              : h('button', { class: 'btn', type: 'button', onclick: () => setStatus('active') }, 'Reopen listing'),
            h(
              'button',
              {
                class: 'btn btn-danger',
                type: 'button',
                onclick: async () => {
                  if (!confirm('Delete this listing and its messages? This cannot be undone.')) return;
                  try {
                    await api('/listings/' + l.id, { method: 'DELETE' });
                    toast('Listing deleted');
                    location.hash = '#/mine';
                  } catch (err) {
                    toast(err.message);
                  }
                },
              },
              'Delete listing'
            )
          )
        )
      );
    } else if (l.status === 'closed') {
      side.append(h('div', { class: 'panel' }, person, h('div', { class: 'banner' }, 'This listing is closed and not taking messages.')));
    } else {
      const ta = h('textarea', {
        id: 'msgBody',
        rows: 5,
        maxlength: 1000,
        required: true,
        placeholder:
          l.kind === 'offer'
            ? 'Hi! I’m interested in your service. Are you free this week?'
            : 'Hi! I can help with this. Here’s what I’ve done before…',
      });
      const err = h('p', { class: 'msg error', role: 'alert' });
      const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Send message');
      const box = h('div', { class: 'panel' });
      const form = h(
        'form',
        {
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            err.textContent = '';
            const body = ta.value.trim();
            if (!body) {
              err.textContent = 'Write a message first.';
              return;
            }
            btn.disabled = true;
            btn.textContent = 'Sending…';
            try {
              await api('/messages', { method: 'POST', body: { listingId: l.id, body } });
              box.replaceChildren(
                person,
                h('p', { class: 'sent' }, 'Message sent.'),
                h('p', { class: 'hint' }, `${firstName(l.seller.name)} will get an email. Replies appear in your messages.`),
                h('a', { class: 'btn btn-block', href: `#/inbox/${l.id}/${l.seller.id}` }, 'View conversation')
              );
            } catch (ex) {
              err.textContent = ex.message;
              btn.disabled = false;
              btn.textContent = 'Send message';
            }
          },
        },
        h('div', { class: 'field' }, h('label', { for: 'msgBody' }, `Message ${firstName(l.seller.name)}`), ta),
        err,
        btn
      );
      box.append(person, form);
      side.append(box, h('p', { class: 'hint' }, 'Meet in public places on campus and agree on details before you start. Payments happen directly between you.'));
    }

    return h(
      'div',
      null,
      h('a', { class: 'back', href: '#/' }, 'Back to services'),
      h(
        'div',
        { class: 'detail' },
        h(
          'article',
          { class: 'panel' },
          l.status === 'closed' && h('div', { class: 'banner' }, 'This listing is closed.'),
          h(
            'div',
            { class: 'tags' },
            h('span', { class: 'tag' + (l.kind === 'request' ? ' request' : '') }, kindLabel(l.kind)),
            h('span', { class: 'tag plain' }, l.category),
            h('span', { class: 'tag plain' }, modeLabel(l.mode))
          ),
          h('h1', null, l.title),
          h('p', { class: 'meta' }, `Posted ${timeAgo(l.createdAt)}`),
          h('div', { class: 'big-price' }, priceLabel(l)),
          h('div', { class: 'body' }, l.description)
        ),
        side
      )
    );
  }

  /* ------------------------------------------------------------------ */
  /* Create / edit listing                                               */
  /* ------------------------------------------------------------------ */

  async function formView(id) {
    let l = null;
    if (id) {
      const data = await api('/listings/' + encodeURIComponent(id));
      l = data.listing;
      if (!l.isOwner) throw new Error('You can only edit your own listings.');
    }
    const v = l || { kind: 'offer', title: '', category: '', description: '', priceType: 'fixed', price: '', mode: 'both' };

    const err = h('p', { class: 'msg error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, l ? 'Save changes' : 'Post service');

    const priceInput = h('input', { id: 'price', name: 'price', type: 'number', min: 1, step: 1, inputmode: 'numeric', value: v.price ?? '' });
    const priceWrap = h('div', { class: 'field' }, h('label', { for: 'price' }, `Amount (${CURRENCY})`), priceInput);
    const priceType = h(
      'select',
      { id: 'priceType', name: 'priceType', onchange: syncPrice },
      [['fixed', 'Fixed price'], ['hourly', 'Per hour'], ['negotiable', 'Negotiable'], ['free', 'Free']].map(([val, t]) =>
        h('option', { value: val, selected: v.priceType === val }, t)
      )
    );
    function syncPrice() {
      priceWrap.hidden = !['fixed', 'hourly'].includes(priceType.value);
    }

    const radio = (val, title, hint) =>
      h('label', null, h('input', { type: 'radio', name: 'kind', value: val, checked: v.kind === val }), h('span', null, h('b', null, title), h('small', null, hint)));

    const form = h(
      'form',
      {
        class: 'panel form-card',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const fd = new FormData(form);
          const body = {
            kind: fd.get('kind'),
            title: fd.get('title'),
            category: fd.get('category'),
            description: fd.get('description'),
            priceType: fd.get('priceType'),
            price: priceWrap.hidden ? null : fd.get('price'),
            mode: fd.get('mode'),
          };
          submit.disabled = true;
          try {
            const res = l
              ? await api('/listings/' + l.id, { method: 'PUT', body })
              : await api('/listings', { method: 'POST', body });
            toast(l ? 'Changes saved' : 'Service posted');
            location.hash = '#/listing/' + res.id;
          } catch (ex) {
            err.textContent = ex.message;
            submit.disabled = false;
          }
        },
      },
      h('h1', { style: { 'font-size': '1.5rem', 'margin-bottom': '20px' } }, l ? 'Edit your listing' : 'Post a service'),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'What are you posting?'),
        h('div', { class: 'radio-row' }, radio('offer', 'I’m offering a service', 'Tutoring, design, coding…'), radio('request', 'I’m looking for help', 'Someone to do or teach something'))
      ),
      h('div', { class: 'field' }, h('label', { for: 'title' }, 'Title'), h('input', { id: 'title', name: 'title', type: 'text', maxlength: 100, value: v.title }), h('div', { class: 'hint' }, 'Example: “Calculus tutoring for first years”')),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'category' }, 'Category'),
        h('select', { id: 'category', name: 'category' }, h('option', { value: '' }, 'Choose a category'), meta.categories.map((c) => h('option', { value: c, selected: v.category === c }, c)))
      ),
      h('div', { class: 'field' }, h('label', { for: 'description' }, 'Description'), h('textarea', { id: 'description', name: 'description', rows: 7, maxlength: 2000 }, v.description), h('div', { class: 'hint' }, 'What you do or need, your experience, and when you are free. At least 20 characters.')),
      h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { for: 'priceType' }, 'Price'), priceType), priceWrap),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'mode' }, 'Where does it happen?'),
        h('select', { id: 'mode', name: 'mode' }, [['campus', 'On campus'], ['online', 'Online'], ['both', 'Campus or online']].map(([val, t]) => h('option', { value: val, selected: v.mode === val }, t)))
      ),
      err,
      h('div', { class: 'row-actions' }, submit, h('a', { class: 'btn', href: l ? `#/listing/${l.id}` : '#/' }, 'Cancel'))
    );
    syncPrice();
    return form;
  }

  /* ------------------------------------------------------------------ */
  /* My listings                                                         */
  /* ------------------------------------------------------------------ */

  async function mineView() {
    const { listings } = await api('/listings/mine');
    const head = h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', null, 'My listings'), h('p', null, `${listings.length} total`)),
      h('a', { class: 'btn btn-primary', href: '#/new' }, 'Post a service')
    );
    if (!listings.length) {
      return h('div', null, head, h('div', { class: 'empty' }, h('h3', null, 'You haven’t posted anything yet'), h('p', null, 'Offer a skill or ask for help. It takes a minute.'), h('a', { class: 'btn btn-primary', href: '#/new' }, 'Post a service')));
    }
    return h(
      'div',
      null,
      head,
      h(
        'div',
        { class: 'rows' },
        listings.map((l) =>
          h(
            'div',
            { class: 'row' },
            h(
              'div',
              { class: 'info' },
              h('a', { href: `#/listing/${l.id}` }, l.title),
              h('div', null, `${kindLabel(l.kind)} · ${l.category} · ${priceLabel(l)} · posted ${timeAgo(l.createdAt)}`)
            ),
            h('div', { class: 'row-actions' }, h('span', { class: 'tag' + (l.status === 'closed' ? ' closed' : '') }, l.status === 'closed' ? 'Closed' : 'Active'), h('a', { class: 'btn btn-sm', href: `#/edit/${l.id}` }, 'Edit'))
          )
        )
      )
    );
  }

  /* ------------------------------------------------------------------ */
  /* Messages                                                            */
  /* ------------------------------------------------------------------ */

  async function inboxView(listingId, userId) {
    const wrapEl = h('div', { class: 'inbox' + (listingId ? ' has-thread' : '') });
    const listPane = h('aside', { class: 'threads', 'aria-label': 'Conversations' });
    const threadPane = h('section', { class: 'thread' });
    wrapEl.append(listPane, threadPane);

    let msgBox = null; // container for bubbles, kept between polls so typed text isn't lost
    let lastSignature = '';

    function renderList(threads) {
      listPane.replaceChildren(
        threads.length
          ? threads.map((t) => {
              const active = String(t.listingId) === listingId && String(t.other.id) === userId;
              return h(
                'a',
                {
                  class: 'thread-item' + (t.unread ? ' unread' : ''),
                  href: `#/inbox/${t.listingId}/${t.other.id}`,
                  'aria-current': active ? 'true' : null,
                },
                h('div', { class: 'top' }, h('b', null, t.other.name), h('time', null, timeAgo(t.lastMessage.createdAt))),
                h('div', { class: 'about' }, t.listingTitle),
                h('div', { class: 'last' }, t.unread > 0 && h('span', { class: 'dot', title: 'Unread' }), (t.lastMessage.mine ? 'You: ' : '') + t.lastMessage.body)
              );
            })
          : h('div', { class: 'placeholder' }, 'No conversations yet. Message someone from a listing to start.')
      );
    }

    async function loadList() {
      const { threads } = await api('/messages/threads');
      renderList(threads);
    }

    function updateMessages(messages) {
      const sig = messages.map((m) => m.id).join(',');
      if (sig === lastSignature) return;
      lastSignature = sig;
      const nearBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 80;
      msgBox.replaceChildren(
        messages.length
          ? messages.map((m) => h('div', { class: 'bubble ' + (m.mine ? 'mine' : 'theirs') }, m.body, h('time', null, timeAgo(m.createdAt))))
          : h('div', { class: 'placeholder' }, 'No messages yet.')
      );
      if (nearBottom || messages.length) msgBox.scrollTop = msgBox.scrollHeight;
    }

    async function loadThread(first) {
      const data = await api(`/messages/thread?listingId=${encodeURIComponent(listingId)}&userId=${encodeURIComponent(userId)}`);
      if (first) buildThread(data);
      updateMessages(data.messages);
      refreshUnread();
    }

    function buildThread(data) {
      msgBox = h('div', { class: 'msgs', 'aria-live': 'polite' });
      const ta = h('textarea', { rows: 1, maxlength: 1000, placeholder: 'Write a message', 'aria-label': 'Message' });
      const err = h('p', { class: 'msg error', role: 'alert', style: { margin: '0 14px 8px' } });
      const send = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send');
      const closed = data.listing.status === 'closed' && data.listing.ownerId !== me.id;
      const form = h(
        'form',
        {
          class: 'compose',
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            const body = ta.value.trim();
            if (!body) return;
            err.textContent = '';
            send.disabled = true;
            try {
              await api('/messages', { method: 'POST', body: { listingId: Number(listingId), toUserId: Number(userId), body } });
              ta.value = '';
              await loadThread(false);
              await loadList();
            } catch (ex) {
              err.textContent = ex.message;
            } finally {
              send.disabled = false;
              ta.focus();
            }
          },
        },
        ta,
        send
      );
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
      threadPane.replaceChildren(
        h(
          'div',
          { class: 'thread-head' },
          h('a', { class: 'back-mobile', href: '#/inbox' }, 'All conversations'),
          h('b', null, `${data.other.name} · ${data.other.university}`),
          h('a', { href: `#/listing/${data.listing.id}` }, data.listing.title)
        ),
        msgBox,
        closed ? h('div', { class: 'banner', style: { margin: '12px' } }, 'This listing is closed. You can’t send new messages.') : [err, form]
      );
    }

    if (listingId && userId) {
      await Promise.all([loadList(), loadThread(true)]);
    } else {
      await loadList();
      threadPane.replaceChildren(h('div', { class: 'placeholder' }, 'Select a conversation to read it.'));
    }

    const timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        await loadList();
        if (listingId && userId) await loadThread(false);
      } catch (_) {
        /* ignore polling errors */
      }
    }, 10000);
    cleanup = () => clearInterval(timer);

    return h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'Messages')), wrapEl);
  }

  /* ------------------------------------------------------------------ */
  /* Router                                                              */
  /* ------------------------------------------------------------------ */

  async function route() {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    const mine = ++navId;
    const hash = location.hash || '#/';
    const [pathPart, qs = ''] = hash.slice(1).split('?');
    const params = new URLSearchParams(qs);
    const parts = pathPart.split('/').filter(Boolean);

    if (parts.length !== 0) $('#searchInput').value = '';
    app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));

    let node;
    try {
      if (parts.length === 0) node = await browseView(params);
      else if (parts[0] === 'listing' && parts[1]) node = await detailView(parts[1]);
      else if (parts[0] === 'new') node = await formView();
      else if (parts[0] === 'edit' && parts[1]) node = await formView(parts[1]);
      else if (parts[0] === 'mine') node = await mineView();
      else if (parts[0] === 'inbox') node = await inboxView(parts[1], parts[2]);
      else node = errorBox('That page does not exist.');
    } catch (ex) {
      node = errorBox(ex.message);
    }
    if (mine !== navId) {
      // The person navigated elsewhere while this page was loading.
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      return;
    }
    app.replaceChildren(node);
    window.scrollTo(0, 0);
    document.title = 'CampusGigs';
  }

  /* ------------------------------------------------------------------ */
  /* Header: search, unread badge, account menu                          */
  /* ------------------------------------------------------------------ */

  async function refreshUnread() {
    try {
      const { unread } = await api('/messages/unread-count');
      const badge = $('#unreadBadge');
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? '99+' : String(unread);
    } catch (_) {
      /* ignore */
    }
  }

  function setupHeader() {
    $('#menuBtn').textContent = initials(me.name);
    $('#menuName').textContent = me.name;
    $('#menuUni').textContent = me.university;

    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#searchInput').value.trim();
      location.hash = '#/' + (q ? '?q=' + encodeURIComponent(q) : '');
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
      const [meRes, metaRes] = await Promise.all([api('/auth/me'), api('/meta')]);
      me = meRes.user;
      meta = metaRes;
    } catch (_) {
      return; // api() already redirected to the login page on 401
    }
    setupHeader();
    refreshUnread();
    setInterval(refreshUnread, 30000);
    window.addEventListener('hashchange', route);
    route();
  })();
})();
