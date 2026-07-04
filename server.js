// Backend for Hired Teens: job storage + job posting payments.
//
// Routes:
//   GET    /jobs                      - returns all live, publicly-visible jobs
//   POST   /jobs/:id/report           - lets any visitor report a listing as suspicious
//   POST   /create-checkout-session   - validates a new job post and starts a Stripe Checkout session for it
//   POST   /webhook                   - receives Stripe's checkout.session.completed event, publishes the job
//   GET    /check-payment-status      - lets the frontend confirm + publish immediately on return from Stripe
//   GET    /admin/jobs                - (password-protected) all jobs, including ones pending approval
//   POST   /admin/jobs                - (password-protected) create a new listing directly, bypassing payment
//   PUT    /admin/jobs/:id            - (password-protected) edit an existing job's fields
//   DELETE /admin/jobs/:id            - (password-protected) remove a job entirely
//   POST   /admin/jobs/:id/approve    - (password-protected) approve a flagged job, making it publicly visible
//
// Newly-paid listings are automatically screened for two common job-scam red
// flags (a free/personal email domain, or common scam-related phrasing). A
// flagged listing is saved with status:'pending_approval' and is excluded
// from the public /jobs endpoint until an admin approves it — see
// getFlagReasons() and publishPendingJob() below.
//
// Every listing has a liveAt (when it actually became public) and an
// expiresAt (when it should stop appearing publicly), based on the post
// length the employer chose. For a listing that was flagged, that clock
// starts at approval time, not payment time — see computeExpiresAt() and the
// /admin/jobs/:id/approve route. Admins can directly edit expiresAt via
// PUT /admin/jobs/:id to extend or shorten a listing's remaining time.
//
// Admin routes require an `X-Admin-Password` header matching the ADMIN_PASSWORD
// environment variable. If ADMIN_PASSWORD isn't set, admin routes are disabled.
//
// CORS only allows browser requests from SITE_URL's own origin (see the
// allowedOrigins block below). Several endpoints are also rate-limited per
// IP — most notably repeated wrong admin passwords, listing reports, and
// checkout session creation — to blunt brute-forcing and spam/abuse.
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
const rateLimit = require('express-rate-limit');
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

// Admin password is optional but strongly recommended — without it, the
// admin edit/delete routes below simply refuse all requests.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD is not set — the admin panel routes will be disabled until it is configured.');
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin access is not configured on this server.' });
  }
  const provided = req.headers['x-admin-password'];
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  next();
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  timeout: 15000,       // fail fast instead of hanging indefinitely on a slow/blocked network path
  maxNetworkRetries: 2, // retries transient network errors automatically
});
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

// ---- Automatic flagging: catches the two most common red flags in job scams
// so a human reviews them before the listing goes live, rather than trying to
// block them outright (avoiding false positives on legitimate postings). ----
const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'protonmail.com', 'mail.com', 'live.com', 'msn.com',
  'gmx.com', 'yandex.com', 'zoho.com',
];

const SCAM_KEYWORDS = [
  'wire transfer', 'processing fee', 'registration fee', 'training fee',
  'equipment fee', 'starter kit', 'bank details', 'routing number',
  'western union', 'moneygram', 'money gram', 'gift card', 'gift cards',
  'upfront payment', 'pay to apply', 'pay a fee', 'send us your bank',
  'cash the check', 'deposit this check', 'social security number',
  'venmo', 'cashapp', 'cash app', 'zelle',
];

function getFlagReasons(job) {
  const reasons = [];

  const emailDomain = (job.email || '').split('@')[1]?.toLowerCase().trim();
  if (emailDomain && FREE_EMAIL_DOMAINS.includes(emailDomain)) {
    reasons.push(`Uses a free/personal email domain (${emailDomain}) rather than a business address.`);
  }

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const matchedKeywords = SCAM_KEYWORDS.filter(kw => haystack.includes(kw));
  if (matchedKeywords.length) {
    reasons.push(`Contains language commonly seen in job scams: ${matchedKeywords.map(k => `"${k}"`).join(', ')}.`);
  }

  return reasons;
}

