-- =============================================================================
-- UrbanCart AI Automation System
-- PostgreSQL schema : STRUCTURED RELATIONAL SYSTEM OF RECORD
-- =============================================================================
-- Responsibility split (see docs/task-1-solution-proposal.md):
--   PostgreSQL  -> transactional, relational, authoritative business data.
--                  Customers, products, orders, leads, conversations, tickets.
--   Supabase    -> vector/embedding store + RAG knowledge (supabase-schema.sql).
--   Airtable    -> read-friendly operational MIRROR for non-technical staff.
--
-- Design notes
--   * Surrogate UUID PKs let the AI layer generate ids before the row reaches
--     the database, which makes webhook retries idempotent.
--   * Every table carries created_at/updated_at; updated_at is trigger-managed.
--   * Status columns use CHECK constraints rather than ENUM types so operations
--     staff can add a status via a cheap migration instead of an ALTER TYPE that
--     takes an ACCESS EXCLUSIVE lock on every dependent table.
--   * All money is NUMERIC(12,2) in PKR. Never floating point.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- -----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- =============================================================================
-- CUSTOMERS
-- =============================================================================
CREATE TABLE IF NOT EXISTS customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  -- Phone is the natural key: the one identifier present on every channel
  -- (WhatsApp, Vapi caller id, website chat form). Stored E.164-normalised.
  phone             TEXT        NOT NULL UNIQUE
                                CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email             CITEXT      UNIQUE
                                CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  location          TEXT,
  preferred_channel TEXT        CHECK (preferred_channel IN ('web_chat','whatsapp','instagram','voice','email')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone      ON customers (phone);
CREATE INDEX IF NOT EXISTS idx_customers_email      ON customers (email);
CREATE INDEX IF NOT EXISTS idx_customers_location   ON customers (lower(location));
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers (created_at DESC);

DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- PRODUCTS
-- =============================================================================
-- Availability and price live HERE, not in the RAG index. Stock changes many
-- times a day; re-embedding a catalogue on every stock change is slow and is a
-- hallucination risk. The AI answers "is it available / what is the price" from
-- this table, and uses RAG only for descriptive and policy questions.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             TEXT          NOT NULL UNIQUE CHECK (sku ~ '^[A-Z0-9-]{3,32}$'),
  name            TEXT          NOT NULL,
  category        TEXT          NOT NULL CHECK (category IN ('Electronics','Accessories','Home','Lifestyle')),
  brand           TEXT,
  price           NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  currency        CHAR(3)       NOT NULL DEFAULT 'PKR' CHECK (currency = 'PKR'),
  availability    TEXT          NOT NULL DEFAULT 'in_stock'
                                CHECK (availability IN ('in_stock','low_stock','out_of_stock','preorder','discontinued')),
  stock_quantity  INTEGER       NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  warranty_months INTEGER       CHECK (warranty_months IS NULL OR warranty_months >= 0),
  description     TEXT,
  -- Aliases so "iphone", "iphone15", "apple 15" all resolve to the same SKU.
  search_aliases  TEXT[]        NOT NULL DEFAULT '{}',
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_sku          ON products (sku);
CREATE INDEX IF NOT EXISTS idx_products_category     ON products (category) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_products_availability ON products (availability);
CREATE INDEX IF NOT EXISTS idx_products_name_lower   ON products (lower(name));
CREATE INDEX IF NOT EXISTS idx_products_aliases      ON products USING GIN (search_aliases);
CREATE INDEX IF NOT EXISTS idx_products_fts ON products
  USING GIN (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(description,'')));

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- LEADS
-- =============================================================================
CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       TEXT          NOT NULL UNIQUE,          -- LEAD-001
  customer_id     UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id      UUID          REFERENCES products(id) ON DELETE SET NULL,
  product         TEXT          NOT NULL,                 -- free text as spoken
  budget          NUMERIC(12,2) CHECK (budget IS NULL OR budget >= 0),
  currency        CHAR(3)       NOT NULL DEFAULT 'PKR',
  location        TEXT,
  purchase_intent TEXT          NOT NULL DEFAULT 'browsing'
                                CHECK (purchase_intent IN ('ready_to_buy','considering','browsing')),
  source          TEXT          NOT NULL DEFAULT 'web_chat'
                                CHECK (source IN ('web_chat','whatsapp','instagram','voice','email','manual')),
  status          TEXT          NOT NULL DEFAULT 'new'
                                CHECK (status IN ('new','contacted','qualified','won','lost','duplicate')),
  -- Derived by the rules in backend/src/services/lead.service.ts
  lead_score      INTEGER       NOT NULL DEFAULT 0 CHECK (lead_score BETWEEN 0 AND 100),
  is_high_value   BOOLEAN       NOT NULL DEFAULT FALSE,
  conversation_id UUID,                                   -- FK added below
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_customer   ON leads (customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_high_value ON leads (is_high_value) WHERE is_high_value;
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
-- Duplicate-lead guard: same customer + same product inside a short window must
-- not create a second lead (Workflow 3 and the error-handling requirements).
CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads (customer_id, lower(product), created_at DESC);

DROP TRIGGER IF EXISTS trg_leads_updated_at ON leads;
CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- ORDERS  +  ORDER ITEMS
-- =============================================================================
CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      TEXT          NOT NULL UNIQUE CHECK (order_number ~ '^UC-[0-9]{5}$'),
  customer_id       UUID          NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status            TEXT          NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','confirmed','processing','shipped','out_for_delivery','delivered','delayed','cancelled','returned')),
  payment_status    TEXT          NOT NULL DEFAULT 'unpaid'
                                  CHECK (payment_status IN ('unpaid','paid','cod_pending','refunded','partially_refunded')),
  total_amount      NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  currency          CHAR(3)       NOT NULL DEFAULT 'PKR',
  order_date        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  delivery_address  TEXT          NOT NULL,
  delivery_city     TEXT,
  expected_delivery DATE,
  delivered_at      TIMESTAMPTZ,
  courier           TEXT,
  tracking_number   TEXT,
  delay_reason      TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- A delivered order must carry a delivery timestamp; nothing else may.
  CONSTRAINT chk_delivered_at CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_orders_number     ON orders (order_number);
CREATE INDEX IF NOT EXISTS idx_orders_customer   ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders (order_date DESC);

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS order_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID          NOT NULL REFERENCES orders(id)   ON DELETE CASCADE,
  product_id UUID          NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity   INTEGER       NOT NULL CHECK (quantity > 0),
  price      NUMERIC(12,2) NOT NULL CHECK (price >= 0),   -- unit price at time of sale
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);

