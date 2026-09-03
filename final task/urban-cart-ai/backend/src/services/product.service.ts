/**
 * Product lookup.
 *
 * Price and availability are answered from PostgreSQL and NEVER from RAG.
 * Stock changes many times a day; a vector index rebuilt nightly would happily
 * tell a customer that an out-of-stock phone is available. The RAG catalogue
 * document is used only for descriptive detail (specifications, what is in the
 * box), which changes rarely.
 */

import { productRepo, type ProductMatch } from '../database/repositories/product.repo.ts';
import type { Product } from '../models/types.ts';
import { formatPkr } from '../utils/misc.ts';

export interface ProductLookupResult {
  found: boolean;
  product: Product | null;
  /** Other plausible matches, when the query was ambiguous. */
  alternatives: Product[];
  matchType: ProductMatch['matchType'] | null;
  /** True when we matched something but not confidently enough to assert it. */
  ambiguous: boolean;
}

const AVAILABILITY_PHRASE: Record<string, (p: Product) => string> = {
  in_stock: (p) => `Yes, the ${p.name} is in stock at ${formatPkr(p.price)}.`,
  low_stock: (p) =>
    `Yes, the ${p.name} is in stock at ${formatPkr(p.price)}, but only ${p.stockQuantity} left.`,
  out_of_stock: (p) => `The ${p.name} is currently out of stock.`,
  preorder: (p) => `The ${p.name} is available for pre-order at ${formatPkr(p.price)}.`,
  discontinued: (p) => `We no longer stock the ${p.name}.`,
};

export const productService = {
  async lookup(query: string): Promise<ProductLookupResult> {
    const matches = await productRepo.search(query, 5);

    if (matches.length === 0) {
      return { found: false, product: null, alternatives: [], matchType: null, ambiguous: false };
    }

    const best = matches[0];
    if (!best) {
      return { found: false, product: null, alternatives: [], matchType: null, ambiguous: false };
    }

    // Two full-text matches with near-identical weak scores means we guessed.
    // Say so and offer both rather than picking one and sounding certain.
    const second = matches[1];
    const ambiguous =
      best.matchType === 'fulltext' &&
      best.score < 0.5 &&
      second !== undefined &&
      Math.abs(best.score - second.score) < 0.1;

    return {
      found: true,
      product: best.product,
      alternatives: matches.slice(1).map((m) => m.product),
      matchType: best.matchType,
      ambiguous,
    };
  },

  async getBySku(sku: string): Promise<Product | null> {
    return productRepo.findBySku(sku);
  },

  async list(category?: string): Promise<Product[]> {
    return category ? productRepo.listByCategory(category) : productRepo.listAll();
  },

  /** Deterministic sentence about stock and price - no model involved. */
  availabilitySentence(product: Product): string {
    const builder = AVAILABILITY_PHRASE[product.availability];
    return builder ? builder(product) : `The ${product.name} costs ${formatPkr(product.price)}.`;
  },

  priceSentence(product: Product): string {
    const base = `The ${product.name} is ${formatPkr(product.price)}.`;
    if (product.availability === 'out_of_stock') return `${base} It is currently out of stock.`;
    if (product.availability === 'low_stock') {
      return `${base} Only ${product.stockQuantity} left in stock.`;
    }
    return base;
  },

  /** Facts block handed to the grounded generator. */
  toFacts(product: Product) {
    return {
      name: product.name,
      sku: product.sku,
      price: product.price,
      availability: product.availability,
      stockQuantity: product.stockQuantity,
      warrantyMonths: product.warrantyMonths,
      category: product.category,
      description: product.description,
    };
  },
};