// A listing's clock only starts once it's actually visible to the public —
// for a listing held for approval, that's the approval moment, not the
// original payment moment. Returns null (never expires) if postLength is
// missing or invalid, e.g. for admin-created listings that don't go through
// the post-length dropdown.
function computeExpiresAt(liveAt, postLength) {
  const days = parseInt(postLength, 10);
  if (!days || Number.isNaN(days)) return null;
  return liveAt + days * 24 * 60 * 60 * 1000;
}

// Moves a pending draft into the jobs list, exactly once. Safe to call
// multiple times for the same pendingId (from both the webhook and the
// frontend's status check) without creating duplicate listings. Jobs that
// trip a scam-language or free-email flag are stored with
// status:'pending_approval' instead of 'live', so they're held back from the
// public /jobs endpoint until an admin approves them.
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
  const flagReasons = getFlagReasons(draft.job);
  const isLive = flagReasons.length === 0;
  const now = Date.now();
  const newJob = {
    ...draft.job,
    id: 'job-' + now + '-' + Math.random().toString(36).slice(2, 8),
    postedAt: now,
    status: isLive ? 'live' : 'pending_approval',
    ...(flagReasons.length ? { flagReasons } : {}),
    // liveAt/expiresAt are only set once the listing is actually public —
    // for a flagged listing, these get set later, in the /approve route.
    ...(isLive ? { liveAt: now, expiresAt: computeExpiresAt(now, draft.job.postLength) } : {}),
  };
  jobs.push(newJob);
  writeJobs(jobs);

  pending[pendingId] = { ...draft, status: 'published', publishedJobId: newJob.id };
  writePending(pending);

  if (flagReasons.length) {
    console.log(`Job ${newJob.id} from pendingId ${pendingId} held for admin approval:`, flagReasons);
  } else {
    console.log(`Published job ${newJob.id} from pendingId ${pendingId}`);
  }
  return newJob;
}

