import 'server-only';
import ExcelJS from 'exceljs';
import type { Column, SummaryRow } from './datasets';

// Turning rows into a file somebody opens in Excel.
//
// THE ACCENT PROBLEM, SOLVED ONCE
// A CSV of French data opened in Excel on Windows is the classic broken
// deliverable: "Créée le" becomes "CrÃ©Ã©e le". Excel guesses the encoding
// from a byte-order mark, so the file starts with one. Without it, UTF-8 is
// read as the system codepage and every accent in this product is mangled.
const BOM = '﻿';

function formatDate(value: unknown, withTime: boolean): string {
  if (!value) return '';
  const iso = String(value);
  // Read off the ISO string rather than through the host's locale data: the
  // server's answer and the reader's must be the same text, and a spreadsheet
  // column that changes shape depending on who generated it cannot be sorted.
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function cellValue(value: unknown, type: Column['type']): string {
  if (value == null) return '';
  switch (type) {
    case 'date':
      return formatDate(value, false);
    case 'datetime':
      return formatDate(value, true);
    case 'boolean':
      return value ? 'oui' : 'non';
    case 'money':
    case 'number':
      // A plain number, with a dot. Excel applies the reader's own locale to
      // a numeric cell; writing "1 234,56" here would produce text nobody can
      // sum. Precision is the caller's business, not the formatter's.
      return String(Number(value));
    default:
      return String(value);
  }
}

/**
 * A CSV Excel opens correctly.
 *
 * Quoting is unconditional. A conditional quote is a bug waiting for the
 * first address containing a comma — and every address in this product does.
 */
export function toCsv(columns: Column[], rows: Record<string, unknown>[]): string {
  const escape = (text: string) => `"${text.replace(/"/g, '""')}"`;
  const lines = [columns.map((c) => escape(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(cellValue(row[c.key], c.type))).join(','));
  }
  // CRLF: what Excel expects, and harmless everywhere else.
  return BOM + lines.join('\r\n') + '\r\n';
}

/**
 * A real .xlsx — a spreadsheet, not a CSV with the wrong extension.
 *
 * Numbers are written as numbers and dates as text in a sortable ISO shape,
 * so a column of money can be summed and a column of dates orders correctly
 * whatever the reader's regional settings.
 */
export async function toXlsx(
  columns: Column[],
  rows: Record<string, unknown>[],
  options: { sheetName: string; summary?: SummaryRow[] }
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TowConnect';
  workbook.created = new Date();

  // The Résumé sheet comes FIRST and is derived from the very rows in
  // Données — so the total somebody quotes and the lines they can check are
  // the same data, and cannot drift apart.
  if (options.summary?.length) {
    const summary = workbook.addWorksheet('Résumé');
    summary.columns = [
      { header: 'Indicateur', key: 'label', width: 42 },
      { header: 'Valeur', key: 'value', width: 18 },
    ];
    summary.getRow(1).font = { bold: true };
    for (const entry of options.summary) {
      summary.addRow({
        label: entry.label,
        value: typeof entry.value === 'number' ? Math.round(entry.value * 100) / 100 : entry.value,
      });
    }
    summary.addRow({});
    summary.addRow({
      label: 'Lignes dans l’onglet Données',
      value: rows.length,
    });
  }

  const sheet = workbook.addWorksheet(options.sheetName);
  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.min(46, Math.max(14, c.header.length + 4)),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of rows) {
    const record: Record<string, string | number | null> = {};
    for (const column of columns) {
      const raw = row[column.key];
      if (raw == null) {
        record[column.key] = null;
      } else if (column.type === 'money' || column.type === 'number') {
        record[column.key] = Number(raw);
      } else if (column.type === 'boolean') {
        record[column.key] = raw ? 'oui' : 'non';
      } else if (column.type === 'date' || column.type === 'datetime') {
        record[column.key] = formatDate(raw, column.type === 'datetime');
      } else {
        record[column.key] = String(raw);
      }
    }
    sheet.addRow(record);
  }

  for (const [index, column] of columns.entries()) {
    if (column.type === 'money') sheet.getColumn(index + 1).numFmt = '#,##0.00';
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
