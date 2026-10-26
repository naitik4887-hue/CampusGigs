# CampusGigs

A students-only community: hire students for **services**, and buy or sell things in the **Marketplace**.
Node.js + Express + SQLite. No build step.

## Run it

```
npm install
copy .env.example .env      # Mac/Linux: cp .env.example .env
npm start
```

Open http://localhost:3000. Restart the server (Ctrl + C, then `npm start`) after changing `.env`.

## What's in it

| Address | What it is |
|---|---|
| `/` | Landing page (public) |
| `/login.html` | Log in, sign up (college email + OTP), password reset |
| `/app.html` | The app (after login) |

Inside the app:
- **Services**: post what you offer or need, browse, search, filter, message.
- **Marketplace**: sell and buy items with photos, condition, price and pickup spot.
  Anyone can browse. **Selling and messaging sellers needs a verified college ID.**
- **Messages**: one inbox for both sections. Instant-feeling sending, "Seen" receipts, unread badge.
- **My listings**, **Verify college ID**, and (for admins) **Review ID requests**.

## Settings in `.env`

| Setting | Purpose |
|---|---|
| `JWT_SECRET` | Required. Long random string. |
| `SMTP_*`, `MAIL_FROM` | Sending email (OTP codes, message alerts, verification results). Without them, emails print in the terminal. |
| `ALLOWED_EMAIL_DOMAINS` | Which college email domains may sign up. |
| `ADMIN_EMAILS` | Who can approve or reject ID verifications. Your own email goes here. |
| `APP_URL` | Your site's address, used in email links. |

## How college ID verification works

1. A student opens **Verify college ID**, enters their college and ID number, and uploads a photo of the card.
   The browser shrinks the photo before sending it.
2. An admin opens **Review ID requests**, looks at the photo and approves or rejects it (a reason is required for rejections).
3. The photo is **deleted as soon as the review is done**. Only the ID number and the decision are kept, so one card can't be used on two accounts.
4. The student gets an email, and (if approved) can sell items and message sellers.

ID photos are stored in `storage/` (never in `public/`) and are only served to admins.

## API (all under `/api`)

Auth routes are under `/api/auth/*`. Everything else needs a logged-in student.

| Method | Route | What it does |
|---|---|---|
| GET | `/meta` | Categories and limits |
| GET | `/listings?section=service\|item&q=&category=&kind=&condition=&minPrice=&maxPrice=&sort=&uni=&page=` | Browse and search |
| GET | `/listings/mine` | Your listings (both sections) |
| GET | `/listings/:id` | One listing (with photos) |
| POST | `/listings` | Create (`section: 'item'` needs ID verification) |
| PUT | `/listings/:id` | Edit (owner) |
| PATCH | `/listings/:id/status` | Close / mark sold / reopen (owner) |
| DELETE | `/listings/:id` | Delete with photos and messages (owner) |
| POST | `/uploads` | Upload one JPEG (raw bytes, `Content-Type: image/jpeg`) |
| GET | `/uploads/:id` | Show a photo |
| POST | `/messages` | Send a message (item messages need ID verification) |
| GET | `/messages/threads` | Your conversations |
| GET | `/messages/thread?listingId=&userId=` | One conversation (marks it read) |
| GET | `/messages/unread-count` | Unread badge number |
| GET | `/verification` | My verification status |
| POST | `/verification/photo` | Upload the ID photo (raw JPEG) |
| POST | `/verification` | Submit `{ college, idNumber }` for review |
| GET | `/admin/verifications` | Pending requests (admin) |
| GET | `/admin/verifications/:userId/photo` | The ID photo (admin) |
| POST | `/admin/verifications/:userId/decision` | `{ decision: 'approve'\|'reject', note }` (admin) |

## Files

```
server.js            accounts, OTP, sessions, student-email rule
marketplace.js       listings + messages
uploads.js           item photos
verification.js      college ID verification + admin review
public/
  index.html         landing page          (landing.css, landing.js)
  login.html         login and sign up
  app.html           the app shell         (app.css, app.js)
  base.css           shared design system
  js/                core, browse, detail, forms, account, inbox
data.db              database (created automatically; delete to start fresh)
storage/             uploaded photos (created automatically)
```

## Before going live
- Use HTTPS and set `NODE_ENV=production`; generate a fresh `JWT_SECRET`
- Remove `gmail.com` from `ALLOWED_EMAIL_DOMAINS`
- Use a real mail provider with a verified domain
- Back up `data.db` and `storage/`
- Think about who your admins are: they see students' ID cards
