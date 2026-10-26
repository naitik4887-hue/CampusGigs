const express = require('express');
const rateLimit = require('express-rate-limit');

/* ------------------------------------------------------------------ */
/* Options (edit these to change what the marketplace offers)          */
/* ------------------------------------------------------------------ */
const CATEGORIES = [
  'Tutoring & Academics',
  'Coding & Tech',
  'Design & Creative',
  'Writing & Editing',
  'Photography & Video',
  'Music & Events',
  'Errands & Delivery',
  'Fitness & Wellness',
  'Other',
];
const KINDS = ['offer', 'request']; // offering a service | looking for a service
const PRICE_TYPES = ['fixed', 'hourly', 'negotiable', 'free'];
const MODES = ['campus', 'online', 'both'];
const MAX_ACTIVE_LISTINGS = 20;
const PAGE_SIZE = 12;

const iso = (s) => (s ? s.replace(' ', 'T') + 'Z' : null); // SQLite UTC -> ISO string
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function registerMarketplace(app, { db, requireAuth, wrap, ApiError, sendMail }) {
  const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  /* ---------------------------------------------------------------- */
  /* Tables                                                            */
  /* ---------------------------------------------------------------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      category    TEXT NOT NULL,
      price_type  TEXT NOT NULL,
      price       INTEGER,
      mode        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'closed'
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_listings_status_created ON listings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id   INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      read_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(listing_id, sender_id, recipient_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, read_at);
  `);

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */
  const LISTING_SELECT = `
    SELECT l.*, u.name AS seller_name, u.university AS seller_university
    FROM listings l JOIN users u ON u.id = l.user_id`;

  function listingJson(r, viewerId) {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      description: r.description,
      category: r.category,
      priceType: r.price_type,
      price: r.price,
      mode: r.mode,
      status: r.status,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      isOwner: r.user_id === viewerId,
      seller: { id: r.user_id, name: r.seller_name, university: r.seller_university },
    };
  }

  function idParam(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ApiError(404, 'Listing not found.');
    return id;
  }

  function parseListing(b) {
    const kind = String(b.kind || '');
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    const category = String(b.category || '');
    const priceType = String(b.priceType || '');
    const mode = String(b.mode || '');

    if (!KINDS.includes(kind)) throw new ApiError(400, 'Choose whether you are offering or looking for a service.');
    if (title.length < 5 || title.length > 100) throw new ApiError(400, 'Title must be 5 to 100 characters.');
    if (!CATEGORIES.includes(category)) throw new ApiError(400, 'Choose a category.');
    if (description.length < 20 || description.length > 2000) {
      throw new ApiError(400, 'Description must be 20 to 2000 characters. Say what you do or need, and when you are free.');
    }
    if (!PRICE_TYPES.includes(priceType)) throw new ApiError(400, 'Choose how the price works.');
    if (!MODES.includes(mode)) throw new ApiError(400, 'Choose where the service happens.');

    let price = null;
    if (priceType === 'fixed' || priceType === 'hourly') {
      price = Number(b.price);
      if (!Number.isInteger(price) || price < 1 || price > 1000000) {
        throw new ApiError(400, 'Enter a price in whole rupees, between 1 and 10,00,000.');
      }
    } else if (priceType === 'free') {
      price = 0;
    }
    return { kind, title, description, category, priceType, price, mode };
  }

  /* ---------------------------------------------------------------- */
  /* Router (everything here requires a logged-in student)             */
  /* ---------------------------------------------------------------- */
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests. Please slow down.' },
    })
  );
  router.use(requireAuth);

  const messageLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => 'user-' + req.user.id,
    message: { message: 'You are sending messages too quickly. Try again in a few minutes.' },
  });

  // Options for the frontend
  router.get('/meta', (req, res) => res.json({ categories: CATEGORIES, maxActiveListings: MAX_ACTIVE_LISTINGS }));

  /* ---------------- Listings ---------------- */

  // Browse + search
  router.get('/listings', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const category = String(req.query.category || '');
    const kind = String(req.query.kind || '');
    const sort = String(req.query.sort || 'new');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const where = ["l.status = 'active'"];
    const params = [];
    if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      where.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (CATEGORIES.includes(category)) {
      where.push('l.category = ?');
      params.push(category);
    }
    if (KINDS.includes(kind)) {
      where.push('l.kind = ?');
      params.push(kind);
    }
    if (req.query.uni === 'mine') {
      where.push('u.university = ?');
      params.push(req.user.university);
    }

    const orderBy =
      sort === 'price_asc'
        ? 'l.price IS NULL, l.price ASC, l.id DESC'
        : sort === 'price_desc'
        ? 'l.price IS NULL, l.price DESC, l.id DESC'
        : 'l.id DESC';

    const whereSql = where.join(' AND ');
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM listings l JOIN users u ON u.id = l.user_id WHERE ${whereSql}`)
      .get(...params).n;
    const rows = db
      .prepare(`${LISTING_SELECT} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

    res.json({
      listings: rows.map((r) => listingJson(r, req.user.id)),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  });

  // The current user's own listings (all statuses). Declared before /listings/:id.
  router.get('/listings/mine', (req, res) => {
    const rows = db.prepare(`${LISTING_SELECT} WHERE l.user_id = ? ORDER BY l.id DESC`).all(req.user.id);
    res.json({ listings: rows.map((r) => listingJson(r, req.user.id)) });
  });

  // One listing
  router.get('/listings/:id', (req, res) => {
    const row = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(idParam(req));
    if (!row) throw new ApiError(404, 'Listing not found.');
    res.json({ listing: listingJson(row, req.user.id) });
  });

  // Create
  router.post('/listings', (req, res) => {
    const active = db.prepare("SELECT COUNT(*) AS n FROM listings WHERE user_id = ? AND status = 'active'").get(req.user.id).n;
    if (active >= MAX_ACTIVE_LISTINGS) {
      throw new ApiError(400, `You can have up to ${MAX_ACTIVE_LISTINGS} active listings. Close one to post another.`);
    }
    const d = parseListing(req.body);
    const info = db
      .prepare(
        `INSERT INTO listings (user_id, kind, title, description, category, price_type, price, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(req.user.id, d.kind, d.title, d.description, d.category, d.priceType, d.price, d.mode);
    res.status(201).json({ id: info.lastInsertRowid });
  });

  // Edit (owner only)
  router.put('/listings/:id', (req, res) => {
    const id = idParam(req);
    const row = db.prepare('SELECT user_id FROM listings WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'Listing not found.');
    if (row.user_id !== req.user.id) throw new ApiError(403, 'You can only edit your own listings.');

    const d = parseListing(req.body);
    db.prepare(
      `UPDATE listings SET kind = ?, title = ?, description = ?, category = ?, price_type = ?, price = ?, mode = ?,
         updated_at = datetime('now') WHERE id = ?`
    ).run(d.kind, d.title, d.description, d.category, d.priceType, d.price, d.mode, id);
    res.json({ id });
  });

  // Close or reopen (owner only)
  router.patch('/listings/:id/status', (req, res) => {
    const id = idParam(req);
    const status = String(req.body.status || '');
    if (!['active', 'closed'].includes(status)) throw new ApiError(400, 'Invalid status.');
    const row = db.prepare('SELECT user_id FROM listings WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'Listing not found.');
    if (row.user_id !== req.user.id) throw new ApiError(403, 'You can only change your own listings.');

    if (status === 'active') {
      const active = db.prepare("SELECT COUNT(*) AS n FROM listings WHERE user_id = ? AND status = 'active'").get(req.user.id).n;
      if (active >= MAX_ACTIVE_LISTINGS) throw new ApiError(400, `You can have up to ${MAX_ACTIVE_LISTINGS} active listings.`);
    }
    db.prepare("UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
    res.json({ id, status });
  });

  // Delete (owner only). Its messages are deleted with it.
  router.delete('/listings/:id', (req, res) => {
    const id = idParam(req);
    const row = db.prepare('SELECT user_id FROM listings WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'Listing not found.');
    if (row.user_id !== req.user.id) throw new ApiError(403, 'You can only delete your own listings.');
    db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    res.json({ message: 'Listing deleted.' });
  });

  /* ---------------- Messages ---------------- */

  // Send a message. Buyers write to the listing owner; owners reply to a buyer (toUserId).
  router.post(
    '/messages',
    messageLimiter,
    wrap(async (req, res) => {
      const me = req.user.id;
      const listingId = Number(req.body.listingId);
      const body = String(req.body.body || '').trim();
      if (!Number.isInteger(listingId)) throw new ApiError(400, 'Invalid listing.');
      if (body.length < 1 || body.length > 1000) throw new ApiError(400, 'Write a message between 1 and 1000 characters.');

      const listing = db.prepare('SELECT id, user_id, title, status FROM listings WHERE id = ?').get(listingId);
      if (!listing) throw new ApiError(404, 'Listing not found.');

      let recipientId;
      if (listing.user_id === me) {
        recipientId = Number(req.body.toUserId);
        const hasWrittenToMe = db
          .prepare('SELECT 1 FROM messages WHERE listing_id = ? AND sender_id = ? AND recipient_id = ? LIMIT 1')
          .get(listingId, recipientId, me);
        if (!hasWrittenToMe) throw new ApiError(400, 'You can only reply to people who messaged you about this listing.');
      } else {
        if (listing.status !== 'active') throw new ApiError(400, 'This listing is closed.');
        recipientId = listing.user_id;
      }

      // Only email if the recipient has no unread message from me in this thread yet (avoids email floods).
      const alreadyUnread = db
        .prepare(
          'SELECT 1 FROM messages WHERE listing_id = ? AND sender_id = ? AND recipient_id = ? AND read_at IS NULL LIMIT 1'
        )
        .get(listingId, me, recipientId);

      const info = db
        .prepare('INSERT INTO messages (listing_id, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)')
        .run(listingId, me, recipientId, body);
      const saved = db.prepare('SELECT id, body, created_at FROM messages WHERE id = ?').get(info.lastInsertRowid);

      if (!alreadyUnread) {
        const recipient = db.prepare('SELECT name, email FROM users WHERE id = ?').get(recipientId);
        const link = `${APP_URL}/app.html#/inbox/${listingId}/${me}`;
        sendMail({
          to: recipient.email,
          subject: `New message about "${listing.title}"`,
          text: `${req.user.name} sent you a message about "${listing.title}":\n\n${body}\n\nReply here: ${link}`,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14213d">
                   <h2 style="margin:0 0 12px">New message</h2>
                   <p><b>${escapeHtml(req.user.name)}</b> messaged you about <b>${escapeHtml(listing.title)}</b>:</p>
                   <blockquote style="margin:16px 0;padding:12px 16px;background:#eef1f6;border-radius:8px;white-space:pre-wrap">${escapeHtml(body)}</blockquote>
                   <p><a href="${link}" style="color:#3b5bdb;font-weight:bold">Open the conversation</a></p>
                 </div>`,
        }).catch((err) => console.error('Message notification email failed:', err.message));
      }

      res.status(201).json({ message: { id: saved.id, mine: true, body: saved.body, createdAt: iso(saved.created_at) } });
    })
  );

  // All conversations for the current user (one per listing + other person)
  router.get('/messages/threads', (req, res) => {
    const rows = db
      .prepare(
        `WITH mine AS (
           SELECT m.*, CASE WHEN m.sender_id = @me THEN m.recipient_id ELSE m.sender_id END AS other_id
           FROM messages m WHERE m.sender_id = @me OR m.recipient_id = @me
         ),
         ranked AS (
           SELECT mine.*,
             ROW_NUMBER() OVER (PARTITION BY listing_id, other_id ORDER BY id DESC) AS rn,
             SUM(CASE WHEN recipient_id = @me AND read_at IS NULL THEN 1 ELSE 0 END)
               OVER (PARTITION BY listing_id, other_id) AS unread
           FROM mine
         )
         SELECT r.listing_id, r.other_id, r.body, r.sender_id, r.created_at, r.unread,
                l.title, l.status, u.name AS other_name, u.university AS other_university
         FROM ranked r
         JOIN listings l ON l.id = r.listing_id
         JOIN users u ON u.id = r.other_id
         WHERE r.rn = 1
         ORDER BY r.id DESC`
      )
      .all({ me: req.user.id });

    res.json({
      threads: rows.map((r) => ({
        listingId: r.listing_id,
        listingTitle: r.title,
        listingStatus: r.status,
        other: { id: r.other_id, name: r.other_name, university: r.other_university },
        lastMessage: { body: r.body, mine: r.sender_id === req.user.id, createdAt: iso(r.created_at) },
        unread: r.unread,
      })),
    });
  });

  // One conversation. Opening it marks incoming messages as read.
  router.get('/messages/thread', (req, res) => {
    const me = req.user.id;
    const listingId = Number(req.query.listingId);
    const otherId = Number(req.query.userId);
    if (!Number.isInteger(listingId) || !Number.isInteger(otherId) || otherId === me) {
      throw new ApiError(400, 'Invalid conversation.');
    }
    const listing = db.prepare('SELECT id, title, status, user_id FROM listings WHERE id = ?').get(listingId);
    const other = db.prepare('SELECT id, name, university FROM users WHERE id = ?').get(otherId);
    if (!listing || !other || (listing.user_id !== me && listing.user_id !== otherId)) {
      throw new ApiError(404, 'Conversation not found.');
    }

    const rows = db
      .prepare(
        `SELECT id, sender_id, body, created_at FROM messages
         WHERE listing_id = ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
         ORDER BY id ASC LIMIT 500`
      )
      .all(listingId, me, otherId, otherId, me);

    db.prepare(
      "UPDATE messages SET read_at = datetime('now') WHERE listing_id = ? AND sender_id = ? AND recipient_id = ? AND read_at IS NULL"
    ).run(listingId, otherId, me);

    res.json({
      listing: { id: listing.id, title: listing.title, status: listing.status, ownerId: listing.user_id },
      other,
      messages: rows.map((m) => ({ id: m.id, mine: m.sender_id === me, body: m.body, createdAt: iso(m.created_at) })),
    });
  });

  router.get('/messages/unread-count', (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(req.user.id).n;
    res.json({ unread: n });
  });

  app.use('/api', router);
};
