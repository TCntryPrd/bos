/**
 * Stripe tool definitions for BOS brain tool calling.
 *
 * These BrainTool descriptors let the brain read customer and billing data
 * and create draft invoices.
 * Execution logic lives in executor.ts.
 *
 * Tools are only registered when STRIPE_SECRET_KEY is present in the environment.
 *
 * API base: https://api.stripe.com/v1/
 * Auth header: Authorization: Bearer <secret-key>
 * POST bodies use application/x-www-form-urlencoded (Stripe standard)
 */

import type { BrainTool } from '@boss/brain';

// ── Stripe tools ──────────────────────────────────────────────────────────────

export const stripeListCustomersTool: BrainTool = {
  name: 'boss_stripe_list_customers',
  description:
    'List recent Stripe customers. Returns customer name, email, ID, creation date, and default currency. Useful for looking up who is a customer before checking invoices or payments.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of customers to return (1–100). Defaults to 20.',
      },
      email: {
        type: 'string',
        description: 'Filter customers by exact email address.',
      },
    },
    required: [],
  },
};

export const stripeListInvoicesTool: BrainTool = {
  name: 'boss_stripe_list_invoices',
  description:
    'List recent Stripe invoices. Returns invoice number, customer name/email, amount, currency, status (draft/open/paid/void/uncollectible), and due date. Use this to check outstanding invoices or payment history.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of invoices to return (1–100). Defaults to 20.',
      },
      customer_id: {
        type: 'string',
        description: 'Filter invoices by Stripe customer ID (e.g. cus_xxxx).',
      },
      status: {
        type: 'string',
        enum: ['draft', 'open', 'paid', 'void', 'uncollectible'],
        description: 'Filter invoices by status. Omit to return all statuses.',
      },
    },
    required: [],
  },
};

export const stripeListPaymentsTool: BrainTool = {
  name: 'boss_stripe_list_payments',
  description:
    'List recent Stripe payments (charges). Returns amount, currency, status (succeeded/pending/failed), customer info, description, and date. Use this to see what payments have been collected.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of charges to return (1–100). Defaults to 20.',
      },
      customer_id: {
        type: 'string',
        description: 'Filter charges by Stripe customer ID (e.g. cus_xxxx).',
      },
    },
    required: [],
  },
};

export const stripeGetBalanceTool: BrainTool = {
  name: 'boss_stripe_get_balance',
  description:
    'Get the current Stripe account balance. Returns available and pending balances broken down by currency. Available funds can be paid out; pending funds are in transit.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const stripeCreateInvoiceTool: BrainTool = {
  name: 'boss_stripe_create_invoice',
  description:
    'Create a draft invoice in Stripe for a customer. Adds one invoice line item and saves as a draft (does not send or finalize). Returns the invoice ID and amount. You must finalize and send it separately.',
  parameters: {
    type: 'object',
    properties: {
      customer_id: {
        type: 'string',
        description: 'Stripe customer ID (e.g. cus_xxxx). The customer must already exist in Stripe.',
      },
      amount: {
        type: 'number',
        description: 'Amount in cents (e.g. 10000 = $100.00). Must be a positive integer.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code in lowercase (e.g. "usd", "eur"). Defaults to "usd".',
      },
      description: {
        type: 'string',
        description: 'Description for the invoice line item (e.g. "Consulting services — March 2026").',
      },
      due_days: {
        type: 'number',
        description: 'Number of days until payment is due (e.g. 30 = net-30). Defaults to 30.',
      },
    },
    required: ['customer_id', 'amount', 'description'],
  },
};

// ── Grouped exports ───────────────────────────────────────────────────────────

// Read-only Stripe tools — safe for autonomous use (balance and list queries)
export const READONLY_STRIPE_TOOLS: BrainTool[] = [
  stripeListCustomersTool,
  stripeListInvoicesTool,
  stripeListPaymentsTool,
  stripeGetBalanceTool,
];

// Write tools — require explicit user request
export const WRITE_STRIPE_TOOLS: BrainTool[] = [
  stripeCreateInvoiceTool,
];

// All Stripe tools — gated on STRIPE_SECRET_KEY presence in index.ts
export const ALL_STRIPE_TOOLS: BrainTool[] = [
  ...READONLY_STRIPE_TOOLS,
  ...WRITE_STRIPE_TOOLS,
];
