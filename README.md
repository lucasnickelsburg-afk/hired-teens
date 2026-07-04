# Hired Teens — Backend (Job Storage + Payments)

A small server that does two things for the Hired Teens job board:

1. **Stores and serves all job listings** — the job board frontend has no storage of its own; every visitor's browser fetches the current listings from this server, and every new post is saved here.
2. **Charges employers a fee via Stripe** before their job post goes live.

It works like this:

1. An employer fills out "Post a role" and clicks "Publish role." The frontend sends the job details to this server, which starts a Stripe Checkout session and holds the job as a *pending* draft (not yet public).
2. The employer pays on Stripe's hosted checkout page — card details never touch this server or the frontend.
3. Once paid, this server publishes the job for real (triggered by Stripe's webhook, and confirmed again immediately when the employer is redirected back, so it works even if they close the tab right after paying).
4. From then on, every visitor's job board loads listings by asking this server for `/jobs`.

The frontend (`job-board-optimized.html`) never sees your Stripe secret key —
only this server does.

## 1. Install

```bash
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in:

- `STRIPE_SECRET_KEY` — from [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys). Start with a **test mode** key (`sk_test_...`) until you're ready to go live.
- `SITE_URL` — the full URL where your job board is hosted (e.g. `https://hiredteens.com` or wherever `job-board-optimized.html` lives).
- `JOB_POSTING_PRICE_CENTS` — how much to charge per job post, in cents. Defaults to `1000` ($10.00).

Leave `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` blank for now — the next two steps fill those in.

## 3. Create the product and price (one-time)

```bash
npm run setup-product
```

This creates a "Job Posting — Hired Teens" product in your Stripe account and prints a Price ID. Copy it into `STRIPE_PRICE_ID` in your `.env` file. You only need to do this once — if you change the price later, edit it directly in the Stripe Dashboard instead of re-running this.

## 4. Run the server

```bash
npm start
```

By default it listens on port `4242`. Deploy this anywhere that can run Node (Render, Railway, Fly.io, a VPS, etc.) — it needs to be reachable at a public URL for Stripe's webhook to reach it.

## 5. Set up the webhook

In your [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks), add an endpoint pointing at:

```
https://your-deployed-backend.com/webhook
```

Select the `checkout.session.completed` event. Stripe will give you a signing secret (`whsec_...`) — copy that into `STRIPE_WEBHOOK_SECRET` in your `.env`.

## 6. Point the frontend at this server

In `job-board-optimized.html`, find the `PAYMENTS_BACKEND_URL` constant near the top of the `<script>` block and set it to wherever you deployed this server, e.g.:

```js
const PAYMENTS_BACKEND_URL = 'https://your-deployed-backend.com';
```

## Going live

Everything above works in Stripe's test mode with test card numbers (e.g. `4242 4242 4242 4242`, any future expiry, any CVC). When you're ready to accept real payments:

1. Switch your Stripe Dashboard to **Live mode**.
2. Repeat steps 2–5 above using your live secret key — live and test mode have separate API keys, products, prices, and webhook secrets.

## How payment verification actually works

- When someone clicks "Publish role," the frontend calls `/create-checkout-session`, which creates a Stripe Checkout Session and returns its URL. The employer is redirected there to enter card details — card numbers never touch your server or the frontend.
- After payment, Stripe redirects the employer back to your site with a `session_id`.
- The frontend then calls `/check-payment-status`, which asks Stripe directly whether that session was actually paid before publishing the job. This is the authoritative check — it can't be faked by editing the URL.
- The `/webhook` route independently records successful payments and publishes the job as a backup path, in case the employer closes their browser tab before returning to your site.
- Both paths call the same publish logic, which is safe to run twice — a job is never published more than once even if both the webhook and the browser return trigger it.

## About data storage

This server stores everything in a few simple JSON files sitting next to the code (`jobs.json`, `pending_jobs.json`, `paid_sessions.json`). They're created automatically the first time the server runs, and they're excluded from Git (see `.gitignore`) since they're runtime data, not code.

This is intentionally simple so the project doesn't need a database to run. It's fine for getting started and for moderate traffic, but for a high-traffic production job board, you'd eventually want to swap these JSON files for a real database (Postgres, MongoDB, etc.) — the `readJobs`/`writeJobs`/`readPending`/`writePending` functions in `server.js` are the only places that would need to change.

**Important:** whatever host you deploy to needs to actually persist files written to disk across restarts and deploys (Bonto advertises this; check the same for whatever platform you use) — otherwise your job listings could disappear when the server restarts.
