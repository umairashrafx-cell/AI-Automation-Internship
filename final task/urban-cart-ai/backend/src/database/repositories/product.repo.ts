/**
 * Product repository.
 *
 * Product search is deliberately NOT vector search. Customers name products
 * precisely ("iPhone 15", "UC-ELEC-001") and stock/price must be exact, so we
 * resolve against the relational catalogue with a three-stage strategy:
 *   1. exact SKU / exact name           - unambiguous
 *   2. alias array + prefix match       - "iphone", "galaxy s24"
 *   3. full-text search ranking         - descriptive queries
 * RAG is used for *descriptive* product questions, never for price or stock.
 */

import { getDb, type SqlClient } from '../index.ts';
import type { Product } from '../../models/types.ts';
import { normaliseForMatch, tokenize } from '../../utils/text.ts';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  brand: string | null;
  price: string;
  currency: string;
  availability: string;
  stock_quantity: number;
  warranty_months: number | null;
  description: string | null;
  search_aliases: string[] | null;
  is_active: boolean;
}

function map(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category as Product['category'],
    brand: row.brand,
    price: Number(row.price),
    currency: row.currency,
    availability: row.availability as Product['availability'],
    stockQuantity: Number(row.stock_quantity),
    warrantyMonths: row.warranty_months === null ? null : Number(row.warranty_months),
    description: row.description,
    searchAliases: row.search_aliases ?? [],
    isActive: row.is_active,
  };
}

const COLUMNS = `id, sku, name, category, brand, price, currency, availability,
                 stock_quantity, warranty_months, description, search_aliases, is_active`;

const SELECT = `SELECT ${COLUMNS} FROM products`;

export interface ProductMatch {
  product: Product;
  /** How the match was made, surfaced in the demo UI to show the AI's reasoning. */
  matchType: 'sku' | 'exact_name' | 'alias' | 'fulltext';
  score: number;
}

export const productRepo = {
  async findById(id: string, tx?: SqlClient): Promise<Product | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<ProductRow>(`${SELECT} WHERE id = $1`, [id]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  async findBySku(sku: string, tx?: SqlClient): Promise<Product | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<ProductRow>(`${SELECT} WHERE sku = $1 AND is_active`, [
      sku.toUpperCase(),
    ]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  /**
   * Resolve a free-text product reference to catalogue rows, best match first.
   * Returns [] rather than guessing when nothing is close enough.
   */
  async search(query: string, limit = 5, tx?: SqlClient): Promise<ProductMatch[]> {
    const db = tx ?? (await getDb());
    const raw = query.trim();
    if (!raw) return [];

    const normalised = normaliseForMatch(raw);

    // 1. Exact SKU.
    if (/^[A-Z0-9-]{3,32}$/i.test(raw)) {
      const bySku = await db.query<ProductRow>(`${SELECT} WHERE sku = $1 AND is_active`, [
        raw.toUpperCase(),
      ]);
      if (bySku.rows[0]) return [{ product: map(bySku.rows[0]), matchType: 'sku', score: 1 }];
    }

    // 2. Exact (case-insensitive) name, then alias membership, then alias prefix.
    const direct = await db.query<ProductRow & { match_type: string; score: string }>(
      `SELECT ${COLUMNS},
              CASE WHEN lower(name) = $1          THEN 'exact_name'
                   ELSE 'alias' END AS match_type,
              CASE WHEN lower(name) = $1          THEN 1.00
                   WHEN $1 = ANY (search_aliases) THEN 0.95
                   ELSE 0.80 END AS score
       FROM products
       WHERE is_active
         AND (lower(name) = $1
              OR $1 = ANY (search_aliases)
              OR EXISTS (SELECT 1 FROM unnest(search_aliases) a
                          WHERE $1 LIKE a || '%' OR a LIKE $1 || '%'))
       ORDER BY score DESC, name
       LIMIT $2`,
      [normalised, limit],
    );

    if (direct.rows.length > 0) {
      return direct.rows.map((r) => ({
        product: map(r),
        matchType: r.match_type as ProductMatch['matchType'],
        score: Number(r.score),
      }));
    }

    // 3. Full-text search over name + brand + description.
    const terms = tokenize(raw);
    if (terms.length === 0) return [];
    // OR the terms together so a partial description still matches. Terms come
    // from tokenize(), which strips everything except letters and digits, so
    // they cannot inject tsquery operators - and they are still bound as $1.
    const tsQuery = terms.join(' | ');

    const fts = await db.query<ProductRow & { score: string }>(
      `SELECT ${COLUMNS},
              ts_rank(
                to_tsvector('english', coalesce(name,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(description,'')),
                to_tsquery('english', $1)
              ) AS score
       FROM products
       WHERE is_active
         AND to_tsvector('english', coalesce(name,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(description,''))
             @@ to_tsquery('english', $1)
       ORDER BY score DESC
       LIMIT $2`,
      [tsQuery, limit],
    );

    return fts.rows.map((r) => ({
      product: map(r),
      matchType: 'fulltext' as const,
      // ts_rank is small and unbounded above; squash into 0-0.75 so a fuzzy hit
      // never outranks an exact match and never reads as high confidence.
      score: Math.min(0.75, Number(r.score) * 5),
    }));
  },

  async listByCategory(category: string, limit = 20, tx?: SqlClient): Promise<Product[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<ProductRow>(
      `${SELECT} WHERE is_active AND category = $1 ORDER BY name LIMIT $2`,
      [category, limit],
    );
    return res.rows.map(map);
  },

  async listAll(limit = 100, tx?: SqlClient): Promise<Product[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<ProductRow>(`${SELECT} WHERE is_active ORDER BY category, name LIMIT $1`, [
      limit,
    ]);
    return res.rows.map(map);
  },
};
