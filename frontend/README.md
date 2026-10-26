# CampusGigs: a students-only services marketplace

Node.js + Express + SQLite. Students sign up with a university email, verify it with an emailed OTP,
then post services they offer (or need) and message each other. No payments in this version.

## Run it

```
npm install
copy .env.example .env      # Mac/Linux: cp .env.example .env
npm start
```

Open http://localhost:3000. Everything you set up earlier (JWT_SECRET, SMTP) is unchanged.

### New settings in `.env`
- `ALLOWED_EMAIL_DOMAINS`: which email domains may sign up. Default `.edu,.edu.in,.ac.in`.
  Add your own university's domain if it isn't covered (for example `mdu.ac.in`).
  To test with a Gmail address, temporarily add `gmail.com`, and remove it before real use.
- `APP_URL`: your site address, used for links in notification emails.

Restart the server after changing `.env`.

## Pages
| Address | What it is |
|---|---|
| `/` | Log in, sign up, OTP, password reset |
| `/app.html` | The marketplace (after login) |

Inside the marketplace: browse and search, filters (offering / looking for, category, only my university),
listing detail with a message box, post and edit a service, my listings, and a messages inbox.

## API (all under `/api`, all need a logged-in student except `/auth/*`)
| Method | Route | What it does |
|---|---|---|
| GET | `/meta` | Categories and limits |
| GET | `/listings?q=&category=&kind=&sort=&uni=&page=` | Browse and search active listings |
| GET | `/listings/mine` | Your own listings |
| GET | `/listings/:id` | One listing |
| POST | `/listings` | Create a listing |
| PUT | `/listings/:id` | Edit (owner only) |
| PATCH | `/listings/:id/status` | Close or reopen (owner only) |
| DELETE | `/listings/:id` | Delete with its messages (owner only) |
| POST | `/messages` | Send a message (`listingId`, `body`, and `toUserId` when the owner replies) |
| GET | `/messages/threads` | Your conversations |
| GET | `/messages/thread?listingId=&userId=` | One conversation (marks it read) |
| GET | `/messages/unread-count` | Unread badge number |

## How "students only" works
1. Signup and login only accept emails from `ALLOWED_EMAIL_DOMAINS`.
2. The emailed OTP proves the person controls that address.
3. Every marketplace request re-checks the domain, so old accounts with other emails are locked out.

## Files
- `server.js`: accounts, OTP, sessions, student-email rule
- `marketplace.js`: listings and messages
- `public/index.html`: login/signup page
- `public/app.html`, `app.css`, `app.js`: the marketplace
- `data.db`: created automatically on first run. Delete it to start fresh.

## Ideas for next steps
Listing photos, reporting and admin moderation, ratings and reviews after a job, saved/favourite listings,
and real payments (for example Razorpay) once you're ready.
