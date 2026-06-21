/**
 * Financial Ingest — scans Stripe/revenue patterns,
 * customer lists, invoice cadence, and payment history.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngester, PlatformName } from './sprint.js';
import type { PlatformIngestResult, IngestPattern, ProgressTracker } from './progress.js';

// ── Types ───────────────────────────────────────────────────────────

export interface FinancialIngestConfig {
  /** Months of transaction history. Default 12. */
  lookbackMonths?: number;
}

export interface RevenueEntry {
  id: string;
  customerId: string;
  customerName: string;
  amount: number;
  currency: string;
  type: 'subscription' | 'one-time' | 'invoice';
  status: 'paid' | 'pending' | 'overdue' | 'refunded' | 'disputed';
  createdAt: Date;
  paidAt?: Date;
}

export interface CustomerSummary {
  id: string;
  name: string;
  totalRevenue: number;
  transactionCount: number;
  avgPaymentDays: number;
  isSubscription: boolean;
}

// ── Ingester ────────────────────────────────────────────────────────

export class FinancialIngester implements PlatformIngester {
  readonly platform: PlatformName = 'financial';
  private lookbackMonths: number;

  constructor(config: FinancialIngestConfig = {}) {
    this.lookbackMonths = config.lookbackMonths ?? 12;
  }

  async ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult> {
    tracker.updateProgress('financial', 0, 0, 'Scanning financial records...');

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - this.lookbackMonths);

    const entries = await this.fetchRevenue(ctx, cutoff);
    const total = entries.length;
    tracker.updateProgress('financial', 0, total, `Found ${total} transactions to analyze`);

    // Build customer map
    const customers = new Map<string, CustomerSummary>();
    const monthlyRevenue = new Map<string, number>();
    let refundCount = 0;
    let disputeCount = 0;
    let subscriptionRevenue = 0;
    let oneTimeRevenue = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Customer aggregation
      const existing = customers.get(entry.customerId) ?? {
        id: entry.customerId,
        name: entry.customerName,
        totalRevenue: 0,
        transactionCount: 0,
        avgPaymentDays: 0,
        isSubscription: false,
      };
      existing.totalRevenue += entry.amount;
      existing.transactionCount++;
      if (entry.type === 'subscription') existing.isSubscription = true;
      customers.set(entry.customerId, existing);

      // Monthly revenue
      const monthKey = `${entry.createdAt.getFullYear()}-${String(entry.createdAt.getMonth() + 1).padStart(2, '0')}`;
      monthlyRevenue.set(monthKey, (monthlyRevenue.get(monthKey) ?? 0) + entry.amount);

      // Status tracking
      if (entry.status === 'refunded') refundCount++;
      if (entry.status === 'disputed') disputeCount++;
      if (entry.type === 'subscription') subscriptionRevenue += entry.amount;
      if (entry.type === 'one-time') oneTimeRevenue += entry.amount;

      if ((i + 1) % 100 === 0) {
        tracker.updateProgress('financial', i + 1, total, `Analyzed ${i + 1} of ${total} transactions`);
      }
    }

    tracker.updateProgress('financial', total, total, 'Analysis complete');

    const patterns = this.buildPatterns(
      customers, monthlyRevenue, refundCount, disputeCount,
      subscriptionRevenue, oneTimeRevenue, total,
    );

    return {
      platform: 'financial',
      itemsProcessed: total,
      patterns,
      metadata: {
        totalTransactions: total,
        uniqueCustomers: customers.size,
        totalRevenue: subscriptionRevenue + oneTimeRevenue,
        subscriptionRevenue,
        oneTimeRevenue,
        refundCount,
        disputeCount,
        monthsCovered: monthlyRevenue.size,
      },
    };
  }

  // ── Connector stubs ───────────────────────────────────────────────

  private async fetchRevenue(_ctx: TenantContext, _since: Date): Promise<RevenueEntry[]> {
    // TODO: wire to Stripe connector
    return [];
  }

  // ── Pattern building ──────────────────────────────────────────────

  private buildPatterns(
    customers: Map<string, CustomerSummary>,
    monthlyRevenue: Map<string, number>,
    refundCount: number,
    disputeCount: number,
    subscriptionRevenue: number,
    oneTimeRevenue: number,
    totalTransactions: number,
  ): IngestPattern[] {
    const patterns: IngestPattern[] = [];

    if (totalTransactions === 0) return patterns;

    // Revenue mix
    const totalRev = subscriptionRevenue + oneTimeRevenue;
    if (totalRev > 0) {
      const subPct = Math.round((subscriptionRevenue / totalRev) * 100);
      patterns.push({
        category: 'financial.revenue',
        description: `Revenue mix: ${subPct}% subscription, ${100 - subPct}% one-time`,
        confidence: 0.9,
        evidence: [
          `Subscription revenue: $${subscriptionRevenue.toLocaleString()}`,
          `One-time revenue: $${oneTimeRevenue.toLocaleString()}`,
        ],
      });
    }

    // Monthly trend
    const months = Array.from(monthlyRevenue.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    if (months.length >= 2) {
      const avgMonthly = Math.round(
        months.reduce((sum, [, rev]) => sum + rev, 0) / months.length,
      );
      patterns.push({
        category: 'financial.trend',
        description: `Average monthly revenue: $${avgMonthly.toLocaleString()}`,
        confidence: 0.8,
        evidence: months.slice(-6).map(([month, rev]) => `${month}: $${rev.toLocaleString()}`),
      });
    }

    // Top customers
    const topCustomers = Array.from(customers.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 10);

    if (topCustomers.length > 0) {
      patterns.push({
        category: 'financial.customers',
        description: `${customers.size} customers, top ${topCustomers.length} by revenue`,
        confidence: 0.9,
        evidence: topCustomers.map(
          (c) => `${c.name}: $${c.totalRevenue.toLocaleString()} (${c.transactionCount} transactions)`,
        ),
      });
    }

    // Risk indicators
    if (refundCount > 0 || disputeCount > 0) {
      const refundRate = Math.round((refundCount / totalTransactions) * 100);
      const disputeRate = Math.round((disputeCount / totalTransactions) * 100);
      patterns.push({
        category: 'financial.risk',
        description: 'Payment issue rates',
        confidence: 0.85,
        evidence: [
          `Refund rate: ${refundRate}% (${refundCount} refunds)`,
          `Dispute rate: ${disputeRate}% (${disputeCount} disputes)`,
        ],
      });
    }

    return patterns;
  }
}
