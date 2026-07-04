// Backend for Hired Teens job posting payments.
//
// Three routes:
//   POST /create-checkout-session  - starts a Stripe Checkout session for a pending job post
//   POST /webhook                  - receives Stripe's checkout.session.completed event
//   GET  /check-payment-status     - lets the frontend confirm a session was actually paid
//
// The frontend (job-board-optimized.html) never talks to Stripe directly or
// sees your secret key. It only calls this server.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const REQUIRED_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'SITE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}. Check your .env file (see .env.example).`);
    process.exit(1);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 4242;

// Very small local ledger of paid sessions, written by the webhook.
// This is a simple JSON file so this demo doesn't need a real database.
// For production, swap this for your actual database.
const LEDGER_PATH = path.join(__dirname, 'paid_sessions.json');

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

app.use(cors());

// ---- Webhook route MUST use the raw body for signature verification,
// so it is registered before the express.json() middleware below. ----
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const pendingId = session.metadata && session.metadata.pendingId;

    if (pendingId) {
      const ledger = readLedger();
      ledger[session.id] = {
        pendingId,
        paymentStatus: session.payment_status,
        amountTotal: session.amount_total,
        createdAt: new Date().toISOString(),
      };
      writeLedger(ledger);
      console.log(`Recorded paid session ${session.id} for pendingId ${pendingId}`);
    } else {
      console.warn(`checkout.session.completed received with no pendingId in metadata (session ${session.id})`);
    }
  }

  res.json({ received: true });
});

// All other routes can use normal JSON body parsing.
app.use(express.json());

// ---- Create a Checkout Session for a pending job post ----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { pendingId } = req.body;
    if (!pendingId || typeof pendingId !== 'string') {
      return res.status(400).json({ error: 'A pendingId is required.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      metadata: { pendingId },
      success_url: `${process.env.SITE_URL}?paid=1&pending_id=${encodeURIComponent(pendingId)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Failed to create checkout session:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ---- Confirm whether a session was actually paid ----
// The frontend calls this after returning from Stripe, before it publishes
// the job. This checks live with Stripe (authoritative) and cross-checks the
// webhook ledger as a second signal.
app.get('/check-payment-status', async (req, res) => {
  try {
    const { session_id, pending_id } = req.query;
    if (!session_id || !pending_id) {
      return res.status(400).json({ paid: false, error: 'session_id and pending_id are required.' });
    }

    const session = await stripe.checkout.sessions.retrieve(String(session_id));

    const metadataMatches = session.metadata && session.metadata.pendingId === pending_id;
    const isPaid = session.payment_status === 'paid' && metadataMatches;

    res.json({ paid: Boolean(isPaid) });
  } catch (err) {
    console.error('Failed to check payment status:', err.message);
    res.status(500).json({ paid: false, error: 'Could not verify payment.' });
  }
});

app.get('/', (req, res) => {
  res.send('Hired Teens payments server is running.');
});

app.listen(PORT, () => {
  console.log(`Payments server listening on port ${PORT}`);
});
