const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

/**
 * College ID verification.
 *
 * A student uploads a photo of their college ID plus the ID number. An admin
 * (see ADMIN_EMAILS in .env) approves or rejects it. Once reviewed, the photo is
 * deleted. Only the ID number and the decision are kept.
 * Approved students get users.id_verified = 1, which unlocks the Marketplace.
 */
module.exports = function registerVerification(router, { db, ApiError, wrap, sendMail, isAdmin, storageDir, escapeHtml }) {
  const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const pendingDir = path.join(storageDir, 'id-pending'); // uploaded, not yet submitted
  const reviewDir = path.join(storageDir, 'id-review'); // submitted, waiting for an admin
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS id_verifications (
      user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      college        TEXT NOT NULL,
      id_number      TEXT NOT NULL,
      id_number_norm TEXT NOT NULL,
      status         TEXT NOT NULL,                 -- 'pending' | 'approved' | 'rejected'
      note           TEXT,                          -- reason shown to the student when rejected
      photo_file     TEXT,                          -- removed after review
      reviewed_by    INTEGER,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_idv_status ON id_verifications(status, created_at);
  `);

  const iso = (s) => (s ? s.replace(' ', 'T') + 'Z' : null);
  const isJpeg = (buf) => Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const removeFile = (file) => fs.unlink(file, () => {});
  const maskId = (id) => (id.length <= 4 ? id : '•'.repeat(id.length - 4) + id.slice(-4));

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => 'user-' + req.user.id,
    message: { message: 'Too many attempts. Please try again later.' },
  });

  /* ---------------- Student side ---------------- */

  // My verification status
  router.get('/verification', (req, res) => {
    const row = db.prepare('SELECT * FROM id_verifications WHERE user_id = ?').get(req.user.id);
    if (req.user.id_verified) {
      return res.json({ status: 'approved', college: row ? row.college : null, idVerified: true });
    }
    if (!row) return res.json({ status: 'none', idVerified: false });
    res.json({
      status: row.status,
      college: row.college,
      idNumber: maskId(row.id_number),
      note: row.status === 'rejected' ? row.note : null,
      submittedAt: iso(row.created_at),
      idVerified: false,
    });
  });

  // Step 1: upload the photo of the ID card (raw JPEG bytes)
  router.post('/verification/photo', limiter, express.raw({ type: 'image/jpeg', limit: '3mb' }), (req, res) => {
    if (req.user.id_verified) throw new ApiError(400, 'You are already verified.');
    if (!isJpeg(req.body)) throw new ApiError(400, 'Upload a JPEG photo of your ID card.');
    fs.writeFileSync(path.join(pendingDir, `${req.user.id}.jpg`), req.body);
    res.status(201).json({ ok: true });
  });

  // Step 2: submit the details and send everything for review
  router.post('/verification', limiter, (req, res) => {
    if (req.user.id_verified) throw new ApiError(400, 'You are already verified.');

    const existing = db.prepare('SELECT status FROM id_verifications WHERE user_id = ?').get(req.user.id);
    if (existing && existing.status === 'pending') throw new ApiError(400, 'Your request is already being reviewed.');

    const college = String(req.body.college || '').trim();
    const idNumber = String(req.body.idNumber || '').trim();
    if (college.length < 2 || college.length > 100) throw new ApiError(400, 'Enter your college or university name.');
    if (idNumber.length < 4 || idNumber.length > 30 || !/^[A-Za-z0-9\-/._ ]+$/.test(idNumber)) {
      throw new ApiError(400, 'Enter the ID or enrollment number printed on your card (4 to 30 characters).');
    }
    const norm = idNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm.length < 4) throw new ApiError(400, 'That ID number looks too short.');

    const staged = path.join(pendingDir, `${req.user.id}.jpg`);
    if (!fs.existsSync(staged)) throw new ApiError(400, 'Add a photo of your college ID card first.');

    const clash = db
      .prepare("SELECT 1 FROM id_verifications WHERE id_number_norm = ? AND user_id != ? AND status IN ('pending', 'approved')")
      .get(norm, req.user.id);
    if (clash) throw new ApiError(409, 'That ID number is already linked to another account.');

    const reviewFile = `${req.user.id}-${crypto.randomBytes(8).toString('hex')}.jpg`;
    fs.renameSync(staged, path.join(reviewDir, reviewFile));

    db.prepare(
      `INSERT INTO id_verifications (user_id, college, id_number, id_number_norm, status, photo_file)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(user_id) DO UPDATE SET
         college = excluded.college, id_number = excluded.id_number, id_number_norm = excluded.id_number_norm,
         status = 'pending', note = NULL, photo_file = excluded.photo_file, reviewed_by = NULL,
         reviewed_at = NULL, created_at = datetime('now')`
    ).run(req.user.id, college, idNumber, norm, reviewFile);

    res.status(201).json({ status: 'pending' });
  });

  /* ---------------- Admin side ---------------- */

  const requireAdmin = (req, res, next) => (isAdmin(req.user) ? next() : next(new ApiError(403, 'Admins only.')));

  router.get('/admin/verifications', requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT v.user_id, v.college, v.id_number, v.created_at, u.name, u.email, u.university
         FROM id_verifications v JOIN users u ON u.id = v.user_id
         WHERE v.status = 'pending' AND v.photo_file IS NOT NULL
         ORDER BY v.created_at ASC`
      )
      .all();
    res.json({
      requests: rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        university: r.university,
        college: r.college,
        idNumber: r.id_number,
        submittedAt: iso(r.created_at),
      })),
    });
  });

  router.get('/admin/verifications/:userId/photo', requireAdmin, (req, res) => {
    const row = db
      .prepare("SELECT photo_file FROM id_verifications WHERE user_id = ? AND status = 'pending'")
      .get(Number(req.params.userId));
    if (!row || !row.photo_file) throw new ApiError(404, 'Photo not found.');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    res.sendFile(path.join(reviewDir, row.photo_file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Photo not found.' });
    });
  });

  router.post(
    '/admin/verifications/:userId/decision',
    requireAdmin,
    wrap(async (req, res) => {
      const userId = Number(req.params.userId);
      const decision = String(req.body.decision || '');
      const note = String(req.body.note || '').trim().slice(0, 300);
      if (!['approve', 'reject'].includes(decision)) throw new ApiError(400, 'Invalid decision.');
      if (decision === 'reject' && note.length < 3) throw new ApiError(400, 'Add a short reason so the student can fix it.');

      const row = db
        .prepare(
          `SELECT v.photo_file, u.name, u.email FROM id_verifications v JOIN users u ON u.id = v.user_id
           WHERE v.user_id = ? AND v.status = 'pending'`
        )
        .get(userId);
      if (!row) throw new ApiError(404, 'There is no pending request for this student.');

      const apply = db.transaction(() => {
        db.prepare(
          `UPDATE id_verifications SET status = ?, note = ?, photo_file = NULL, reviewed_by = ?, reviewed_at = datetime('now')
           WHERE user_id = ?`
        ).run(decision === 'approve' ? 'approved' : 'rejected', decision === 'reject' ? note : null, req.user.id, userId);
        if (decision === 'approve') db.prepare('UPDATE users SET id_verified = 1 WHERE id = ?').run(userId);
      });
      apply();
      if (row.photo_file) removeFile(path.join(reviewDir, row.photo_file)); // the photo is deleted after review

      const approved = decision === 'approve';
      sendMail({
        to: row.email,
        subject: approved ? 'You are verified on CampusGigs' : 'Your college ID needs another look',
        text: approved
          ? `Hi ${row.name}, your college ID is verified. You can now buy and sell in the Marketplace: ${APP_URL}/app.html#/market`
          : `Hi ${row.name}, we could not verify your college ID.\n\nReason: ${note}\n\nYou can submit it again here: ${APP_URL}/app.html#/verify`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14213d">
                 <h2 style="margin:0 0 12px">${approved ? 'You are verified' : 'Your college ID needs another look'}</h2>
                 <p>Hi ${escapeHtml(row.name)},</p>
                 ${
                   approved
                     ? `<p>Your college ID is verified. You can now buy and sell in the Marketplace.</p>
                        <p><a href="${APP_URL}/app.html#/market" style="color:#0b7285;font-weight:bold">Open the Marketplace</a></p>`
                     : `<p>We could not verify your college ID.</p>
                        <blockquote style="margin:16px 0;padding:12px 16px;background:#eef1f6;border-radius:8px">${escapeHtml(note)}</blockquote>
                        <p><a href="${APP_URL}/app.html#/verify" style="color:#3b5bdb;font-weight:bold">Submit it again</a></p>`
                 }
               </div>`,
      }).catch((err) => console.error('Verification email failed:', err.message));

      res.json({ ok: true });
    })
  );
};
