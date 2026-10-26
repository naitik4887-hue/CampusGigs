const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

/**
 * Item photos.
 *
 * The browser shrinks every photo to a JPEG before uploading, so the server only
 * accepts image/jpeg and checks the file's first bytes. Files are stored outside
 * /public and are only served to logged-in students.
 */
module.exports = function registerUploads(router, { db, ApiError, storageDir }) {
  const dir = path.join(storageDir, 'items');
  fs.mkdirSync(dir, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id         TEXT PRIMARY KEY,                       -- 32 hex chars, also the file name
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_listing ON uploads(listing_id, position);
  `);

  const fileFor = (id) => path.join(dir, `${id}.jpg`);
  const isJpeg = (buf) => Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

  function removeFiles(ids) {
    for (const id of ids) fs.unlink(fileFor(id), () => {});
  }

  // Photos that were uploaded but never attached to a listing are cleaned up after a day.
  function cleanupOrphans() {
    const rows = db.prepare("SELECT id FROM uploads WHERE listing_id IS NULL AND created_at < datetime('now', '-1 day')").all();
    for (const r of rows) db.prepare('DELETE FROM uploads WHERE id = ?').run(r.id);
    removeFiles(rows.map((r) => r.id));
  }
  cleanupOrphans();
  setInterval(cleanupOrphans, 60 * 60 * 1000).unref();

  const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => 'user-' + req.user.id,
    message: { message: 'You are uploading too quickly. Try again in a few minutes.' },
  });

  // Upload one JPEG (raw bytes in the request body).
  router.post('/uploads', uploadLimiter, express.raw({ type: 'image/jpeg', limit: '1500kb' }), (req, res) => {
    if (!isJpeg(req.body)) throw new ApiError(400, 'Upload a JPEG image.');

    const unused = db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND listing_id IS NULL').get(req.user.id).n;
    if (unused >= 20) throw new ApiError(429, 'You have too many unused photos. Finish posting your listing first.');

    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(fileFor(id), req.body);
    db.prepare('INSERT INTO uploads (id, user_id) VALUES (?, ?)').run(id, req.user.id);
    res.status(201).json({ id });
  });

  // Show a photo. Attached photos are visible to any logged-in student; unattached ones only to their uploader.
  router.get('/uploads/:id', (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError(404, 'Not found.');
    const row = db.prepare('SELECT user_id, listing_id FROM uploads WHERE id = ?').get(id);
    if (!row || (row.listing_id == null && row.user_id !== req.user.id)) throw new ApiError(404, 'Not found.');

    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.sendFile(fileFor(id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Not found.' });
    });
  });

  return { removeFiles };
};
