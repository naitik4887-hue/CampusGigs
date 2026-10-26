const express = require('express');
const rateLimit = require('express-rate-limit');
const registerUploads = require('./uploads');
const registerVerification = require('./verification');

/* ------------------------------------------------------------------ */
/* Options (edit these to change what the site offers)                 */
/* ------------------------------------------------------------------ */
const SERVICE_CATEGORIES = [
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
const ITEM_CATEGORIES = [
  'Books & Notes',
  'Electronics',
  'Hostel & Furniture',
  'Cycles & Vehicles',
  'Clothing & Accessories',
  'Stationery & Lab Gear',
  'Sports & Fitness',
  'Other',
];
const SECTIONS = ['service', 'item'];
const KINDS = ['offer', 'request']; // services only: offering | looking for
const SERVICE_PRICE_TYPES = ['fixed', 'hourly', 'negotiable', 'free'];
const ITEM_PRICE_TYPES = ['fixed', 'negotiable', 'free']; // negotiable items still have an asking price
const MODES = ['campus', 'online', 'both'];
const CONDITIONS = ['new', 'like_new', 'good', 'fair'];
const MAX_ACTIVE_LISTINGS = 20; // per section, per student
const MAX_IMAGES = 4;
const PAGE_SIZE = 12;

const iso = (s) => (s ? s.replace(' ', 'T') + 'Z' : null); // SQLite UTC -> ISO string
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function registerMarketplace(app, { db, requireAuth, wrap, ApiError, sendMail, isAdmin, storageDir }) {
  const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  /* ---------------------------------------------------------------- */
  /* Tables + migrations                                               */
  /* ---------------------------------------------------------------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      section        TEXT NOT NULL DEFAULT 'service',   -- 'service' | 'item'
      kind           TEXT NOT NULL,
      title          TEXT NOT NULL,
      description    TEXT NOT NULL,
      category       TEXT NOT NULL,
      price_type     TEXT NOT NULL,
      price          INTEGER,
      mode           TEXT NOT NULL,
      item_condition TEXT,                              -- items only
      location       TEXT,                              -- items only: pickup spot
      status         TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'closed' (closed = sold, for items)
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id   INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      read_at      TEXT
    );
  `);

  // Databases created by the earlier version don't have the newer columns yet.
  const listingCols = db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name);
  if (!listingCols.includes('section')) db.exec("ALTER TABLE listings ADD COLUMN section TEXT NOT NULL DEFAULT 'service'");
  if (!listingCols.includes('item_condition')) db.exec('ALTER TABLE listings ADD COLUMN item_condition TEXT');
  if (!listingCols.includes('location')) db.exec('ALTER TABLE listings ADD COLUMN location TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listings_browse ON listings(section, status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(listing_id, sender_id, recipient_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, read_at);
  `);

  /* ---------------------------------------------------------------- */
  /* Router (everything here requires a logged-in student)             */
  /* ---------------------------------------------------------------- */
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 900,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests. Please slow down.' },
    })
  );
  router.use(requireAuth);

  const { removeFiles } = registerUploads(router, { db, ApiError, storageDir });
  registerVerification(router, { db, ApiError, wrap, sendMail, isAdmin, storageDir, escapeHtml });

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */
  const LISTING_SELECT = `
    SELECT l.*, u.name AS seller_name, u.university AS seller_university, u.id_verified AS seller_verified,
           (SELECT id FROM uploads WHERE listing_id = l.id ORDER BY position, created_at LIMIT 1) AS cover_id
    FROM listings l JOIN users u ON u.id = l.user_id`;

  function listingJson(r, viewerId) {
    return {
      id: r.id,
      section: r.section,
      kind: r.kind,
      title: r.title,
      description: r.description,
      category: r.category,
      priceType: r.price_type,
      price: r.price,
      mode: r.mode,
      condition: r.item_condition,
      location: r.location,
      status: r.status,
      cover: r.cover_id || null,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      isOwner: r.user_id === viewerId,
      seller: { id: r.user_id, name: r.seller_name, university: r.seller_university, verified: Boolean(r.seller_verified) },
    };
  }

  function idParam(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ApiError(404, 'Listing not found.');
    return id;
  }

  function parseCommon(b) {
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    if (title.length < 5 || title.length > 100) throw new ApiError(400, 'Title must be 5 to 100 characters.');
    if (description.length < 20 || description.length > 2000) {
      throw new ApiError(400, 'Description must be 20 to 2000 characters.');
    }
    return { title, description };
  }

  function parsePrice(b, priceTypes) {
    const priceType = String(b.priceType || '');
    if (!priceTypes.includes(priceType)) throw new ApiError(400, 'Choose how the price works.');
    let price = null;
    if (priceType === 'free') {
      price = 0;
    } else if (priceType !== 'negotiable' || priceTypes === ITEM_PRICE_TYPES) {
      // fixed, hourly, or an item's asking price: a whole number of rupees is required
      price = Number(b.price);
      if (!Number.isInteger(price) || price < 1 || price > 1000000) {
        throw new ApiError(400, 'Enter a price in whole rupees, between 1 and 10,00,000.');
      }
    }
    return { priceType, price };
  }

  function parseService(b) {
    const kind = String(b.kind || '');
    const category = String(b.category || '');
    const mode = String(b.mode || '');
    if (!KINDS.includes(kind)) throw new ApiError(400, 'Choose whether you are offering or looking for a service.');
    if (!SERVICE_CATEGORIES.includes(category)) throw new ApiError(400, 'Choose a category.');
    if (!MODES.includes(mode)) throw new ApiError(400, 'Choose where the service happens.');
    return { section: 'service', kind, category, mode, condition: null, location: null, images: null, ...parseCommon(b), ...parsePrice(b, SERVICE_PRICE_TYPES) };
  }

  function parseItem(b) {
    const category = String(b.category || '');
    const condition = String(b.condition || '');
    const location = String(b.location || '').trim();
    if (!ITEM_CATEGORIES.includes(category)) throw new ApiError(400, 'Choose a category.');
    if (!CONDITIONS.includes(condition)) throw new ApiError(400, 'Choose the item’s condition.');
    if (location.length < 2 || location.length > 80) throw new ApiError(400, 'Tell buyers where to pick it up (2 to 80 characters).');

    const images = Array.isArray(b.images) ? [...new Set(b.images.map(String))] : [];
    if (images.length < 1) throw new ApiError(400, 'Add at least one photo.');
    if (images.length > MAX_IMAGES) throw new ApiError(400, `You can add up to ${MAX_IMAGES} photos.`);
    if (!images.every((id) => /^[a-f0-9]{32}$/.test(id))) throw new ApiError(400, 'One of the photos is invalid.');

    return { section: 'item', kind: 'offer', category, mode: 'campus', condition, location, images, ...parseCommon(b), ...parsePrice(b, ITEM_PRICE_TYPES) };
  }

  /** Attaches uploaded photos to a listing (in order) and detaches any that were removed. Run inside a transaction. */
  function attachImages(listingId, userId, ids) {
    const removed = [];
    const keep = new Set(ids);
    for (const r of db.prepare('SELECT id FROM uploads WHERE listing_id = ?').all(listingId)) {
      if (!keep.has(r.id)) {
        db.prepare('DELETE FROM uploads WHERE id = ?').run(r.id);
        removed.push(r.id);
      }
    }
    ids.forEach((id, i) => {
      const row = db.prepare('SELECT user_id, listing_id FROM uploads WHERE id = ?').get(id);
      if (!row || row.user_id !== userId || (row.listing_id != null && row.listing_id !== listingId)) {
        throw new ApiError(400, 'One of your photos is no longer available. Please add it again.');
      }
      db.prepare('UPDATE uploads SET listing_id = ?, position = ? WHERE id = ?').run(listingId, i, id);
    });
    return removed;
  }

  const activeCount = (userId, section) =>
    db.prepare("SELECT COUNT(*) AS n FROM listings WHERE user_id = ? AND section = ? AND status = 'active'").get(userId, section).n;

  const messageLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => 'user-' + req.user.id,
    message: { message: 'You are sending messages too quickly. Try again in a few minutes.' },
  });

  // Options for the frontend
  router.get('/meta', (req, res) =>
    res.json({
      serviceCategories: SERVICE_CATEGORIES,
      itemCategories: ITEM_CATEGORIES,
      conditions: CONDITIONS,
      maxActiveListings: MAX_ACTIVE_LISTINGS,
      maxImages: MAX_IMAGES,
    })
  );

  /* ---------------- Listings ---------------- */

  // Browse + search (one section at a time)
  router.get('/listings', (req, res) => {
    const section = SECTIONS.includes(req.query.section) ? req.query.section : 'service';
    const categories = section === 'item' ? ITEM_CATEGORIES : SERVICE_CATEGORIES;
    const q = String(req.query.q || '').trim().slice(0, 80);
    const category = String(req.query.category || '');
    const kind = String(req.query.kind || '');
    const condition = String(req.query.condition || '');
    const sort = String(req.query.sort || 'new');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const minPrice = parseInt(req.query.minPrice, 10);
    const maxPrice = parseInt(req.query.maxPrice, 10);

    const where = ["l.status = 'active'", 'l.section = ?'];
    const params = [section];
    if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      where.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (categories.includes(category)) {
      where.push('l.category = ?');
      params.push(category);
    }
    if (section === 'service' && KINDS.includes(kind)) {
      where.push('l.kind = ?');
      params.push(kind);
    }
    if (section === 'item') {
      if (CONDITIONS.includes(condition)) {
        where.push('l.item_condition = ?');
        params.push(condition);
      }
      if (Number.isInteger(minPrice) && minPrice >= 0) {
        where.push('l.price >= ?');
        params.push(minPrice);
      }
      if (Number.isInteger(maxPrice) && maxPrice >= 0) {
        where.push('l.price <= ?');
        params.push(maxPrice);
      }
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

  // The current user's own listings, both sections, all statuses. Declared before /listings/:id.
  router.get('/listings/mine', (req, res) => {
    const rows = db.prepare(`${LISTING_SELECT} WHERE l.user_id = ? ORDER BY l.id DESC`).all(req.user.id);
    res.json({ listings: rows.map((r) => listingJson(r, req.user.id)) });
  });

  // One listing (with all its photos)
  router.get('/listings/:id', (req, res) => {
    const id = idParam(req);
    const row = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(id);
    if (!row) throw new ApiError(404, 'Listing not found.');
    const images = db.prepare('SELECT id FROM uploads WHERE listing_id = ? ORDER BY position, created_at').all(id).map((r) => r.id);
    res.json({ listing: { ...listingJson(row, req.user.id), images } });
  });

  // Create
  router.post('/listings', (req, res) => {
    const section = SECTIONS.includes(req.body.section) ? req.body.section : 'service';
    if (section === 'item' && !req.user.id_verified) {
      throw new ApiError(403, 'Verify your college ID before selling items.', { needsIdVerification: true });
    }
    if (activeCount(req.user.id, section) >= MAX_ACTIVE_LISTINGS) {
      throw new ApiError(400, `You can have up to ${MAX_ACTIVE_LISTINGS} active listings here. Close one to post another.`);
    }
    const d = section === 'item' ? parseItem(req.body) : parseService(req.body);

    let id;
    let removed = [];
    db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO listings (user_id, section, kind, title, description, category, price_type, price, mode, item_condition, location)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.user.id, d.section, d.kind, d.title, d.description, d.category, d.priceType, d.price, d.mode, d.condition, d.location);
      id = Number(info.lastInsertRowid);
      if (d.images) removed = attachImages(id, req.user.id, d.images);
    })();
    removeFiles(removed);
    res.status(201).json({ id });
  });

  // Edit (owner only). The section can't change.
  router.put('/listings/:id', (req, res) => {
    const id = idParam(req);
    const row = db.prepare('SELECT user_id, section FROM listings WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'Listing not found.');
    if (row.user_id !== req.user.id) throw new ApiError(403, 'You can only edit your own listings.');

    const d = row.section === 'item' ? parseItem(req.body) : parseService(req.body);
    let removed = [];
    db.transaction(() => {
      db.prepare(
        `UPDATE listings SET kind = ?, title = ?, description = ?, category = ?, price_type = ?, price = ?, mode = ?,
           item_condition = ?, location = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(d.kind, d.title, d.description, d.category, d.priceType, d.price, d.mode, d.condition, d.location, id);
      if (d.images) removed = attachImages(id, req.user.id, d.images);
    })();
    removeFiles(removed);
    res.json({ id });
  });

  // Close / mark as sold, or reopen (owner only)
  router.patch('/listings/:id/status', (req, res) => {
    const id = idParam(req);
    const status = String(req.body.status || '');
    if (!['active', 'closed'].includes(status)) throw new ApiError(400, 'Invalid status.');
    const row = db.prepare('SELECT user_id, section FROM listings WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'Listing not found.');
    if (row.user_id !== req.user.id) throw new ApiError(403, 'You can only change your own listings.');

    if (status === 'active' && activeCount(req.user.id, row.section) >= MAX_ACTIVE_LISTINGS) {
      throw new ApiError(400, `You can have up to ${MAX_ACTIVE_LISTINGS} active listings here.`);
    }
    db.prepare("UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
    res.json({ id, status });
  });

  // Delete (owner only). Its messages and photos are deleted with it.
  router.delete('/listings/:id', (req, res) => {
    const id = idParam(req);
    const row = db.prepare('SELECT user_id FROM listings WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'Listing not found.');
    if (row.user_id !== req.user.id) throw new ApiError(403, 'You can only delete your own listings.');
    const photoIds = db.prepare('SELECT id FROM uploads WHERE listing_id = ?').all(id).map((r) => r.id);
    db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    removeFiles(photoIds);
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

      const listing = db.prepare('SELECT id, user_id, title, status, section FROM listings WHERE id = ?').get(listingId);
      if (!listing) throw new ApiError(404, 'Listing not found.');

      let recipientId;
      if (listing.user_id === me) {
        recipientId = Number(req.body.toUserId);
        const hasWrittenToMe = db
          .prepare('SELECT 1 FROM messages WHERE listing_id = ? AND sender_id = ? AND recipient_id = ? LIMIT 1')
          .get(listingId, recipientId, me);
        if (!hasWrittenToMe) throw new ApiError(400, 'You can only reply to people who messaged you about this listing.');
      } else {
        if (listing.section === 'item' && !req.user.id_verified) {
          throw new ApiError(403, 'Verify your college ID to message sellers in the Marketplace.', { needsIdVerification: true });
        }
        if (listing.status !== 'active') throw new ApiError(400, listing.section === 'item' ? 'This item has been sold.' : 'This listing is closed.');
        recipientId = listing.user_id;
      }

      // Only email if the recipient has no unread message from me in this thread yet (avoids email floods).
      const alreadyUnread = db
        .prepare('SELECT 1 FROM messages WHERE listing_id = ? AND sender_id = ? AND recipient_id = ? AND read_at IS NULL LIMIT 1')
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
                l.title, l.status, l.section, u.name AS other_name, u.university AS other_university
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
        listingSection: r.section,
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
    const listing = db.prepare('SELECT id, title, status, user_id, section FROM listings WHERE id = ?').get(listingId);
    const other = db.prepare('SELECT id, name, university FROM users WHERE id = ?').get(otherId);
    if (!listing || !other || (listing.user_id !== me && listing.user_id !== otherId)) {
      throw new ApiError(404, 'Conversation not found.');
    }

    const rows = db
      .prepare(
        `SELECT id, sender_id, body, created_at, read_at FROM messages
         WHERE listing_id = ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
         ORDER BY id ASC LIMIT 500`
      )
      .all(listingId, me, otherId, otherId, me);

    db.prepare(
      "UPDATE messages SET read_at = datetime('now') WHERE listing_id = ? AND sender_id = ? AND recipient_id = ? AND read_at IS NULL"
    ).run(listingId, otherId, me);

    res.json({
      listing: { id: listing.id, title: listing.title, status: listing.status, section: listing.section, ownerId: listing.user_id },
      other,
      messages: rows.map((m) => ({ id: m.id, mine: m.sender_id === me, body: m.body, createdAt: iso(m.created_at), read: Boolean(m.read_at) })),
    });
  });

  router.get('/messages/unread-count', (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(req.user.id).n;
    res.json({ unread: n });
  });

  app.use('/api', router);
};
