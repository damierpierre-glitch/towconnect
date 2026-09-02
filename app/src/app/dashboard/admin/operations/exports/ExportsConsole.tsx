'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Label, Select } from '@/components/ui/Field';
import { formatDateTime } from '@/lib/formatDate';
import { runExport, type AvailableDataset, type ExportAuditRow } from '@/lib/actions/exports';
import { OperationsNav, type Capabilities } from '../OperationsNav';

// Exports.
//
// The list below shows only what this account may already read. That is a
// convenience, not the control: runExport() re-authorizes on the server every
// time, against the database's own answer, and the browser never sends rows
// or ids — only filters.

export function ExportsConsole({
  capabilities,
  datasets,
  audit,
}: {
  capabilities: Capabilities;
  datasets: AvailableDataset[];
  audit: ExportAuditRow[];
}) {
  const { lang } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [dataset, setDataset] = useState(datasets[0]?.key ?? '');
  const [filters, setFilters] = useState({ from: '', to: '', status: '' });

  async function download(format: 'csv' | 'xlsx') {
    if (!dataset) return;
    setBusy(true);
    try {
      const result = await runExport({
        dataset,
        format,
        filters: {
          from: filters.from ? new Date(filters.from).toISOString() : null,
          // An inclusive end date: somebody asking for "to 31 March" means the
          // whole of the 31st, not midnight at its start.
          to: filters.to ? new Date(new Date(filters.to).getTime() + 86_400_000).toISOString() : null,
          status: filters.status || null,
        },
      });

      // The server produced the file; the browser only saves it. Nothing is
      // assembled here, so a large dataset never has to fit in this tab.
      const binary = atob(result.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);

      showToast(
        '⬇️',
        result.rowCount === 0
          ? lang === 'fr'
            ? 'Aucune ligne pour ces filtres — le fichier ne contient que les en-têtes.'
            : 'No rows for these filters — the file contains headers only.'
          : `${result.rowCount} ${lang === 'fr' ? 'ligne(s) exportée(s).' : 'row(s) exported.'}`
      );
    } catch (e) {
      showToast('⚠️', e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Exports' : 'Exports'}</h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? 'Un export ne montre jamais plus que ce que votre rôle peut déjà lire à l’écran. Le fichier est produit sur le serveur, et chaque export est journalisé.'
            : 'An export never shows more than your role can already read on screen. The file is produced on the server, and every export is logged.'}
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      {datasets.length === 0 ? (
        <Card>
          <p className="text-sm text-text-2">
            {lang === 'fr'
              ? 'Aucune capacité de votre compte ne permet d’exporter des données.'
              : 'No capability on your account allows exporting data.'}
          </p>
        </Card>
      ) : (
        <Card className="mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div className="sm:col-span-2">
              <Label>{lang === 'fr' ? 'Jeu de données' : 'Dataset'}</Label>
              <Select value={dataset} onChange={(e) => setDataset(e.target.value)}>
                {datasets.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{lang === 'fr' ? 'Du' : 'From'}</Label>
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </div>
            <div>
              <Label>{lang === 'fr' ? 'Au (inclus)' : 'To (inclusive)'}</Label>
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label>{lang === 'fr' ? 'Statut (optionnel)' : 'Status (optional)'}</Label>
              <Input
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
                placeholder={lang === 'fr' ? 'ex. completed' : 'e.g. completed'}
              />
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button disabled={busy || !dataset} onClick={() => download('csv')}>
              CSV
            </Button>
            <Button variant="secondary" disabled={busy || !dataset} onClick={() => download('xlsx')}>
              Excel (.xlsx)
            </Button>
          </div>

          <p className="text-xs text-muted mt-4">
            {lang === 'fr'
              ? 'Les filtres sont appliqués côté serveur, sur l’ensemble du jeu de données — pas seulement sur la page affichée. Le CSV est en UTF-8 avec BOM pour qu’Excel affiche correctement les accents.'
              : 'Filters are applied on the server across the whole dataset, not just the page on screen. The CSV is UTF-8 with a byte-order mark so Excel renders accents correctly.'}
          </p>
        </Card>
      )}

      {capabilities.superAdmin ? (
        <Card>
          <h2 className="font-display text-base font-bold mb-1">
            {lang === 'fr' ? 'Journal des exports' : 'Export log'}
          </h2>
          <p className="text-xs text-muted mb-4">
            {lang === 'fr'
              ? 'Qui a exporté quoi, sous quelle capacité. Le fichier lui-même n’est jamais conservé : un journal contenant les exports serait une seconde copie non protégée des données.'
              : 'Who exported what, under which capability. The file itself is never kept: a log holding the exports would be a second, unguarded copy of the data.'}
          </p>
          {audit.length === 0 ? (
            <p className="text-sm text-muted">{lang === 'fr' ? 'Aucun export.' : 'No exports yet.'}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {audit.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-3 py-1.5 border-b border-steel/40 last:border-none flex-wrap"
                >
                  <div className="min-w-0">
                    <div className="text-sm">
                      {row.dataset} · {row.format.toUpperCase()}
                    </div>
                    <div className="text-xs text-muted">
                      {row.actor_name ?? '—'} · {formatDateTime(row.created_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge tone="blue" dot={false}>
                      {row.capability}
                    </Badge>
                    <span className="text-xs text-text-2 tabular-nums">
                      {row.row_count} {lang === 'fr' ? 'lignes' : 'rows'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
