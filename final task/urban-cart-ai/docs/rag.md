# RAG — grounded knowledge

## The problem this solves

> *"We don't want the AI making up information. Product information and company
> policies change, so it should use our actual information."*
> — Sarah Malik, UrbanCart

And:

> *"Currently, someone has to manually update everything… We don't want
> developers changing the system every time we update a PDF."*

Two requirements that pull in opposite directions: the answers must be exactly
what the documents say, **and** the documents must be changeable by someone who
does not write code. RAG is the only approach that satisfies both — the answer
changes when the document changes, with no deployment.

## Pipeline

```
Google Drive
   → detect new/changed (SHA-256 of extracted text)
   → download
   → extract text        (PDF · DOCX · XLSX · CSV · MD)
   → clean               (de-hyphenate, strip boilerplate, unescape)
   → chunk               (heading-aware, ~900 chars, 150 overlap)
   → embed               (1536 dimensions)
   → store               (Supabase pgvector, HNSW)
   ─────────────────────────────────────────────
   → similarity search   (cosine + metadata filter)
   → confidence gate     ──below threshold──→ ESCALATE
   → LLM with grounding prompt
   → numeric-claim audit ──unsupported──────→ ESCALATE
   → grounded answer + cited sources
```

---

## 1. Change detection

The SHA-256 of the **extracted text** (not the file bytes) is the identity. Two
consequences worth having:

- Re-saving a PDF without editing it changes the bytes but not the text, so it
  costs nothing.
- The six-hourly safety-net sweep is effectively free, which is why we can
  afford to run it and not depend solely on Drive's change notifications.

## 2. Extraction

| Format | Library | Note |
|---|---|---|
| PDF | `unpdf` (current pdf.js) | Per-page, so repeated headers/footers are detectable |
| DOCX | `mammoth` → HTML | Heading levels preserved, which the chunker needs |
| XLSX | `exceljs` | Rendered as labelled `Column: value` pairs |
| CSV/TSV | built-in | RFC-4180-aware |
| MD/TXT | built-in | |

> The widely-cited `pdf-parse@1.1.1` bundles a 2018 build of pdf.js that rejects
> PDFs from modern writers with "bad XRef entry". It is not used here.

**Why spreadsheets become labelled pairs.** A row rendered as
`SKU: UC-ELEC-001 | Product Name: iPhone 15 | Warranty: 12 months` retrieves far
better against *"does the iPhone 15 have a warranty"* than the bare CSV line
`UC-ELEC-001,iPhone 15,…` does. The column headers carry the meaning, so they
have to appear in the embedded text.

## 3. Cleaning

Not cosmetic — each of these measurably changes what retrieves:

- Rejoin words hyphenated across a line break (`war-\nranty` → `warranty`)
- Drop page-number-only lines and boilerplate repeated on 60%+ of pages
- Normalise unicode punctuation the tokeniser treats inconsistently
- Unescape markdown produced by the DOCX converter (`delivery\.` → `delivery.`)
- Collapse whitespace, preserving paragraph and heading structure

## 4. Chunking — the most important quality decision

**Structure first, size second.**

1. Split on headings (markdown `#` and numbered `1.2 Title`). A chunk never
   spans two policy sections.
2. Within a section, pack whole paragraphs to ~900 characters.
3. An oversized paragraph is split on sentence boundaries — never mid-sentence.
4. Consecutive chunks overlap by ~150 characters of trailing **whole
   sentences**, so a rule split across a boundary is still retrievable whole.
5. Every chunk is prefixed with its heading trail (`Return Policy > 2. Audio
   Products`), putting the topic words into the embedded text itself.

**Why this matters concretely.** *"Can I return headphones after 10 days?"* must
retrieve section 2 (audio: 7 days) and not section 1 (general: 14 days). With
naive fixed-size chunking those two sections land in the same chunk and the
model is handed contradictory rules — and the wrong answer, "yes", is the more
prominent one. This is asserted in the test suite: a chunk containing the audio
rule must not also contain the refund rule.

## 5. Embeddings

**Production:** OpenAI `text-embedding-3-small`, 1536 dimensions, batched 96 at
a time with retry on 429/5xx.

**Offline:** a deterministic hashed bag-of-words vector — signed feature hashing
of unigrams and bigrams, sublinear term frequency, L2-normalised, also 1536
dimensions so the schema never changes between modes.

This is real vector maths and real cosine similarity, **not a stub returning
canned results**. But it is *lexical*: it matches shared vocabulary, not
meaning, and will miss a paraphrase that shares no words. It exists so the whole
pipeline is demonstrable and testable with no API key, and `/health` reports it
as `semantic: false` so nobody mistakes it for production quality.

**Thresholds are provider-specific**, because cosine scores are not comparable
across models. A good match sits around 0.4–0.7 with a trained model and around
0.15–0.30 with the hashed one. A single shared threshold would either reject
every correct local answer or accept every irrelevant OpenAI one:

| Provider | `minSimilarity` | `confidenceThreshold` |
|---|---|---|
| OpenAI | 0.25 | 0.35 |
| local | 0.08 | 0.22 |

Leave `RAG_MIN_SIMILARITY` and `RAG_CONFIDENCE_THRESHOLD` blank to get the right
defaults automatically.

## 6. Storage

`documents` (one per file) and `document_chunks` (`vector(1536)` + JSONB
metadata), with an HNSW cosine index, degrading to IVFFlat and then to a
sequential scan if pgvector is older.

