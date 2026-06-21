/**
 * AirtableWorkspace — browse bases, tables, and records.
 *
 * Three-level drill-down:
 *   1. Base list (default view)
 *   2. Click base -> table list with field schemas
 *   3. Click table -> records in a simple grid
 */

import React, { useState, useCallback } from 'react';
import { Table2, ChevronRight, ChevronLeft, Loader2, RefreshCw, Database, Columns } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { cn } from '../../lib/utils';

interface AirtableField {
  id: string;
  name: string;
  type: string;
}

interface AirtableTable {
  id: string;
  name: string;
  fields?: AirtableField[];
}

interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
  tables: AirtableTable[];
  error?: string;
}

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

function authHeaders() {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatCellValue(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(formatCellValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function AirtableWorkspace() {
  const [selectedBase, setSelectedBase] = useState<AirtableBase | null>(null);
  const [selectedTable, setSelectedTable] = useState<AirtableTable | null>(null);
  const [records, setRecords] = useState<AirtableRecord[] | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  const { data: bases, isLoading, error, refresh } = useApi<AirtableBase[]>(
    async () => {
      const r = await fetch('api/connectors/airtable/bases', { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  );

  const loadRecords = useCallback(async (baseId: string, tableName: string) => {
    setRecordsLoading(true);
    setRecordsError(null);
    setRecords(null);
    try {
      const r = await fetch(
        `api/connectors/airtable/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableName)}?maxRecords=50`,
        { headers: authHeaders() },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as any).error ?? `HTTP ${r.status}`);
      }
      const data = await r.json();
      setRecords((data as any).records ?? []);
    } catch (err) {
      setRecordsError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  const handleSelectBase = useCallback((base: AirtableBase) => {
    setSelectedBase(base);
    setSelectedTable(null);
    setRecords(null);
    setRecordsError(null);
  }, []);

  const handleSelectTable = useCallback((table: AirtableTable) => {
    if (!selectedBase) return;
    setSelectedTable(table);
    loadRecords(selectedBase.id, table.name);
  }, [selectedBase, loadRecords]);

  const handleBack = useCallback(() => {
    if (selectedTable) {
      setSelectedTable(null);
      setRecords(null);
      setRecordsError(null);
    } else if (selectedBase) {
      setSelectedBase(null);
    }
  }, [selectedBase, selectedTable]);

  // Breadcrumb
  const breadcrumb = [
    { label: 'Bases', onClick: () => { setSelectedBase(null); setSelectedTable(null); setRecords(null); } },
    ...(selectedBase ? [{ label: selectedBase.name, onClick: () => { setSelectedTable(null); setRecords(null); } }] : []),
    ...(selectedTable ? [{ label: selectedTable.name, onClick: () => {} }] : []),
  ];

  // ── Records grid view ──────────────────────────────────────────────────────
  if (selectedTable && selectedBase) {
    const fieldNames = selectedTable.fields?.map((f) => f.name) ?? [];
    // If no field schema, derive columns from record keys
    const derivedFields = records && records.length > 0 && fieldNames.length === 0
      ? Object.keys(records[0].fields)
      : fieldNames;

    return (
      <div>
        {/* Header */}
        <div className="flex items-center gap-2 mb-5">
          <button
            onClick={handleBack}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            aria-label="Back"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden />
          </button>
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            {breadcrumb.map((crumb, i) => (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRight className="w-3 h-3" aria-hidden />}
                <button
                  onClick={crumb.onClick}
                  className={cn(
                    'hover:text-text-primary transition-colors',
                    i === breadcrumb.length - 1 ? 'text-text-primary font-medium' : '',
                  )}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>

        {recordsLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
          </div>
        )}

        {recordsError && (
          <div className="text-sm text-danger bg-danger/10 rounded-lg px-4 py-3">
            {recordsError}
          </div>
        )}

        {records && records.length === 0 && (
          <p className="text-sm text-text-muted py-8 text-center">No records in this table.</p>
        )}

        {records && records.length > 0 && (
          <div className="border border-border rounded-lg overflow-x-auto bg-surface-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-3/50">
                  <th className="text-left px-3 py-2 font-medium text-text-muted uppercase tracking-wider whitespace-nowrap">Row</th>
                  {derivedFields.map((f) => (
                    <th key={f} className="text-left px-3 py-2 font-medium text-text-muted uppercase tracking-wider whitespace-nowrap max-w-[200px]">
                      {f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((rec, ri) => (
                  <tr
                    key={rec.id}
                    className={cn(
                      'hover:bg-surface-3/30 transition-colors',
                      ri < records.length - 1 && 'border-b border-border/50',
                    )}
                  >
                    <td className="px-3 py-2 text-text-muted">{ri + 1}</td>
                    {derivedFields.map((f) => (
                      <td key={f} className="px-3 py-2 text-text-primary max-w-[200px] truncate" title={formatCellValue(rec.fields[f])}>
                        {formatCellValue(rec.fields[f])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 border-t border-border bg-surface-3/30 text-xs text-text-muted">
              {records.length} record{records.length !== 1 ? 's' : ''} shown (max 50)
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Table list for selected base ───────────────────────────────────────────
  if (selectedBase) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-5">
          <button
            onClick={handleBack}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            aria-label="Back"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden />
          </button>
          <div>
            <h2 className="text-base font-semibold text-text-primary font-mono tracking-tight flex items-center gap-2">
              <Database className="w-5 h-5 text-accent" aria-hidden />
              {selectedBase.name}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              {selectedBase.tables.length} table{selectedBase.tables.length !== 1 ? 's' : ''} &middot; {selectedBase.permissionLevel}
            </p>
          </div>
        </div>

        {selectedBase.tables.length === 0 && (
          <p className="text-sm text-text-muted py-8 text-center">
            {selectedBase.error ? `Error: ${selectedBase.error}` : 'No tables found.'}
          </p>
        )}

        <div className="space-y-2">
          {selectedBase.tables.map((table) => (
            <button
              key={table.id}
              onClick={() => handleSelectTable(table)}
              className="w-full text-left bg-surface-1 border border-border rounded-lg p-4 hover:bg-surface-3/50 hover:border-accent/30 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Columns className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{table.name}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {table.fields?.length ?? 0} field{(table.fields?.length ?? 0) !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" aria-hidden />
              </div>
              {table.fields && table.fields.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {table.fields.slice(0, 8).map((f) => (
                    <span key={f.id} className="text-xs px-1.5 py-0.5 rounded bg-surface-3 text-text-muted">
                      {f.name} <span className="text-text-muted/60">({f.type})</span>
                    </span>
                  ))}
                  {table.fields.length > 8 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-surface-3 text-text-muted">
                      +{table.fields.length - 8} more
                    </span>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Base list (default) ────────────────────────────────────────────────────
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-semibold text-text-primary font-mono tracking-tight flex items-center gap-2">
            <Table2 className="w-5 h-5 text-accent" aria-hidden />
            Airtable Bases
          </h2>
          <p className="text-xs text-text-muted mt-1">
            {(bases ?? []).length} base{(bases ?? []).length !== 1 ? 's' : ''} accessible
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors disabled:opacity-50"
          aria-label="Refresh bases"
        >
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} aria-hidden />
        </button>
      </div>

      {isLoading && !bases && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
        </div>
      )}

      {error && !bases && (
        <div className="text-sm text-danger bg-danger/10 rounded-lg px-4 py-3">
          Failed to load bases: {error}
        </div>
      )}

      {(bases ?? []).length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(bases ?? []).map((base) => (
            <button
              key={base.id}
              onClick={() => handleSelectBase(base)}
              className="text-left bg-surface-1 border border-border rounded-lg p-4 hover:bg-surface-3/50 hover:border-accent/30 transition-colors group"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" aria-hidden />
                  <h3 className="text-sm font-medium text-text-primary">{base.name}</h3>
                </div>
                <ChevronRight className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" aria-hidden />
              </div>
              <div className="flex items-center gap-3 text-xs text-text-muted">
                <span>{base.tables.length} table{base.tables.length !== 1 ? 's' : ''}</span>
                <span>{base.permissionLevel}</span>
              </div>
              {base.error && (
                <p className="text-xs text-danger mt-1">{base.error}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {!isLoading && (bases ?? []).length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Table2 className="w-8 h-8 text-text-muted/50 mb-3" aria-hidden />
          <p className="text-sm text-text-muted">No Airtable bases found.</p>
        </div>
      )}
    </div>
  );
}
