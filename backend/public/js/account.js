import {
  h, api, state, toast, timeAgo, priceLabel, kindLabel, conditionLabel, photoUrl, emptyState, confirmDialog, promptDialog,
  showFieldErrors, field, imageToJpegBlob, setSection,
} from './core.js';

/* ------------------------------------------------------------------ */
/* My listings                                                          */
/* ------------------------------------------------------------------ */

export async function mineView(reload) {
  setSection(null);
  const { listings } = await api('/listings/mine');
  const head = h(
    'div',
    { class: 'page-head' },
    h('div', null, h('h1', null, 'My listings'), h('p', null, `${listings.length} total`)),
    h('div', { class: 'row-actions' }, h('a', { class: 'btn btn-primary btn-sm', href: '#/new/service' }, 'Post a service'), h('a', { class: 'btn btn-market btn-sm', href: '#/new/item' }, 'Sell an item'))
  );
  if (!listings.length) {
    return h('div', null, head, emptyState({ title: 'You haven’t posted anything yet', text: 'Offer a skill or sell something you no longer need. It takes a minute.', actionText: 'Post a service', href: '#/new/service' }));
  }

  const toggle = async (l) => {
    try {
      await api(`/listings/${l.id}/status`, { method: 'PATCH', body: { status: l.status === 'active' ? 'closed' : 'active' } });
      toast('Updated');
      reload();
    } catch (err) {
      toast(err.message);
    }
  };

  return h(
    'div',
    null,
    head,
    h(
      'div',
      { class: 'rows' },
      listings.map((l) => {
        const isItem = l.section === 'item';
        const closedWord = isItem ? 'Sold' : 'Closed';
        return h(
          'div',
          { class: 'row' },
          h(
            'div',
            { class: 'row-main' },
            isItem
              ? h('div', { class: 'row-thumb' }, l.cover && h('img', { src: photoUrl(l.cover), alt: '' }))
              : h('div', { class: 'row-thumb service' }, 'Service'),
            h(
              'div',
              { class: 'info' },
              h('a', { href: `#/listing/${l.id}` }, l.title),
              h('div', null, `${isItem ? 'Marketplace' : kindLabel(l.kind)} · ${l.category} · ${priceLabel(l)}${isItem ? ' · ' + conditionLabel(l.condition) : ''}`),
              h('div', null, `Posted ${timeAgo(l.createdAt)}`)
            )
          ),
          h(
            'div',
            { class: 'row-actions' },
            h('span', { class: 'tag' + (l.status === 'closed' ? ' closed' : ' ok') }, l.status === 'closed' ? closedWord : 'Active'),
            h('a', { class: 'btn btn-sm', href: `#/edit/${l.id}` }, 'Edit'),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => toggle(l) }, l.status === 'active' ? (isItem ? 'Mark sold' : 'Close') : isItem ? 'Relist' : 'Reopen')
          )
        );
      })
    )
  );
}

/* ------------------------------------------------------------------ */
/* College ID verification (student side)                               */
/* ------------------------------------------------------------------ */