**Versioning, not deletion.** Re-ingesting a changed file marks the previous row
`superseded` and deletes its chunks. History is retained so an answer given last
month can still be explained; the dead vectors do not bloat the index. A partial
unique index guarantees exactly one active version per source file.

## 7. Retrieval and metadata filtering

Each question is restricted to the document types that could answer it — by
keyword hints first (`return`/`refund` → return policy; `warranty`/`guarantee` →
warranty policy), falling back to the intent's default set.

**This is a correctness feature, not an optimisation.** Restricting a warranty
question to warranty documents stops a superficially similar sentence in the
*return* policy being retrieved and presented as warranty terms — a realistic
and expensive way to be confidently wrong.

**With a widening fallback.** The keyword hints are imperfect: "price match
guarantee" contains *guarantee*, which points at the warranty policy, so a
price-match document filed under returns would be locked out entirely. When a
filtered search returns nothing **or only weak matches**, the system searches
again unfiltered and keeps whichever result is genuinely better. A bad topic
guess costs a little latency instead of costing the customer their answer — and
the confidence gate still decides whether the winner is good enough.

## 8. Confidence

Similarity alone is a poor signal, so confidence combines three things:

```
confidence = 0.55 × best similarity
           + 0.15 × agreement among the next two chunks
           + 0.30 × lexical coverage of the question's content words
```

The coverage term is what catches *"the vector store returned its five nearest
neighbours, but none of them mention warranties"* — the exact failure mode that
produces a confident, irrelevant answer.

Three outcomes: `grounded` (answer), `uncertain` (escalate), `empty` (escalate).
**Only `grounded` reaches the model.** We do not hand a language model weak
evidence and hope it declines to use it.

## 9. The grounding prompt

Full text in `backend/src/rag/prompt.ts`. The rules that matter:

- Answer **only** from the supplied KNOWLEDGE and BUSINESS DATA blocks.
- Never state a price, delivery time, return window, warranty term or
  specification that is not in that material verbatim.
- Never use general knowledge about other retailers or how e-commerce "usually"
  works.
- If the material is insufficient, reply with exactly `ESCALATE: <what is
  missing>`.
- Prefer the most recent effective version when documents conflict, and say
  which policy was used.
- Never invent an order number, ticket number, date or customer name.

**Why the explicit `ESCALATE:` token.** A model told only "don't guess", with no
alternative, still guesses — it has been given a question and no permitted way
to decline. Defining the exact output for "I cannot answer" makes refusal the
easy path rather than the exceptional one.

**Price and stock never come from RAG.** They are injected as BUSINESS DATA
straight from PostgreSQL and labelled authoritative. A catalogue re-indexed
nightly would happily tell a customer that an out-of-stock phone is available.

## 10. The numeric-claim audit

The backstop. Every price, duration and percentage in the generated answer must
trace to a digit sequence in the supplied evidence. An invented *"Rs. 5,000
restocking fee"* is caught and the turn escalates instead of answering.

Deliberately conservative — it only flags claims of two or more digits with no
match anywhere in the evidence, so ordinary rephrasing ("seven days" for "7
days") does not trip it. It cannot catch every hallucination, but it catches the
expensive class: invented money and invented deadlines.

---

## Publishing a document (the whole process)

1. Save the file into the right Google Drive sub-folder.
2. Wait up to 15 minutes, or trigger it:
   ```bash
   npm run drive:sync
   ```

**The folder is the classifier:**

```
UrbanCart Knowledge Base/
├── Products/   → product_catalog
├── Shipping/   → shipping_policy
├── Returns/    → return_policy
├── Warranty/   → warranty_policy
├── Support/    → support_guidelines
└── Training/   → training
```

No code change. No deployment. No developer.

## Google Drive setup

1. Google Cloud Console → new project.
2. Enable the **Google Drive API**.
3. Create a **Service Account**, add a JSON key, download it.
4. In Drive, share the *UrbanCart Knowledge Base* folder as **Viewer** with the
   service-account email.
5. Configure:
   ```bash
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./google-service-account.json
   GOOGLE_DRIVE_FOLDER_ID=1AbC...    # from the folder URL
   ```

Read-only scope by design. Google Docs and Sheets are exported to DOCX/XLSX
automatically.

## Local knowledge base

`knowledge-base/` mirrors the Drive structure exactly, so the pipeline is
identical and only the fetch step differs. `npm run kb:generate` writes six real
documents — two PDFs, two DOCX, one XLSX and one Markdown file — from the
content in `scripts/knowledge-content.ts`.

## Debugging retrieval

```bash
curl -s -X POST http://localhost:3000/api/knowledge/search -H "Content-Type: application/json" -H "X-API-Key: $INTERNAL_API_KEY" -d '{"query":"Can I return headphones after 10 days?"}'
```

Returns similarity scores, the applied document-type filter, timings and chunk
previews — enough to see *why* an answer was or was not grounded.

## Tuning

| Symptom | Likely cause | Fix |
|---|---|---|
| Escalates questions the documents answer | Threshold too high, or lexical embeddings | Configure OpenAI embeddings; check `/api/knowledge/search` |
| Answers are vague or off-topic | Chunks too large | Lower `RAG_CHUNK_SIZE` |
| Answers cut off mid-rule | Overlap too small | Raise `RAG_CHUNK_OVERLAP` |
| Retrieves the wrong policy | Filter hints wrong | Add terms to `TOPIC_HINTS` in `retriever.ts` |
| Quality dropped after a change | Mixed embedding models | `npm run rag:reindex` |
