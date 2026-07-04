// Run this ONCE to create the "Job Posting" product and its price in your
// Stripe account. Copy the printed price ID into STRIPE_PRICE_ID in your .env
// file. You do not need to run this again after that.
//
// Usage:
//   npm install
//   cp .env.example .env   (then fill in STRIPE_SECRET_KEY)
//   npm run setup-product

require('dotenv').config();
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY in your .env file. Copy .env.example to .env and fill it in first.');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const priceCents = parseInt(process.env.JOB_POSTING_PRICE_CENTS || '1000', 10);

async function createProduct() {
  const product = await stripe.products.create({
    name: 'Job Posting — Hired Teens',
    description: 'Fee to publish one job listing on the Hired Teens job board.',
    default_price_data: {
      currency: 'usd',
      unit_amount: priceCents,
    },
  });

  console.log('\nProduct and price created successfully.\n');
  console.log('Product ID:', product.id);
  console.log('Price ID:  ', product.default_price);
  console.log('\nNext step: copy the Price ID above into STRIPE_PRICE_ID in your .env file.\n');
}

createProduct().catch((err) => {
  console.error('Failed to create product:', err.message);
  process.exit(1);
});
