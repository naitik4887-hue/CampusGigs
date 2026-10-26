import {
  h, api, state, catColor, priceLabel, kindLabel, conditionLabel, firstName, photoUrl, verifiedBadge, emptyState, $,
} from './core.js';

const CONDITIONS = ['new', 'like_new', 'good', 'fair'];

/* ---------- cards ---------- */

export function serviceCard(l) {
  return h(
    'a',
    { class: 'card', href: `#/listing/${l.id}`, style: { '--cat': catColor(l.category, 'service') } },
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

export function itemCard(l) {
  return h(
    'a',
    { class: 'card item-card', href: `#/listing/${l.id}` },
    l.status === 'closed' && h('span', { class: 'sold-ribbon' }, 'Sold'),
    h(
      'div',
      { class: 'thumb' },
      l.cover ? h('img', { src: photoUrl(l.cover), alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-empty' }, 'No photo')
    ),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'price-row' }, h('span', { class: 'price' }, priceLabel(l)), h('span', { class: 'tag market' }, conditionLabel(l.condition))),
      h('h3', null, l.title),
      h('div', { class: 'meta' }, `${l.category} · ${l.location}`),
      h('div', { class: 'seller' }, `${firstName(l.seller.name)}, ${l.seller.university}`, ' ', l.seller.verified && verifiedBadge())
    )
  );
}

/* ---------- browse page (both sections) ---------- */

export async function browseView(section, params) {
  const isItem = section === 'item';
  const base = isItem ? '#/market' : '#/services';
  const f = {
    q: params.get('q') || '',
    category: params.get('category') || '',
    kind: params.get('kind') || '',
    condition: params.get('condition') || '',
    minPrice: params.get('minPrice') || '',
    maxPrice: params.get('maxPrice') || '',
    sort: params.get('sort') || 'new',
    uni: params.get('uni') || '',
    page: Math.max(1, parseInt(params.get('page'), 10) || 1),
  };
  $('#searchInput').value = f.q;

  const qs = new URLSearchParams({ section });
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  const data = await api('/listings?' + qs.toString());

  // Filters live in the URL, so back/forward and sharing links work.
  const go = (changes) => {
    const next = { ...f, page: 1, ...changes };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v === '' || v == null) continue;
      if (k === 'sort' && v === 'new') continue;
      if (k === 'page' && Number(v) === 1) continue;
      p.set(k, v);
    }
    const s = p.toString();
    location.hash = base + (s ? '?' + s : '');
  };

  const categories = isItem ? state.meta.itemCategories : state.meta.serviceCategories;
  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Category' },
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.category === ''), onclick: () => go({ category: '' }) }, 'All categories'),
    categories.map((c) =>
      h(
        'button',
        { type: 'button', class: 'chip', style: { '--cat': catColor(c, section) }, 'aria-pressed': String(f.category === c), onclick: () => go({ category: c }) },
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
    `Only ${state.me.university}`
  );

  // Row 1 differs by section
  let firstRow;
  if (isItem) {
    const condSel = h(
      'select',
      { 'aria-label': 'Condition', onchange: (e) => go({ condition: e.target.value }) },
      h('option', { value: '' }, 'Any condition'),
      CONDITIONS.map((c) => h('option', { value: c, selected: f.condition === c }, conditionLabel(c)))
    );
    const min = h('input', { type: 'number', min: 0, inputmode: 'numeric', placeholder: 'Min', 'aria-label': 'Minimum price', value: f.minPrice });
    const max = h('input', { type: 'number', min: 0, inputmode: 'numeric', placeholder: 'Max', 'aria-label': 'Maximum price', value: f.maxPrice });
    const priceForm = h(
      'form',
      { class: 'price-filter', onsubmit: (e) => { e.preventDefault(); go({ minPrice: min.value.trim(), maxPrice: max.value.trim() }); } },
      '₹', min, h('span', null, 'to'), max,
      h('button', { class: 'btn btn-sm', type: 'submit' }, 'Apply')
    );
    firstRow = h('div', { class: 'filter-row' }, condSel, priceForm, h('div', { class: 'toolbar' }, uniCheck, sortSel));
  } else {
    const seg = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Type' },
      [['', 'All'], ['offer', 'Offering'], ['request', 'Looking for']].map(([val, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(f.kind === val), onclick: () => go({ kind: val }) }, label)
      )
    );
    firstRow = h('div', { class: 'filter-row' }, seg, h('div', { class: 'toolbar' }, uniCheck, sortSel));
  }

  const hasFilters = f.q || f.category || f.kind || f.condition || f.minPrice || f.maxPrice || f.uni;
  const noun = isItem ? 'item' : 'service';

  let results;
  if (data.listings.length) {
    results = h('div', { class: 'grid' }, data.listings.map(isItem ? itemCard : serviceCard));
  } else if (hasFilters) {
    results = emptyState({
      title: `No ${noun}s match those filters`,
      text: 'Try different words or clear a filter.',
      actionText: 'Clear filters',
      href: base,
    });
  } else {
    results = emptyState({
      title: isItem ? 'Nothing is for sale yet' : 'No services posted yet',
      text: isItem ? 'Be the first to list something. Old textbooks, a cycle, hostel gear: someone nearby probably needs it.' : 'Be the first to offer a skill or ask for help.',
      actionText: isItem ? 'Sell an item' : 'Post a service',
      href: isItem ? '#/new/item' : '#/new/service',
    });
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

  const heading = f.q ? `Results for “${f.q}”` : isItem ? 'Buy and sell on campus' : 'Find help from students';
  const count = `${data.total} ${noun}${data.total === 1 ? '' : 's'}${hasFilters ? ' found' : ''}`;

  const banner =
    isItem && !state.me.idVerified
      ? h(
          'div',
          { class: 'callout' },
          h('div', null, h('b', null, 'Verify your college ID to buy or sell'), h('p', null, 'You can browse freely. Messaging sellers and listing items needs a quick one-time ID check.')),
          h('a', { class: 'btn btn-market', href: '#/verify' }, 'Verify now')
        )
      : null;

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, heading), h('p', null, count))),
    banner,
    h('div', { class: 'filters' }, firstRow, chips),
    results,
    pager
  );
}
