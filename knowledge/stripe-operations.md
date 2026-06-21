# Stripe Operations

## Available Tools
boss_stripe_list_customers, boss_stripe_list_invoices, boss_stripe_list_payments,
boss_stripe_get_balance, boss_stripe_create_invoice

## Creating Products & Payment Links via bash
The tool set doesn't include create_product or create_payment_link yet. Use boss_bash:

```bash
# Create product
curl -s https://api.stripe.com/v1/products -u "$STRIPE_SECRET_KEY:" -d "name=Product Name"

# Create price
curl -s https://api.stripe.com/v1/prices -u "$STRIPE_SECRET_KEY:" \
  -d "product=prod_xxx" -d "unit_amount=100" -d "currency=usd"

# Create payment link
curl -s https://api.stripe.com/v1/payment_links -u "$STRIPE_SECRET_KEY:" \
  -d "line_items[0][price]=price_xxx" -d "line_items[0][quantity]=1"
```

## Mode
The current key is LIVE mode (sk_live_*). Real charges will process.
For testing, would need a separate test key (sk_test_*).
