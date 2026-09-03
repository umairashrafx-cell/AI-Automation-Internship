/**
 * Render the UrbanCart knowledge base into real PDF, DOCX, XLSX and Markdown
 * files under knowledge-base/, mirroring the Google Drive folder structure.
 *
 *   npm run kb:generate
 *
 * These are genuine binary documents, not text files with a .pdf extension:
 * the ingestion pipeline parses them with pdf-parse, mammoth and exceljs
 * exactly as it would parse files downloaded from Drive.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from '../backend/src/config/env.ts';
import {
  TEXT_DOCUMENTS,
  PRODUCT_CATALOG_SHEET,
  type TextDocument,
} from './knowledge-content.ts';

const KB_ROOT = join(PROJECT_ROOT, 'knowledge-base');

/* -------------------------------------------------------------------------- */
/* PDF                                                                        */
/* -------------------------------------------------------------------------- */

async function writePdf(doc: TextDocument, outPath: string): Promise<void> {
  const PDFDocument = (await import('pdfkit')).default;

  await mkdir(dirname(outPath), { recursive: true });

  return new Promise<void>((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 64, bottom: 64, left: 64, right: 64 },
      info: { Title: doc.title, Author: 'UrbanCart' },
    });

    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('error', reject);
    pdf.on('end', () => {
      writeFile(outPath, Buffer.concat(chunks)).then(resolve, reject);
    });

    pdf.fontSize(20).font('Helvetica-Bold').text(doc.title);
    pdf.moveDown(0.3);
    pdf.fontSize(10).font('Helvetica-Oblique').text(doc.subtitle);
    pdf.fontSize(10).font('Helvetica').text(`Effective date: ${doc.effectiveDate}`);
    pdf.moveDown(1);

    for (const section of doc.sections) {
      // Keep a heading with at least a little of its body on the same page.
      if (pdf.y > 680) pdf.addPage();
      pdf.fontSize(13).font('Helvetica-Bold').text(section.heading);
      pdf.moveDown(0.4);
      pdf.fontSize(11).font('Helvetica');
      for (const paragraph of section.paragraphs) {
        pdf.text(paragraph, { align: 'left', lineGap: 2 });
        pdf.moveDown(0.5);
      }
      pdf.moveDown(0.4);
    }

    pdf.end();
  });
}

/* -------------------------------------------------------------------------- */
/* DOCX                                                                       */
/* -------------------------------------------------------------------------- */

async function writeDocx(doc: TextDocument, outPath: string): Promise<void> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx');

  const children = [
    new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: doc.subtitle, italics: true })] }),
    new Paragraph({ text: `Effective date: ${doc.effectiveDate}` }),
    new Paragraph({ text: '' }),
  ];

  for (const section of doc.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    for (const paragraph of section.paragraphs) {
      children.push(new Paragraph({ text: paragraph }));
    }
    children.push(new Paragraph({ text: '' }));
  }

  const document = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(document);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

async function writeMarkdown(doc: TextDocument, outPath: string): Promise<void> {
  const lines = [
    `# ${doc.title}`,
    '',
    `_${doc.subtitle}_`,
    '',
    `Effective date: ${doc.effectiveDate}`,
    '',
  ];
  for (const section of doc.sections) {
    lines.push(`## ${section.heading}`, '');
    for (const paragraph of section.paragraphs) lines.push(paragraph, '');
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, lines.join('\n'), 'utf8');
}

/* -------------------------------------------------------------------------- */
/* XLSX                                                                       */
/* -------------------------------------------------------------------------- */

async function writeXlsx(outPath: string): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'UrbanCart';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(PRODUCT_CATALOG_SHEET.sheetName);
  sheet.addRow(PRODUCT_CATALOG_SHEET.header);
  sheet.getRow(1).font = { bold: true };
  for (const row of PRODUCT_CATALOG_SHEET.rows) sheet.addRow(row);

  sheet.columns.forEach((column, i) => {
    column.width = i === 4 || i === 5 || i === 7 ? 48 : 22;
  });

  await mkdir(dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const written: string[] = [];

  for (const doc of TEXT_DOCUMENTS) {
    const outPath = join(KB_ROOT, doc.path);
    if (doc.path.endsWith('.pdf')) await writePdf(doc, outPath);
    else if (doc.path.endsWith('.docx')) await writeDocx(doc, outPath);
    else await writeMarkdown(doc, outPath);
    written.push(doc.path);
  }

  await writeXlsx(join(KB_ROOT, PRODUCT_CATALOG_SHEET.path));
  written.push(PRODUCT_CATALOG_SHEET.path);

  console.log(`Knowledge base written to ${KB_ROOT}`);
  for (const p of written) console.log(`  - ${p}`);
}

main().catch((err) => {
  console.error('Failed to generate knowledge base:', err);
  process.exit(1);
});
