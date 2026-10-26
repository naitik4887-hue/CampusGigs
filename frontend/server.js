require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');
const registerMarketplace = require('./marketplace');

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const OTP_EXPIRY_MIN = Number(process.env.OTP_EXPIRY_MINUTES || 10);
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SEC = 60;
const SESSION_DAYS = 7;

// Only these email domains can sign up. A value starting with a dot (".ac.in")
// matches any domain ending that way. A value without a dot ("mdu.ac.in")
// matches that exact domain and its subdomains ("stu.mdu.ac.in").
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || '.edu,.edu.in,.ac.in')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (!JWT_SECRET || JWT_SECRET === 'change-me') {
  console.error('Set a strong JWT_SECRET in your .env file before starting.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Student email helpers                                               */
/* ------------------------------------------------------------------ */
function isStudentEmail(email) {
  const domain = String(email).split('@')[1] || '';
  return ALLOWED_DOMAINS.some((d) => (d.startsWith('.') ? domain.endsWith(d) : domain === d || domain.endsWith('.' + d)));
}

// "stu.mdu.ac.in" -> "mdu.ac.in". Used as the university label shown on listings.
function uniLabel(email) {
  const domain = String(email).split('@')[1] || '';
  return domain.replace(/^(students?|stu|std|mail|my|alumni)\./, '');
}

/* ------------------------------------------------------------------ */
/* Database (SQLite, file created automatically)                       */
/* ------------------------------------------------------------------ */
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_verified   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS otps (
    email        TEXT NOT NULL,
    purpose      TEXT NOT NULL,          -- 'verify' | 'reset'
    code_hash    TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,       -- unix ms
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL,       -- unix ms
    PRIMARY KEY (email, purpose)
  );
`);

// Migration: add users.university if this database was created before the marketplace existed.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'university')) {
  db.exec('ALTER TABLE users ADD COLUMN university TEXT');
}
for (const u of db.prepare('SELECT id, email FROM users WHERE university IS NULL').all()) {
  db.prepare('UPDATE users SET university = ? WHERE id = ?').run(uniLabel(u.email), u.id);
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

if (!smtpConfigured) {
  console.warn('SMTP is not configured. Emails will be printed in this terminal instead of sent.');
}

/** Sends any email. Without SMTP settings it prints the email in the terminal. */
async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`\n[DEV] Email to ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
}

function otpEmailHtml(name, code, purpose) {
  const heading = purpose === 'reset' ? 'Reset your password' : 'Verify your email';
  const intro =
    purpose === 'reset'
      ? 'Use this code to choose a new password.'
      : 'Use this code to finish creating your account.';
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14213d">
    <h2 style="margin:0 0 12px">${heading}</h2>
    <p style="margin:0 0 20px">Hi ${escapeHtml(name)}, ${intro}</p>
    <div style="font-size:32px;letter-spacing:10px;font-weight:700;background:#eef1f6;border-radius:8px;padding:16px 0;text-align:center">${code}</div>
    <p style="margin:20px 0 0;color:#5c667a;font-size:14px">
      This code expires in ${OTP_EXPIRY_MIN} minutes. If you didn't request it, you can ignore this email.
    </p>
  </div>`;
}

async function sendOtpEmail(to, name, code, purpose) {
  if (!transporter) {
    console.log(`\n[DEV] ${purpose} OTP for ${to}: ${code}\n`);
    return;
  }
  await sendMail({
    to,
    subject: purpose === 'reset' ? 'Your password reset code' : 'Your verification code',
    text: `Your code is ${code}. It expires in ${OTP_EXPIRY_MIN} minutes.`,
    html: otpEmailHtml(name, code, purpose),
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 72) return 'Password must be 72 characters or fewer.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must include at least one letter and one number.';
  return null;
}

const hashOtp = (email, purpose, code) =>
  crypto.createHmac('sha256', JWT_SECRET).update(`${email}|${purpose}|${code}`).digest('hex');

class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Creates a fresh OTP, stores its hash and emails it. Enforces a resend cooldown. */
async function issueOtp(user, purpose) {
  const existing = db.prepare('SELECT last_sent_at FROM otps WHERE email = ? AND purpose = ?').get(user.email, purpose);
  if (existing) {
    const waitMs = OTP_RESEND_COOLDOWN_SEC * 1000 - (Date.now() - existing.last_sent_at);
    if (waitMs > 0) {
      throw new ApiError(429, `Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`, {
        retryAfter: Math.ceil(waitMs / 1000),
      });
    }
  }

  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(
    `INSERT INTO otps (email, purpose, code_hash, expires_at, attempts, last_sent_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(email, purpose) DO UPDATE SET
       code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, last_sent_at = excluded.last_sent_at`
  ).run(user.email, purpose, hashOtp(user.email, purpose, code), Date.now() + OTP_EXPIRY_MIN * 60 * 1000, Date.now());

  try {
    await sendOtpEmail(user.email, user.name, code, purpose);
  } catch (err) {
    console.error('Email send failed:', err.message);
    db.prepare('DELETE FROM otps WHERE email = ? AND purpose = ?').run(user.email, purpose);
    throw new ApiError(502, 'We could not send the email. Please try again in a moment.');
  }
}

/** Checks an OTP. Deletes it on success, expiry or too many wrong tries. */
function consumeOtp(email, purpose, code) {
  const row = db.prepare('SELECT * FROM otps WHERE email = ? AND purpose = ?').get(email, purpose);
  const invalid = () => new ApiError(400, 'That code is incorrect or has expired.');
  if (!row) throw invalid();

  if (Date.now() > row.expires_at || row.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM otps WHERE email = ? AND purpose = ?').run(email, purpose);
    throw new ApiError(400, 'That code has expired. Request a new one.');
  }

  const given = Buffer.from(hashOtp(email, purpose, String(code || '').trim()));
  const stored = Buffer.from(row.code_hash);
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE email = ? AND purpose = ?').run(email, purpose);
    throw invalid();
  }
  db.prepare('DELETE FROM otps WHERE email = ? AND purpose = ?').run(email, purpose);
}

function startSession(res, user) {
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  university: u.university || uniLabel(u.email),
  createdAt: u.created_at,
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  try {
    const { sub } = jwt.verify(req.cookies.token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_verified = 1').get(sub);
    if (!user || !isStudentEmail(user.email)) throw new Error('not allowed');
    req.user = user;
    next();
  } catch {
    next(new ApiError(401, 'Please log in to continue.'));
  }
}

/* ------------------------------------------------------------------ */
/* App + routes                                                        */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again in a few minutes.' },
});
const api = express.Router();
api.use(authLimiter);

// 1. Sign up: creates an unverified account and emails an OTP
api.post(
  '/signup',
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;

    if (name.length < 2 || name.length > 60) throw new ApiError(400, 'Enter your name (2 to 60 characters).');
    if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address.');
    if (!isStudentEmail(email)) {
      throw new ApiError(400, 'Sign up with your university email address (for example, name@yourcollege.ac.in).');
    }
    const pwProblem = passwordProblem(password);
    if (pwProblem) throw new ApiError(400, pwProblem);

    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing && existing.is_verified) throw new ApiError(409, 'An account with this email already exists. Log in instead.');

    const hash = await bcrypt.hash(password, 12);
    let user;
    if (existing) {
      // Unverified leftover from an earlier attempt: update it and resend.
      db.prepare('UPDATE users SET name = ?, password_hash = ?, university = ? WHERE id = ?').run(name, hash, uniLabel(email), existing.id);
      user = { ...existing, name };
    } else {
      const info = db
        .prepare('INSERT INTO users (name, email, password_hash, university) VALUES (?, ?, ?, ?)')
        .run(name, email, hash, uniLabel(email));
      user = { id: info.lastInsertRowid, name, email };
    }

    await issueOtp(user, 'verify');
    res.status(201).json({ message: 'Account created. Check your email for a 6-digit code.', email });
  })
);

// 2. Verify email with OTP, then log the user in
api.post(
  '/verify-otp',
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) throw new ApiError(400, 'That code is incorrect or has expired.');

    consumeOtp(email, 'verify', req.body.otp);
    db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(user.id);
    startSession(res, user);
    res.json({ message: 'Email verified.', user: publicUser({ ...user, is_verified: 1 }) });
  })
);

// 3. Resend OTP (verify or reset)
api.post(
  '/resend-otp',
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const purpose = req.body.purpose === 'reset' ? 'reset' : 'verify';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    // Same response whether or not the account exists, to avoid leaking who is registered.
    const eligible = user && (purpose === 'reset' || !user.is_verified);
    if (eligible) await issueOtp(user, purpose);
    res.json({ message: 'If that account exists, a new code is on its way.' });
  })
);

// 4. Log in
api.post(
  '/login',
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) throw new ApiError(401, 'Incorrect email or password.');

    if (!isStudentEmail(user.email)) {
      throw new ApiError(403, 'This marketplace is for university students. Log in with your university email.');
    }

    if (!user.is_verified) {
      try {
        await issueOtp(user, 'verify');
      } catch (err) {
        if (err.status !== 429) throw err; // cooldown: a code was already sent recently
      }
      throw new ApiError(403, 'Verify your email to continue. We sent you a code.', { needsVerification: true, email });
    }

    startSession(res, user);
    res.json({ message: 'Logged in.', user: publicUser(user) });
  })
);

// 5. Forgot password: email an OTP
api.post(
  '/forgot-password',
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address.');
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_verified = 1').get(email);
    if (user) {
      try {
        await issueOtp(user, 'reset');
      } catch (err) {
        if (err.status !== 429) throw err;
      }
    }
    res.json({ message: 'If that account exists, we sent a code to your email.', email });
  })
);

// 6. Reset password with OTP
api.post(
  '/reset-password',
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const pwProblem = passwordProblem(req.body.newPassword);
    if (pwProblem) throw new ApiError(400, pwProblem);

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_verified = 1').get(email);
    if (!user) throw new ApiError(400, 'That code is incorrect or has expired.');

    consumeOtp(email, 'reset', req.body.otp);
    const hash = await bcrypt.hash(req.body.newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    res.json({ message: 'Password updated. You can log in now.' });
  })
);

// 7. Current user (protected)
api.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// 8. Log out
api.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: IS_PROD });
  res.json({ message: 'Logged out.' });
});

app.use('/api/auth', api);

/* ------------------------------------------------------------------ */
/* Marketplace (listings + messages), see marketplace.js               */
/* ------------------------------------------------------------------ */
registerMarketplace(app, { db, requireAuth, wrap, ApiError, sendMail });

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ message: err.message, ...err.extra });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid request body.' });
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on our side. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Allowed student email domains: ${ALLOWED_DOMAINS.join(', ')}`);
});
