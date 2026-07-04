// Backend for Hired Teens: job storage + job posting payments.
//
// Routes:
//   GET  /jobs                      - returns all published jobs (the job board's data source)
//   POST /create-checkout-session   - validates a new job post and starts a Stripe Checkout session for it
//   POST /webhook                   - receives Stripe's checkout.session.completed event, publishes the job
//   GET  /check-payment-status      - lets the frontend confirm + publish immediately on return from Stripe
//
// The frontend (job-board-optimized.html) never talks to Stripe directly, never
// sees your secret key, and never stores job data itself — this server is the
// single source of truth for job listings.
//
// Storage here uses simple JSON files so this doesn't require a database to
// run. For real production traffic, swap readJobs/writeJobs (and the pending
// equivalents) for calls to a real database.

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

// Note: these deliberately do NOT end in .json — nodemon (used by some hosts,
// including Bonto, for auto-restart-on-change) watches .json files by
// default, and since this server writes to these files as part of normal
// request handling, using a .json extension here would make nodemon think
// the code changed and restart the server mid-request. The contents are
// still plain JSON internally — only the file extension differs.
const JOBS_PATH = path.join(__dirname, 'jobs.store');
const PENDING_PATH = path.join(__dirname, 'pending_jobs.store');
const LEDGER_PATH = path.join(__dirname, 'paid_sessions.store');

const SEED_JOBS = [
  {id:'seed-1', title:'Barista', company:'Fernwood Coffee Roasters', location:'Downtown', type:'onsite', salary:'$16/hr + tips', payType:'hourly', tags:['Weekends','No experience needed','Training provided'], description:'Weekend and after-school shifts making espresso drinks and helping customers. We train you — just bring a good attitude and reliability.', email:'hiring@fernwoodcoffee.com', link:'https://fernwoodcoffee.com/careers/apply', postedAt: Date.now() - 86400000*1},
  {id:'seed-2', title:'Math Tutor (Algebra & Geometry)', company:'Bright Path Tutoring', location:'Remote', type:'remote', salary:'$20/hr', payType:'hourly', tags:['Flexible hours','Online','Must be strong in math'], description:'Help middle schoolers with algebra and geometry homework over video call. Set your own hours around school and sports.', email:'tutors@brightpathtutoring.com', postedAt: Date.now() - 86400000*3},
  {id:'seed-3', title:'Lifeguard', company:'Cedar Lake Community Pool', location:'Cedar Lake', type:'onsite', salary:'$17/hr', payType:'hourly', tags:['Summer','Certification required','Outdoors'], description:'Seasonal lifeguard position for summer break. Must have current lifeguard certification or be willing to complete training before June.', email:'jobs@cedarlakepool.org', postedAt: Date.now() - 86400000*6},
  {id:'seed-4', title:'Retail Associate', company:'Maple & Co.', location:'Westfield Mall', type:'onsite', salary:'$15.50/hr', payType:'hourly', tags:['Evenings','Weekends','Retail'], description:'Fold, restock, and help customers at our mall storefront. Evening and weekend shifts available around your school schedule.', email:'careers@mapleandco.com', link:'https://mapleandco.com/apply', postedAt: Date.now() - 86400000*2},
];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJobs() {
  return readJson(JOBS_PATH, null) ?? (writeJson(JOBS_PATH, SEED_JOBS), SEED_JOBS);
}

function writeJobs(jobs) {
  writeJson(JOBS_PATH, jobs);
}

function readPending() {
  return readJson(PENDING_PATH, {});
}

function writePending(pending) {
  writeJson(PENDING_PATH, pending);
}

function readLedger() {
  return readJson(LEDGER_PATH, {});
}

function writeLedger(ledger) {
  writeJson(LEDGER_PATH, ledger);
}

// Moves a pending draft into the public jobs list, exactly once. Safe to call
// multiple times for the same pendingId (from both the webhook and the
// frontend's status check) without creating duplicate listings.
function publishPendingJob(pendingId) {
  if (!pendingId) return null;

  const pending = readPending();
  const draft = pending[pendingId];
  if (!draft) return null;

  if (draft.status === 'published') {
    const jobs = readJobs();
    return jobs.find(j => j.id === draft.publishedJobId) || null;
  }

  const jobs = readJobs();
  const newJob = {
    ...draft.job,
    id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    postedAt: Date.now(),
  };
  jobs.push(newJob);
  writeJobs(jobs);

  pending[pendingId] = { ...draft, status: 'published', publishedJobId: newJob.id };
  writePending(pending);

  console.log(`Published job ${newJob.id} from pendingId ${pendingId}`);
  return newJob;
}

app.use(cors({ origin: true }));

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

      if (session.payment_status === 'paid') {
        publishPendingJob(pendingId);
      }
    } else {
      console.warn(`checkout.session.completed received with no pendingId in metadata (session ${session.id})`);
    }
  }

  res.json({ received: true });
});

// All other routes can use normal JSON body parsing.
app.use(express.json());

// ---- Public job listings ----
app.get('/jobs', (req, res) => {
  res.json(readJobs());
});

// ---- Validate a new job post and start a Checkout Session for it ----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const {
      title, company, location, type, salary, payType,
      startDate, endDate, postLength, email, link, description, tags,
    } = req.body;

    if (!title || !company || !location || !description || !salary || !email) {
      return res.status(400).json({ error: 'Please fill in title, business or organization name, location, pay, email, and description.' });
    }

    const pendingId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    const pending = readPending();
    pending[pendingId] = {
      status: 'awaiting_payment',
      createdAt: new Date().toISOString(),
      job: {
        title, company, location, type, salary, payType,
        startDate, endDate, postLength, email, link, description,
        tags: tags || [],
      },
    };
    writePending(pending);

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

// ---- Confirm whether a session was actually paid, and publish if so ----
// Authoritative check: asks Stripe directly rather than trusting the URL.
app.get('/check-payment-status', async (req, res) => {
  try {
    const { session_id, pending_id } = req.query;
    if (!session_id || !pending_id) {
      return res.status(400).json({ paid: false, error: 'session_id and pending_id are required.' });
    }

    const session = await stripe.checkout.sessions.retrieve(String(session_id));

    const metadataMatches = session.metadata && session.metadata.pendingId === pending_id;
    const isPaid = session.payment_status === 'paid' && metadataMatches;

    if (!isPaid) {
      return res.json({ paid: false });
    }

    const job = publishPendingJob(String(pending_id));
    res.json({ paid: true, job });
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
