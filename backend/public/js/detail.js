import {
  h, api, state, toast, timeAgo, priceLabel, kindLabel, modeLabel, conditionLabel, firstName, initials, photoUrl,
  verifiedBadge, confirmDialog, setSection,
} from './core.js';

function gallery(images, title) {
  if (!images.length) return null;
  const main = h('img', { class: 'gallery-main', src: photoUrl(images[0]), alt: title });
  const thumbs = images.map((id, i) =>
    h(
      'button',
      {
        type: 'button',
        class: 'thumb-btn',
        'aria-label': `Show photo ${i + 1} of ${images.length}`,
        'aria-pressed': String(i === 0),
        onclick: () => {
          main.src = photoUrl(id);
          thumbs.forEach((t, j) => t.setAttribute('aria-pressed', String(i === j)));
        },
      },
      h('img', { src: photoUrl(id), alt: '' })
    )
  );
  return h('div', { class: 'gallery' }, h('div', { class: 'gallery-stage' }, main), images.length > 1 && h('div', { class: 'thumbs' }, thumbs));
}

function ownerPanel(l, reload) {
  const isItem = l.section === 'item';
  const setStatus = async (status) => {
    try {
      await api(`/listings/${l.id}/status`, { method: 'PATCH', body: { status } });
      toast(status === 'closed' ? (isItem ? 'Marked as sold' : 'Listing closed') : 'Listing is live again');
      reload();
    } catch (err) {
      toast(err.message);
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: 'Delete this listing?',
      message: 'The listing, its photos and its messages will be removed for good.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/listings/' + l.id, { method: 'DELETE' });
      toast('Listing deleted');
      location.hash = '#/mine';
    } catch (err) {
      toast(err.message);
    }
  };

  return h(
    'div',
    { class: 'panel' },
    h('b', null, 'This is your listing'),
    h('p', { class: 'hint', style: { 'margin-bottom': '14px' } }, 'Messages from interested students show up in your inbox.'),
    h(
      'div',
      { class: 'actions' },
      h('a', { class: 'btn btn-primary', href: '#/inbox' }, 'Open messages'),
      h('a', { class: 'btn', href: `#/edit/${l.id}` }, 'Edit listing'),
      l.status === 'active'
        ? h('button', { class: 'btn', type: 'button', onclick: () => setStatus('closed') }, isItem ? 'Mark as sold' : 'Close listing')
        : h('button', { class: 'btn', type: 'button', onclick: () => setStatus('active') }, isItem ? 'Relist item' : 'Reopen listing'),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: remove }, 'Delete listing')
    )
  );
}

function contactPanel(l, person) {
  const isItem = l.section === 'item';
  const seller = firstName(l.seller.name);

  // Marketplace: messaging needs a verified college ID
  if (isItem && !state.me.idVerified) {
    return h(
      'div',
      { class: 'panel' },
      person,
      h('b', null, 'Verify your college ID to message the seller'),
      h('p', { class: 'hint', style: { margin: '6px 0 14px' } }, 'The Marketplace is for verified students only. It takes a minute and you only do it once.'),
      h('a', { class: 'btn btn-market btn-block', href: '#/verify' }, 'Verify college ID')
    );
  }

  const ta = h('textarea', {
    id: 'msgBody',
    name: 'msgBody',
    rows: 5,
    maxlength: 1000,
    required: true,
    placeholder: isItem
      ? 'Hi! Is this still available? Can I see it today?'
      : l.kind === 'offer'
      ? 'Hi! I’m interested in your service. Are you free this week?'
      : 'Hi! I can help with this. Here’s what I’ve done before…',
  });
  const err = h('p', { class: 'msg error', role: 'alert' });
  const btn = h('button', { class: 'btn btn-block ' + (isItem ? 'btn-market' : 'btn-primary'), type: 'submit' }, 'Send message');
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
          ta.focus();
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          await api('/messages', { method: 'POST', body: { listingId: l.id, body } });
          box.replaceChildren(
            person,
            h('p', { class: 'sent' }, '✓ Message sent'),
            h('p', { class: 'hint', style: { 'margin-bottom': '14px' } }, `${seller} will get an email. Replies appear in your messages.`),
            h('a', { class: 'btn btn-block', href: `#/inbox/${l.id}/${l.seller.id}` }, 'View conversation')
          );
        } catch (ex) {
          if (ex.data && ex.data.needsIdVerification) {
            location.hash = '#/verify';
            return;
          }
          err.textContent = ex.message;
          btn.disabled = false;
          btn.textContent = 'Send message';
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'msgBody' }, `Message ${seller}`), ta),
    err,
    btn
  );
  box.append(person, form);
  return box;
}

export async function detailView(id, reload) {
  const { listing: l } = await api('/listings/' + encodeURIComponent(id));
  const isItem = l.section === 'item';
  setSection(isItem ? 'market' : 'services');
  document.title = `${l.title} · CampusGigs`;

  const person = h(
    'div',
    { class: 'person' },
    h('span', { class: 'avatar lg', 'aria-hidden': 'true' }, initials(l.seller.name)),
    h('div', null, h('b', null, l.seller.name), h('span', null, l.seller.university), l.seller.verified && verifiedBadge())
  );

  const side = h('div', { class: 'aside-stack' });
  if (l.isOwner) {
    side.append(ownerPanel(l, reload));
  } else if (l.status === 'closed') {
    side.append(h('div', { class: 'panel' }, person, h('div', { class: 'banner', style: { margin: 0 } }, isItem ? 'This item has been sold.' : 'This listing is closed and not taking messages.')));
  } else {
    side.append(contactPanel(l, person));
    if (isItem) {
      side.append(h('p', { class: 'safety' }, 'Stay safe: meet in a busy spot on campus, check the item before you pay, and never send money in advance.'));
    }
  }

  const facts = isItem
    ? h(
        'dl',
        { class: 'facts' },
        h('div', null, h('dt', null, 'Condition'), h('dd', null, conditionLabel(l.condition))),
        h('div', null, h('dt', null, 'Category'), h('dd', null, l.category)),
        h('div', null, h('dt', null, 'Pickup'), h('dd', null, l.location))
      )
    : null;

  const back = isItem ? '#/market' : '#/services';
  const shareBtn = h(
    'button',
    {
      class: 'btn btn-sm',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(location.href);
          toast('Link copied');
        } catch (_) {
          toast('Copy the link from the address bar');
        }
      },
    },
    'Copy link'
  );

  return h(
    'div',
    null,
    h('a', { class: 'back', href: back }, isItem ? 'Back to marketplace' : 'Back to services'),
    h(
      'div',
      { class: 'detail' },
      h(
        'article',
        { class: 'panel' },
        l.images && gallery(l.images, l.title),
        l.status === 'closed' && h('div', { class: 'banner' }, isItem ? 'This item has been sold.' : 'This listing is closed.'),
        h(
          'div',
          { class: 'tags' },
          isItem ? h('span', { class: 'tag market' }, 'For sale') : h('span', { class: 'tag' + (l.kind === 'request' ? ' request' : '') }, kindLabel(l.kind)),
          !isItem && h('span', { class: 'tag plain' }, l.category),
          !isItem && h('span', { class: 'tag plain' }, modeLabel(l.mode))
        ),
        h('h1', null, l.title),
        h('p', { class: 'meta' }, `Posted ${timeAgo(l.createdAt)}`),
        h('div', { class: 'big-price' }, priceLabel(l)),
        facts,
        h('div', { class: 'body' }, l.description),
        h('div', { style: { 'margin-top': '22px' } }, shareBtn)
      ),
      side
    )
  );
}