// ---- CORS: only allow browser requests from the site's own domain ----
// (SITE_URL is already a required env var, so we derive the allowed origin
// from it rather than hardcoding a domain here.) Requests with no Origin
// header at all (server-to-server calls, curl, and some cases of opening a
// local HTML file directly) are still allowed through, since CORS is a
// browser-enforced protection and doesn't apply to non-browser callers.
const allowedOrigins = [];
try {
  allowedOrigins.push(new URL(process.env.SITE_URL).origin);
} catch (err) {
  console.warn('Could not parse SITE_URL as a URL for the CORS allowlist:', err.message);
}
console.log('CORS allowed origins:', allowedOrigins.length ? allowedOrigins : '(none configured)');

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`CORS blocked request from origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
}));

// Without this, a CORS rejection above falls through to Express's default
// error handler and comes back as a generic, unhelpful 500.
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Not allowed by CORS.' });
  }
  next(err);
});

// ---- Rate limiting ----
// A light global limiter as a general backstop against abusive traffic...
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ...plus tighter limiters on the specific endpoints most worth protecting.
// skipSuccessfulRequests on the admin one means a legitimate admin doing
// lots of normal work never gets rate-limited — only repeated *wrong*
// passwords count toward the limit, which is what actually matters here.
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed admin login attempts. Please try again later.' },
});

const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reports from this connection. Please try again later.' },
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a while.' },
});

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
// Raised from Express's 100kb default so job posts with a logo image
// (encoded as a base64 data URL) aren't rejected before they're even read.
app.use(express.json({ limit: '2mb' }));

// ---- Public job listings ----
app.get('/jobs', (req, res) => {
  // Jobs awaiting admin approval (flagged for scam language or a free email
  // domain) are excluded here entirely — they only become visible once an
  // admin approves them. Expired listings (past their expiresAt) are
  // excluded the same way. A missing expiresAt means "never expires" —
  // that's the case for older listings and admin-created ones without a
  // post length. posterName, flagReasons, status, and reports are
  // internal/admin-only fields and are never sent to the public frontend.
  const now = Date.now();
  const publicJobs = readJobs()
    .filter(job => job.status !== 'pending_approval')
    .filter(job => !job.expiresAt || job.expiresAt > now)
    .map(({ posterName, flagReasons, status, reports, ...rest }) => rest);
  res.json(publicJobs);
});

// ---- Public: report a listing as suspicious ----
// Intentionally doesn't require a password (any visitor should be able to
// report something) and intentionally doesn't remove or hide the listing —
// a report just surfaces the listing for admin attention, so a single
// malicious report can't be used to take down a legitimate posting.
const MAX_REPORT_REASON_LENGTH = 500;

app.post('/jobs/:id/report', reportLimiter, (req, res) => {
  const jobs = readJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Listing not found.' });
  }

  let reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length > MAX_REPORT_REASON_LENGTH) {
    reason = reason.slice(0, MAX_REPORT_REASON_LENGTH);
  }

  if (!Array.isArray(job.reports)) job.reports = [];
  job.reports.push({ reason, reportedAt: new Date().toISOString() });
  writeJobs(jobs);

  console.log(`[report] listing ${job.id} reported (${job.reports.length} total report(s))`);
  res.json({ reported: true });
});

// ---- Admin: view all jobs (same data as /jobs, but behind a password —
// kept separate so the public endpoint's shape/behavior never has to change) ----
app.get('/admin/jobs', adminAuthLimiter, requireAdmin, (req, res) => {
  res.json(readJobs());
});

// ---- Admin: create a new job listing directly, bypassing payment ----
app.post('/admin/jobs', adminAuthLimiter, requireAdmin, (req, res) => {
  const {
    posterName, title, company, location, type, salary, payType,
    startDate, endDate, email, link, description, tags, logo, expiresAt,
  } = req.body;

  const salaryRequired = payType !== 'unpaid';
  if (!title || !company || !location || !description || !email || (salaryRequired && !salary)) {
    return res.status(400).json({ error: 'Please fill in title, business or organization name, location, pay, email, and description.' });
  }

  const jobs = readJobs();
  const now = Date.now();
  const newJob = {
    posterName, title, company, location, type, salary, payType,
    startDate, endDate, email, link, description, logo,
    tags: tags || [],
    id: 'job-' + now + '-' + Math.random().toString(36).slice(2, 8),
    postedAt: now,
    liveAt: now,
    expiresAt: expiresAt || null,
  };
  jobs.push(newJob);
  writeJobs(jobs);

  console.log(`[admin] created job ${newJob.id}`);
  res.status(201).json(newJob);
});

// ---- Admin: edit an existing job's details ----
const EDITABLE_JOB_FIELDS = [
  'posterName', 'title', 'company', 'location', 'type', 'salary', 'payType',
  'startDate', 'endDate', 'email', 'link', 'description', 'tags', 'logo', 'expiresAt',
];

app.put('/admin/jobs/:id', adminAuthLimiter, requireAdmin, (req, res) => {
  const jobs = readJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  for (const field of EDITABLE_JOB_FIELDS) {
    if (field in req.body) {
      job[field] = req.body[field];
    }
  }

  writeJobs(jobs);
  console.log(`[admin] updated job ${job.id}`);
  res.json(job);
});

// ---- Admin: remove a job entirely ----
app.delete('/admin/jobs/:id', adminAuthLimiter, requireAdmin, (req, res) => {
  const jobs = readJobs();
  const index = jobs.findIndex(j => j.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const [removed] = jobs.splice(index, 1);
  writeJobs(jobs);
  console.log(`[admin] deleted job ${removed.id}`);
  res.json({ deleted: true, job: removed });
});

// ---- Admin: approve a flagged job, making it publicly visible ----
app.post('/admin/jobs/:id/approve', adminAuthLimiter, requireAdmin, (req, res) => {
  const jobs = readJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const now = Date.now();
  job.status = 'live';
  job.liveAt = now;
  job.expiresAt = computeExpiresAt(now, job.postLength);
  writeJobs(jobs);
  console.log(`[admin] approved job ${job.id}, now expires at ${job.expiresAt ? new Date(job.expiresAt).toISOString() : 'never'}`);
  res.json(job);
});

// Allowed post lengths and how many "listing units" each one costs.
// 30 days = 1x the base price; every additional 30-day increment adds
// another full unit (60 days = 2x, 90 days = 3x, 120 days = 4x).
const VALID_POST_LENGTHS = [30, 60, 90, 120];

function postLengthToQuantity(postLength) {
  const days = parseInt(postLength, 10);
  if (!VALID_POST_LENGTHS.includes(days)) return null;
  return days / 30;
}

// ---- Validate a new job post and start a Checkout Session for it ----
const MAX_LOGO_DATA_URL_LENGTH = 400 * 1024; // ~400KB as a base64 string; the
// frontend resizes/compresses images before upload, so a legitimate logo
// should be well under this — this is mainly a defense-in-depth backstop.

app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
  console.log('[create-checkout-session] request received');
  try {
    const {
      posterName, title, company, location, type, salary, payType,
      startDate, endDate, postLength, email, link, description, tags, logo,
    } = req.body;

    if (!posterName || !title || !company || !location || !description || !email || !salary) {
      console.log('[create-checkout-session] rejected: missing required fields');
      return res.status(400).json({ error: 'Please fill in your name, title, business or organization name, location, pay, email, and description.' });
    }

    if (logo && (typeof logo !== 'string' || !logo.startsWith('data:image/') || logo.length > MAX_LOGO_DATA_URL_LENGTH)) {
      console.log('[create-checkout-session] rejected: invalid or oversized logo');
      return res.status(400).json({ error: 'That logo image is invalid or too large. Please try a smaller image.' });
    }

    const quantity = postLengthToQuantity(postLength);
    if (!quantity) {
      console.log('[create-checkout-session] rejected: invalid postLength', postLength);
      return res.status(400).json({ error: 'Please choose a valid post length.' });
    }

    const pendingId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    const pending = readPending();
    pending[pendingId] = {
      status: 'awaiting_payment',
      createdAt: new Date().toISOString(),
      job: {
        posterName, title, company, location, type, salary, payType,
        startDate, endDate, postLength, email, link, description, logo,
        tags: tags || [],
      },
    };
    writePending(pending);

    console.log(`[create-checkout-session] calling Stripe API (postLength=${postLength}, quantity=${quantity})...`);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity,
        },
      ],
      metadata: { pendingId },
      success_url: `${process.env.SITE_URL}?paid=1&pending_id=${encodeURIComponent(pendingId)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}?canceled=1`,
    });
    console.log('[create-checkout-session] Stripe API responded, session:', session.id);

    res.json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout-session] FAILED:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ---- Confirm whether a session was actually paid, and publish if so ----
// Authoritative check: asks Stripe directly rather than trusting the URL.
app.get('/check-payment-status', async (req, res) => {
  console.log('[check-payment-status] request received');
  try {
    const { session_id, pending_id } = req.query;
    if (!session_id || !pending_id) {
      return res.status(400).json({ paid: false, error: 'session_id and pending_id are required.' });
    }

    console.log('[check-payment-status] calling Stripe API...');
    const session = await stripe.checkout.sessions.retrieve(String(session_id));
    console.log('[check-payment-status] Stripe API responded, payment_status:', session.payment_status);

    const metadataMatches = session.metadata && session.metadata.pendingId === pending_id;
    const isPaid = session.payment_status === 'paid' && metadataMatches;

    if (!isPaid) {
      return res.json({ paid: false });
    }

    const job = publishPendingJob(String(pending_id));
    // Don't leak the specific flag reasons (e.g. matched scam keywords) back
    // to whoever submitted the listing — just let the frontend know it needs
    // review rather than treating it as immediately live.
    const { flagReasons, ...jobForCustomer } = job || {};
    res.json({ paid: true, job: jobForCustomer, pendingApproval: job?.status === 'pending_approval' });
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