export async function verifyView(reload) {
  setSection(null);
  const s = await api('/verification');
  if (s.idVerified) state.me.idVerified = true;

  const wrapper = (...kids) => h('div', { class: 'verify-wrap' }, h('a', { class: 'back', href: '#/market' }, 'Back to marketplace'), ...kids);

  if (s.status === 'approved') {
    return wrapper(
      h(
        'div',
        { class: 'panel status-card' },
        h('div', { class: 'status-icon ok' }, '✓'),
        h('h2', null, 'You’re verified'),
        h('p', null, 'Your college ID is confirmed. You can now sell items and message sellers in the Marketplace.'),
        h('div', { class: 'form-actions', style: { 'justify-content': 'center' } }, h('a', { class: 'btn btn-market', href: '#/market' }, 'Open marketplace'), h('a', { class: 'btn', href: '#/new/item' }, 'Sell an item'))
      )
    );
  }

  if (s.status === 'pending') {
    return wrapper(
      h(
        'div',
        { class: 'panel status-card' },
        h('div', { class: 'status-icon wait' }, '…'),
        h('h2', null, 'Your ID is being reviewed'),
        h('p', null, `We received your details for ${s.college} (ID ${s.idNumber}). You’ll get an email as soon as a reviewer has checked it. Until then you can still browse.`),
        h('a', { class: 'btn', href: '#/market' }, 'Browse the marketplace')
      )
    );
  }

  // 'none' or 'rejected': show the form
  let photoBlob = null;
  const formError = h('div', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-market', type: 'submit' }, 'Submit for review');
  const preview = h('img', { class: 'id-preview', alt: 'Preview of your ID card', hidden: true });

  const collegeIn = h('input', { id: 'college', name: 'college', type: 'text', maxlength: 100, autocomplete: 'organization', value: s.college || '' });
  const idIn = h('input', { id: 'idNumber', name: 'idNumber', type: 'text', maxlength: 30, autocomplete: 'off' });
  const fileIn = h('input', {
    id: 'idPhoto',
    name: 'idPhoto',
    type: 'file',
    accept: 'image/*',
    onchange: async () => {
      const f = fileIn.files[0];
      photoBlob = null;
      preview.hidden = true;
      if (!f) return;
      try {
        photoBlob = await imageToJpegBlob(f, 1600, 0.85);
        preview.src = URL.createObjectURL(photoBlob);
        preview.hidden = false;
      } catch (ex) {
        showFieldErrors(form, { idPhoto: ex.message });
      }
    },
  });
  const consent = h('input', { type: 'checkbox', name: 'consent', id: 'consent' });

  const form = h(
    'form',
    {
      class: 'panel',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        formError.textContent = '';
        const errors = {};
        if (collegeIn.value.trim().length < 2) errors.college = 'Enter your college or university name.';
        if (idIn.value.trim().length < 4) errors.idNumber = 'Enter the ID or enrollment number printed on your card.';
        if (!photoBlob) errors.idPhoto = 'Add a clear photo of your college ID card.';
        if (!consent.checked) errors.consent = 'Please confirm this is your own ID.';
        if (!showFieldErrors(form, errors)) return;

        submit.disabled = true;
        submit.textContent = 'Submitting…';
        try {
          await api('/verification/photo', { method: 'POST', body: photoBlob });
          await api('/verification', { method: 'POST', body: { college: collegeIn.value.trim(), idNumber: idIn.value.trim() } });
          toast('Submitted for review');
          reload();
        } catch (ex) {
          formError.textContent = ex.message;
          submit.disabled = false;
          submit.textContent = 'Submit for review';
        }
      },
    },
    h('h1', { style: { 'font-size': '1.6rem', 'margin-bottom': '6px' } }, 'Verify your college ID'),
    h('p', { class: 'sub', style: { color: 'var(--ink-soft)', 'margin-bottom': '18px' } }, 'The Marketplace is for verified students only. A reviewer checks that the name and college on your ID card are real. You only do this once.'),
    s.status === 'rejected' && h('div', { class: 'callout warn' }, h('div', null, h('b', null, 'Your last request was not approved'), h('p', null, s.note || 'Please check your details and try again.'))),
    field({ name: 'college', label: 'College or university', control: collegeIn }),
    field({ name: 'idNumber', label: 'ID or enrollment number', control: idIn, hint: 'As printed on your card. One ID can only be linked to one account.' }),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'idPhoto' }, 'Photo of your college ID card'),
      fileIn,
      h('div', { class: 'hint' }, 'Front side, all four corners visible, text readable. Your name must match your account.'),
      preview,
      h('div', { class: 'field-error', 'data-error-for': 'idPhoto', role: 'alert' })
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'consent', for: 'consent' }, consent, 'This is my own college ID. I understand the photo is only seen by a reviewer and is deleted once the review is done.'),
      h('div', { class: 'field-error', 'data-error-for': 'consent', role: 'alert' })
    ),
    formError,
    h('div', { class: 'form-actions' }, submit, h('a', { class: 'btn', href: '#/market' }, 'Not now'))
  );
  return wrapper(form);
}

/* ------------------------------------------------------------------ */
/* Admin: review ID verification requests                               */
/* ------------------------------------------------------------------ */

export async function adminView(reload) {
  setSection(null);
  if (!state.me.isAdmin) throw new Error('This page is for administrators only.');
  const { requests } = await api('/admin/verifications');

  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'ID verification requests'), h('p', null, `${requests.length} waiting for review`)));
  if (!requests.length) {
    return h('div', null, head, emptyState({ title: 'All caught up', text: 'There are no ID verification requests waiting for review.' }));
  }

  const decide = async (r, decision, note) => {
    try {
      await api(`/admin/verifications/${r.userId}/decision`, { method: 'POST', body: { decision, note } });
      toast(decision === 'approve' ? `${r.name} approved` : `${r.name} rejected`);
      reload();
    } catch (err) {
      toast(err.message);
    }
  };

  const approve = async (r) => {
    const ok = await confirmDialog({
      title: `Approve ${r.name}?`,
      message: 'Only approve if the name and college on the card match this account and the card looks genuine.',
      confirmText: 'Approve',
    });
    if (ok) decide(r, 'approve');
  };
  const reject = async (r) => {
    const reason = await promptDialog({
      title: `Reject ${r.name}?`,
      message: 'Tell the student what to fix. They will see this reason.',
      label: 'Reason',
      confirmText: 'Reject',
    });
    if (reason) decide(r, 'reject', reason);
  };

  return h(
    'div',
    null,
    head,
    h(
      'div',
      { class: 'req-list' },
      requests.map((r) =>
        h(
          'div',
          { class: 'panel req' },
          h(
            'div',
            null,
            h('h2', { style: { 'font-size': '1.15rem' } }, r.name),
            h(
              'dl',
              null,
              h('dt', null, 'Email'), h('dd', null, r.email),
              h('dt', null, 'Email domain'), h('dd', null, r.university),
              h('dt', null, 'College on form'), h('dd', null, r.college),
              h('dt', null, 'ID number'), h('dd', null, r.idNumber),
              h('dt', null, 'Submitted'), h('dd', null, timeAgo(r.submittedAt))
            ),
            h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-market', type: 'button', onclick: () => approve(r) }, 'Approve'), h('button', { class: 'btn btn-danger', type: 'button', onclick: () => reject(r) }, 'Reject'))
          ),
          h(
            'a',
            { class: 'id-link', href: `/api/admin/verifications/${r.userId}/photo`, target: '_blank', rel: 'noopener', 'aria-label': `Open ID photo of ${r.name} in a new tab` },
            h('img', { src: `/api/admin/verifications/${r.userId}/photo`, alt: `ID card of ${r.name}` })
          )
        )
      )
    )
  );
}