-- =============================================================================
-- CONVERSATIONS  +  MESSAGES
-- =============================================================================
-- The requirement asks for a `messages` field on conversations. Messages are
-- stored in a normalised append-only child table (indexable, no row rewrite per
-- turn) and the requested JSON shape is exposed by conversations_with_messages.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID        REFERENCES customers(id) ON DELETE SET NULL,  -- NULL = anonymous
  channel     TEXT        NOT NULL CHECK (channel IN ('web_chat','whatsapp','instagram','voice','email')),
  session_id  TEXT        NOT NULL,
  intent      TEXT        CHECK (intent IN (
                            'product_inquiry','price_inquiry','availability_inquiry',
                            'policy_question','order_status','lead_capture',
                            'complaint','greeting','smalltalk','handoff','unknown')),
  status      TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','resolved','escalated','abandoned')),
  escalated   BOOLEAN     NOT NULL DEFAULT FALSE,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, session_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations (customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_session  ON conversations (session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel  ON conversations (channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_intent   ON conversations (intent);

DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID         NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT         NOT NULL CHECK (role IN ('customer','assistant','system','agent')),
  content         TEXT         NOT NULL,
  intent          TEXT,
  -- Grounding confidence; drives the "AI cannot confidently answer" escalation.
  confidence      NUMERIC(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  -- Which knowledge chunks grounded this answer (document id + similarity).
  sources         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages (conversation_id, created_at);

CREATE OR REPLACE VIEW conversations_with_messages AS
SELECT c.*,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object(
                   'role', m.role, 'content', m.content,
                   'confidence', m.confidence, 'sources', m.sources,
                   'created_at', m.created_at) ORDER BY m.created_at)
          FROM conversation_messages m WHERE m.conversation_id = c.id),
         '[]'::jsonb) AS messages
FROM conversations c;

-- Deferred FK: leads.conversation_id -> conversations.id
ALTER TABLE leads DROP CONSTRAINT IF EXISTS fk_leads_conversation;
ALTER TABLE leads ADD CONSTRAINT fk_leads_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

-- =============================================================================
-- SUPPORT TICKETS  +  TASKS
-- =============================================================================
CREATE TABLE IF NOT EXISTS support_tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         TEXT        NOT NULL UNIQUE,          -- SUP-001
  customer_id       UUID        REFERENCES customers(id) ON DELETE SET NULL,
  conversation_id   UUID        REFERENCES conversations(id) ON DELETE SET NULL,
  order_id          UUID        REFERENCES orders(id) ON DELETE SET NULL,
  issue_type        TEXT        NOT NULL CHECK (issue_type IN (
                                  'damaged_product','refund_request','delivery_delay',
                                  'wrong_item','warranty_claim','angry_customer',
                                  'missing_information','low_confidence','other')),
  priority          TEXT        NOT NULL DEFAULT 'medium'
                                CHECK (priority IN ('low','medium','high','urgent')),
  description       TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','in_progress','waiting_customer','resolved','closed')),
  assigned_to       TEXT,
  assigned_team     TEXT        NOT NULL DEFAULT 'support'
                                CHECK (assigned_team IN ('support','sales','operations','logistics','engineering')),
  escalation_reason TEXT,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_customer ON support_tickets (customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status   ON support_tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON support_tickets (priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_open     ON support_tickets (created_at DESC) WHERE status IN ('open','in_progress');

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON support_tickets;
CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     TEXT        NOT NULL UNIQUE,              -- TASK-001
  ticket_id     UUID        REFERENCES support_tickets(id) ON DELETE CASCADE,
  lead_id       UUID        REFERENCES leads(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL,
  description   TEXT,
  priority      TEXT        NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('low','medium','high','urgent')),
  status        TEXT        NOT NULL DEFAULT 'todo'
                            CHECK (status IN ('todo','in_progress','blocked','done','cancelled')),
  assigned_team TEXT        NOT NULL DEFAULT 'support'
                            CHECK (assigned_team IN ('support','sales','operations','logistics','engineering')),
  due_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A task belongs to exactly one parent: a ticket or a lead, never both.
  CONSTRAINT chk_task_parent CHECK (num_nonnulls(ticket_id, lead_id) = 1)
);

CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON tasks (ticket_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team   ON tasks (assigned_team, status);

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- OPERATIONAL / RELIABILITY TABLES
-- =============================================================================
-- Workflow 7 (centralised error handling) writes here. Gives operations a
-- queryable execution history without opening n8n.
CREATE TABLE IF NOT EXISTS workflow_executions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name  TEXT        NOT NULL,
  execution_id   TEXT,
  source         TEXT        NOT NULL DEFAULT 'backend'
                             CHECK (source IN ('backend','n8n','zapier','vapi','scheduler')),
  status         TEXT        NOT NULL CHECK (status IN ('started','success','failed','partial')),
  correlation_id TEXT,
  input_summary  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_code     TEXT,
  error_message  TEXT,        -- internal only; never returned to a customer
  duration_ms    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wf_exec_name   ON workflow_executions (workflow_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_exec_failed ON workflow_executions (created_at DESC) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_wf_exec_corr   ON workflow_executions (correlation_id);

-- Transactional outbox for every outbound integration (Slack, Airtable, Zapier,
-- Notion). Writing here in the same transaction as the business row means a
-- Slack outage cannot lose a notification: the dispatcher retries from here.
CREATE TABLE IF NOT EXISTS integration_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination  TEXT        NOT NULL CHECK (destination IN ('slack','airtable','notion','zapier','google_drive','vapi')),
  event_type   TEXT        NOT NULL,
  entity_type  TEXT,
  entity_id    UUID,
  payload      JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','delivered','failed','skipped','dry_run')),
  attempts     INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT,
  external_ref TEXT,        -- Airtable record id / Slack message ts / Zap id
  delivered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_pending ON integration_events (destination, created_at)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_integration_entity  ON integration_events (entity_type, entity_id);

DROP TRIGGER IF EXISTS trg_integration_updated_at ON integration_events;
CREATE TRIGGER trg_integration_updated_at BEFORE UPDATE ON integration_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sequence-backed human references (LEAD-001, SUP-001, TASK-001, UC-10xxx).
CREATE SEQUENCE IF NOT EXISTS seq_lead_reference   START 1;
CREATE SEQUENCE IF NOT EXISTS seq_ticket_reference START 1;
CREATE SEQUENCE IF NOT EXISTS seq_task_reference   START 1;
CREATE SEQUENCE IF NOT EXISTS seq_order_number     START 10500;

CREATE OR REPLACE FUNCTION next_reference(p_kind TEXT)
RETURNS TEXT AS $fn$
BEGIN
  RETURN CASE p_kind
    WHEN 'lead'   THEN 'LEAD-' || lpad(nextval('seq_lead_reference')::text, 3, '0')
    WHEN 'ticket' THEN 'SUP-'  || lpad(nextval('seq_ticket_reference')::text, 3, '0')
    WHEN 'task'   THEN 'TASK-' || lpad(nextval('seq_task_reference')::text, 3, '0')
    WHEN 'order'  THEN 'UC-'   || nextval('seq_order_number')::text
    ELSE NULL
  END;
END;
$fn$ LANGUAGE plpgsql;

-- =============================================================================
-- REPORTING VIEWS (used by /api/admin and the Airtable operational sync)
-- =============================================================================
CREATE OR REPLACE VIEW v_order_summary AS
SELECT o.id, o.order_number, o.status, o.payment_status, o.total_amount, o.currency,
       o.order_date, o.expected_delivery, o.delivered_at, o.delivery_address,
       o.delivery_city, o.courier, o.tracking_number, o.delay_reason,
       c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
       (SELECT jsonb_agg(jsonb_build_object(
                 'sku', p.sku, 'name', p.name,
                 'quantity', oi.quantity, 'price', oi.price)
               ORDER BY p.name)
        FROM order_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = o.id) AS items
FROM orders o
JOIN customers c ON c.id = o.customer_id;

CREATE OR REPLACE VIEW v_lead_pipeline AS
SELECT l.id, l.reference, l.product, l.budget, l.currency, l.location,
       l.purchase_intent, l.source, l.status, l.lead_score, l.is_high_value,
       l.created_at,
       c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
FROM leads l JOIN customers c ON c.id = l.customer_id;

CREATE OR REPLACE VIEW v_support_queue AS
SELECT t.id, t.reference, t.issue_type, t.priority, t.status, t.assigned_team,
       t.assigned_to, t.description, t.escalation_reason, t.created_at,
       c.name AS customer_name, c.phone AS customer_phone,
       o.order_number
FROM support_tickets t
LEFT JOIN customers c ON c.id = t.customer_id
LEFT JOIN orders   o ON o.id = t.order_id;
