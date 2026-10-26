import {
  h, api, state, toast, field, charCounter, showFieldErrors, imageToJpegBlob, photoUrl, conditionLabel, setSection,
} from './core.js';

const PRICE_MAX = 1000000;

/* ------------------------------------------------------------------ */
/* Photo uploader (Marketplace items)                                   */
/* ------------------------------------------------------------------ */

function photoUploader(existingIds, max) {
  // Each entry: { key, id, url, status: 'uploading' | 'done' | 'error', error, local }
  let photos = existingIds.map((id) => ({ key: id, id, url: photoUrl(id), status: 'done', local: false }));
  let counter = 0;
  const grid = h('div', { class: 'photo-grid' });
  const errBox = h('div', { class: 'field-error', 'data-error-for': 'images', role: 'alert' });
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-label': 'Choose photos' });

  const dropzone = h(
    'div',
    { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Add photos' },
    h('span', null, h('b', null, 'Add photos'), ' or drop them here'),
    h('span', { class: 'hint', style: { margin: 0 } }, `Up to ${max}. The first photo is the cover.`)
  );

  function render() {
    grid.replaceChildren(
      photos.map((p, i) =>
        h(
          'div',
          { class: 'photo' },
          h('img', { src: p.url, alt: `Photo ${i + 1}` }),
          i === 0 && p.status === 'done' && h('span', { class: 'cover-tag' }, 'Cover'),
          i !== 0 && p.status === 'done' && h('button', { type: 'button', class: 'make-cover', onclick: () => makeCover(p.key) }, 'Make cover'),
          h('div', { class: 'photo-actions' }, h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove photo ${i + 1}`, onclick: () => remove(p.key) }, '×')),
          p.status === 'uploading' && h('div', { class: 'state' }, 'Uploading…'),
          p.status === 'error' && h('div', { class: 'state err' }, p.error)
        )
      )
    );
    dropzone.hidden = photos.length >= max;
  }

  function remove(key) {
    const p = photos.find((x) => x.key === key);
    if (p && p.local) URL.revokeObjectURL(p.url);
    photos = photos.filter((x) => x.key !== key);
    render();
  }

  function makeCover(key) {
    const p = photos.find((x) => x.key === key);
    photos = [p, ...photos.filter((x) => x.key !== key)];
    render();
  }

  async function addFiles(fileList) {
    errBox.textContent = '';
    const room = max - photos.length;
    const files = [...fileList].slice(0, Math.max(0, room));
    if (fileList.length > room) toast(`You can add up to ${max} photos.`);
    await Promise.all(
      files.map(async (file) => {
        const entry = { key: 'new-' + ++counter, id: null, url: '', status: 'uploading', local: true };
        photos.push(entry);
        try {
          const blob = await imageToJpegBlob(file);
          entry.url = URL.createObjectURL(blob);
          render();
          const res = await api('/uploads', { method: 'POST', body: blob });
          entry.id = res.id;
          entry.status = 'done';
        } catch (ex) {
          entry.status = 'error';
          entry.error = ex.message;
          setTimeout(() => remove(entry.key), 3500);
        }
        render();
      })
    );
  }

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    addFiles(e.dataTransfer.files);
  });

  render();
  return {
    node: h('div', { class: 'field' }, h('label', null, 'Photos'), dropzone, input, grid, errBox),
    ids: () => photos.filter((p) => p.status === 'done').map((p) => p.id),
    busy: () => photos.some((p) => p.status === 'uploading'),
  };
}

const submitLabel = (l, noun) => (l ? 'Save changes' : `Post ${noun}`);

/* ------------------------------------------------------------------ */
/* Service form                                                         */
/* ------------------------------------------------------------------ */

export async function serviceForm(existing) {
  setSection('services');
  const l = existing || null;
  const v = l || { kind: 'offer', title: '', category: '', description: '', priceType: 'fixed', price: '', mode: 'both' };

  const formError = h('div', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel(l, 'service'));

  const titleIn = h('input', { id: 'title', name: 'title', type: 'text', maxlength: 100, value: v.title });
  const descIn = h('textarea', { id: 'description', name: 'description', rows: 7, maxlength: 2000 }, v.description);

  // Services: amount needed for fixed and hourly, hidden for negotiable and free
  const priceInput = h('input', { id: 'price', name: 'price', type: 'number', min: 1, step: 1, inputmode: 'numeric', value: v.price ?? '' });
  const priceField = field({ name: 'price', label: 'Amount (₹)', control: priceInput });
  const typeSel = h(
    'select',
    { id: 'priceType', name: 'priceType', onchange: syncPrice },
    [['fixed', 'Fixed price'], ['hourly', 'Per hour'], ['negotiable', 'Negotiable'], ['free', 'Free']].map(([val, t]) =>
      h('option', { value: val, selected: v.priceType === val }, t)
    )
  );
  function syncPrice() {
    priceField.hidden = !['fixed', 'hourly'].includes(typeSel.value);
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
        formError.textContent = '';
        const fd = new FormData(form);
        const errors = {};
        const title = String(fd.get('title')).trim();
        const description = String(fd.get('description')).trim();
        if (title.length < 5) errors.title = 'Give it a title of at least 5 characters.';
        if (!fd.get('category')) errors.category = 'Choose a category.';
        if (description.length < 20) errors.description = `Add a bit more detail (${description.length} / 20 characters minimum).`;
        if (!priceField.hidden) {
          const n = Number(fd.get('price'));
          if (!Number.isInteger(n) || n < 1 || n > PRICE_MAX) errors.price = 'Enter a whole number of rupees, 1 or more.';
        }
        if (!showFieldErrors(form, errors)) return;

        submit.disabled = true;
        submit.textContent = 'Saving…';
        const body = {
          section: 'service',
          kind: fd.get('kind'),
          title,
          category: fd.get('category'),
          description,
          priceType: fd.get('priceType'),
          price: priceField.hidden ? null : fd.get('price'),
          mode: fd.get('mode'),
        };
        try {
          const res = l ? await api('/listings/' + l.id, { method: 'PUT', body }) : await api('/listings', { method: 'POST', body });
          toast(l ? 'Changes saved' : 'Service posted');
          location.hash = '#/listing/' + res.id;
        } catch (ex) {
          formError.textContent = ex.message;
          submit.disabled = false;
          submit.textContent = submitLabel(l, 'service');
        }
      },
    },
    h('h1', null, l ? 'Edit your listing' : 'Post a service'),
    h('p', { class: 'sub' }, 'Offer a skill or ask for help. Students will message you to sort out the details.'),
    h(
      'div',
      { class: 'field' },
      h('label', null, 'What are you posting?'),
      h('div', { class: 'radio-row' }, radio('offer', 'I’m offering a service', 'Tutoring, design, coding…'), radio('request', 'I’m looking for help', 'Someone to do or teach something'))
    ),
    field({ name: 'title', label: 'Title', control: titleIn, counter: charCounter(titleIn, 100), hint: 'Example: “Calculus tutoring for first years”' }),
    field({
      name: 'category',
      label: 'Category',
      control: h('select', { id: 'category', name: 'category' }, h('option', { value: '' }, 'Choose a category'), state.meta.serviceCategories.map((c) => h('option', { value: c, selected: v.category === c }, c))),
    }),
    field({ name: 'description', label: 'Description', control: descIn, counter: charCounter(descIn, 2000), hint: 'What you do or need, your experience, and when you are free.' }),
    h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { for: 'priceType' }, 'Price'), typeSel), priceField),
    field({
      name: 'mode',
      label: 'Where does it happen?',
      control: h('select', { id: 'mode', name: 'mode' }, [['campus', 'On campus'], ['online', 'Online'], ['both', 'Campus or online']].map(([val, t]) => h('option', { value: val, selected: v.mode === val }, t))),
    }),
    formError,
    h('div', { class: 'form-actions' }, submit, h('a', { class: 'btn', href: l ? `#/listing/${l.id}` : '#/services' }, 'Cancel'))
  );
  syncPrice();
  document.title = (l ? 'Edit listing' : 'Post a service') + ' · CampusGigs';
  return form;
}

/* ------------------------------------------------------------------ */
/* Item form (Marketplace)                                              */
/* ------------------------------------------------------------------ */

export async function itemForm(existing) {
  setSection('market');
  const l = existing || null;

  // Selling needs a verified college ID
  if (!state.me.idVerified) {
    return h(
      'div',
      { class: 'panel form-card' },
      h('h1', null, 'Verify your college ID to sell'),
      h('p', { class: 'sub' }, 'The Marketplace is for verified students only, so buyers know who they are dealing with. It takes about a minute and you only do it once.'),
      h('div', { class: 'form-actions' }, h('a', { class: 'btn btn-market', href: '#/verify' }, 'Verify college ID'), h('a', { class: 'btn', href: '#/market' }, 'Back to marketplace'))
    );
  }

  const v = l || { title: '', category: '', condition: '', description: '', priceType: 'fixed', price: '', location: '' };
  const uploader = photoUploader(l && l.images ? l.images : [], state.meta.maxImages);

  const formError = h('div', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-market', type: 'submit' }, submitLabel(l, 'item'));

  const titleIn = h('input', { id: 'title', name: 'title', type: 'text', maxlength: 100, value: v.title });
  const descIn = h('textarea', { id: 'description', name: 'description', rows: 6, maxlength: 2000 }, v.description);
  const locIn = h('input', { id: 'location', name: 'location', type: 'text', maxlength: 80, value: v.location || '' });

  const priceInput = h('input', { id: 'price', name: 'price', type: 'number', min: 1, step: 1, inputmode: 'numeric', value: v.price ?? '' });
  const priceField = field({ name: 'price', label: 'Asking price (₹)', control: priceInput });
  const typeSel = h(
    'select',
    { id: 'priceType', name: 'priceType', onchange: syncPrice },
    [['fixed', 'Fixed price'], ['negotiable', 'Open to offers'], ['free', 'Giving it away free']].map(([val, t]) =>
      h('option', { value: val, selected: v.priceType === val }, t)
    )
  );
  function syncPrice() {
    priceField.hidden = typeSel.value === 'free';
  }

  const form = h(
    'form',
    {
      class: 'panel form-card',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        formError.textContent = '';
        const fd = new FormData(form);
        const errors = {};
        const title = String(fd.get('title')).trim();
        const description = String(fd.get('description')).trim();
        const pickup = String(fd.get('location')).trim();
        if (uploader.busy()) errors.images = 'Wait for the photos to finish uploading.';
        else if (uploader.ids().length < 1) errors.images = 'Add at least one photo so buyers can see the item.';
        if (title.length < 5) errors.title = 'Give it a title of at least 5 characters.';
        if (!fd.get('category')) errors.category = 'Choose a category.';
        if (!fd.get('condition')) errors.condition = 'Choose the condition.';
        if (!priceField.hidden) {
          const n = Number(fd.get('price'));
          if (!Number.isInteger(n) || n < 1 || n > PRICE_MAX) errors.price = 'Enter a whole number of rupees, 1 or more.';
        }
        if (pickup.length < 2) errors.location = 'Tell buyers where to pick it up.';
        if (description.length < 20) errors.description = `Add a bit more detail (${description.length} / 20 characters minimum).`;
        if (!showFieldErrors(form, errors)) return;

        submit.disabled = true;
        submit.textContent = 'Saving…';
        const body = {
          section: 'item',
          title,
          category: fd.get('category'),
          condition: fd.get('condition'),
          description,
          priceType: fd.get('priceType'),
          price: priceField.hidden ? null : fd.get('price'),
          location: pickup,
          images: uploader.ids(),
        };
        try {
          const res = l ? await api('/listings/' + l.id, { method: 'PUT', body }) : await api('/listings', { method: 'POST', body });
          toast(l ? 'Changes saved' : 'Item listed');
          location.hash = '#/listing/' + res.id;
        } catch (ex) {
          if (ex.data && ex.data.needsIdVerification) {
            location.hash = '#/verify';
            return;
          }
          formError.textContent = ex.message;
          submit.disabled = false;
          submit.textContent = submitLabel(l, 'item');
        }
      },
    },
    h('h1', null, l ? 'Edit your item' : 'Sell an item'),
    h('p', { class: 'sub' }, 'Good photos and an honest description sell things fastest.'),
    uploader.node,
    field({ name: 'title', label: 'Title', control: titleIn, counter: charCounter(titleIn, 100), hint: 'Example: “Engineering Mathematics, 3rd edition”' }),
    h(
      'div',
      { class: 'two' },
      field({
        name: 'category',
        label: 'Category',
        control: h('select', { id: 'category', name: 'category' }, h('option', { value: '' }, 'Choose a category'), state.meta.itemCategories.map((c) => h('option', { value: c, selected: v.category === c }, c))),
      }),
      field({
        name: 'condition',
        label: 'Condition',
        control: h('select', { id: 'condition', name: 'condition' }, h('option', { value: '' }, 'Choose condition'), state.meta.conditions.map((c) => h('option', { value: c, selected: v.condition === c }, conditionLabel(c)))),
      })
    ),
    h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { for: 'priceType' }, 'Price'), typeSel), priceField),
    field({ name: 'location', label: 'Pickup spot', control: locIn, hint: 'Somewhere public on campus, like “Library entrance” or “Hostel 3 gate”.' }),
    field({ name: 'description', label: 'Description', control: descIn, counter: charCounter(descIn, 2000), hint: 'Age, any damage, what is included, why you are selling.' }),
    formError,
    h('div', { class: 'form-actions' }, submit, h('a', { class: 'btn', href: l ? `#/listing/${l.id}` : '#/market' }, 'Cancel'))
  );
  syncPrice();
  document.title = (l ? 'Edit item' : 'Sell an item') + ' · CampusGigs';
  return form;
}

/** Loads a listing and shows the right edit form. */
export async function editView(id) {
  const { listing } = await api('/listings/' + encodeURIComponent(id));
  if (!listing.isOwner) throw new Error('You can only edit your own listings.');
  return listing.section === 'item' ? itemForm(listing) : serviceForm(listing);
}
