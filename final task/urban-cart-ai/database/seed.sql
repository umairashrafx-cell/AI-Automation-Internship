-- =============================================================================
-- UrbanCart demo / seed data
-- =============================================================================
-- Idempotent: safe to run repeatedly. Every INSERT has an ON CONFLICT clause
-- keyed on the natural key (sku, phone, order_number).
--
-- Covers every scenario in the assignment:
--   * UC-10452  - the order named in the meeting minutes (currently DELAYED)
--   * UC-10453  - a DELIVERED order (return / damaged-product scenarios)
--   * UC-10454  - a PENDING order
--   * UC-10455  - an order OUT FOR DELIVERY
--   * UC-10456  - a second DELIVERED order, older, for repeat-customer history
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PRODUCTS
-- -----------------------------------------------------------------------------
-- Prices are realistic Pakistani retail prices in PKR.
INSERT INTO products
  (sku, name, category, brand, price, availability, stock_quantity, warranty_months, description, search_aliases)
VALUES
  ('UC-ELEC-001', 'iPhone 15', 'Electronics', 'Apple', 249999.00, 'in_stock', 24, 12,
   'Apple iPhone 15 with a 6.1 inch Super Retina XDR display, A16 Bionic chip, 128GB storage, 48MP main camera and USB-C charging. PTA approved.',
   ARRAY['iphone','iphone 15','iphone15','apple 15','apple iphone','iphone 15 128gb']),

  ('UC-ELEC-002', 'Samsung Galaxy S24', 'Electronics', 'Samsung', 219999.00, 'in_stock', 15, 12,
   'Samsung Galaxy S24 with a 6.2 inch Dynamic AMOLED 2X display, Snapdragon 8 Gen 3, 256GB storage and a 50MP triple camera. Dual SIM, PTA approved.',
   ARRAY['samsung','galaxy','galaxy s24','samsung galaxy','s24','samsung s24','samsung galaxy s24']),

  ('UC-ELEC-003', 'UrbanSound Pro Wireless Headphones', 'Electronics', 'UrbanSound', 24999.00, 'low_stock', 4, 6,
   'Over-ear active noise cancelling wireless headphones with 40 hour battery life, Bluetooth 5.3 and USB-C fast charging.',
   ARRAY['headphones','headphone','wireless headphones','urbansound','earphones','noise cancelling headphones','urbansound pro']),

  ('UC-ELEC-004', 'UrbanFit Smart Watch Series 5', 'Electronics', 'UrbanFit', 18499.00, 'in_stock', 30, 12,
   'Smart watch with a 1.8 inch AMOLED display, heart rate and SpO2 monitoring, 5ATM water resistance and 10 day battery life.',
   ARRAY['smart watch','smartwatch','watch','urbanfit','fitness watch','urbanfit watch']),

  ('UC-ELEC-005', 'ThinkBook 14 Core i5 Laptop', 'Electronics', 'Lenovo', 189999.00, 'in_stock', 8, 12,
   'Lenovo ThinkBook 14 with a 14 inch FHD display, Intel Core i5 13th generation, 16GB RAM, 512GB SSD and Windows 11.',
   ARRAY['laptop','thinkbook','lenovo','lenovo laptop','thinkbook 14','core i5 laptop','notebook']),

  ('UC-HOME-001', 'UrbanBrew Automatic Coffee Maker', 'Home', 'UrbanHome', 13499.00, 'in_stock', 18, 12,
   'Automatic drip coffee maker with a 1.5 litre carafe, 900W heating, programmable 24 hour timer and a reusable filter.',
   ARRAY['coffee maker','coffee machine','urbanbrew','coffee','drip coffee maker']),

  ('UC-ACC-001', 'UrbanCharge 20W USB-C Fast Charger', 'Accessories', 'UrbanCharge', 2499.00, 'in_stock', 120, 3,
   '20W USB-C power delivery fast charger with over-current and over-heat protection. Compatible with iPhone 15 and Galaxy S24.',
   ARRAY['charger','fast charger','usb-c charger','urbancharge','20w charger','type c charger']),

  ('UC-LIFE-001', 'UrbanCarry Everyday Backpack', 'Lifestyle', 'UrbanCarry', 6999.00, 'out_of_stock', 0, 3,
   'Water resistant 22 litre backpack with a padded 15.6 inch laptop compartment and a USB pass-through port.',
   ARRAY['backpack','bag','urbancarry','laptop bag','rucksack'])
ON CONFLICT (sku) DO UPDATE SET
  name            = EXCLUDED.name,
  price           = EXCLUDED.price,
  availability    = EXCLUDED.availability,
  stock_quantity  = EXCLUDED.stock_quantity,
  warranty_months = EXCLUDED.warranty_months,
  description     = EXCLUDED.description,
  search_aliases  = EXCLUDED.search_aliases;

-- -----------------------------------------------------------------------------
-- CUSTOMERS
-- -----------------------------------------------------------------------------
INSERT INTO customers (name, phone, email, location, preferred_channel, notes)
VALUES
  ('Ahmed Raza',    '+923001234567', 'ahmed.raza@example.com',  'Lahore',    'whatsapp',
   'Repeat customer. Prefers WhatsApp. Previously purchased a laptop.'),
  ('Sara Khan',     '+923214567890', 'sara.khan@example.com',   'Karachi',   'web_chat',  NULL),
  ('Bilal Hussain', '+923339876543', NULL,                      'Islamabad', 'voice',
   'Prefers phone calls. Speaks Urdu and English.'),
  ('Ayesha Siddiqui','+923451112233','ayesha.s@example.com',    'Lahore',    'instagram', NULL),
  ('Usman Tariq',   '+923008887766', 'usman.tariq@example.com', 'Faisalabad','web_chat',  NULL)
ON CONFLICT (phone) DO UPDATE SET
  name     = EXCLUDED.name,
  email    = COALESCE(EXCLUDED.email, customers.email),
  location = EXCLUDED.location;

-- -----------------------------------------------------------------------------
-- ORDERS
-- -----------------------------------------------------------------------------
-- Dates are relative to now() so the demo data never goes stale.

-- UC-10452 : DELAYED. This is the order quoted in the client meeting:
--            "My order UC-10452 hasn't arrived yet."
INSERT INTO orders (order_number, customer_id, status, payment_status, total_amount,
                    order_date, delivery_address, delivery_city, expected_delivery,
                    courier, tracking_number, delay_reason)
SELECT 'UC-10452', c.id, 'delayed', 'paid', 274998.00,
       now() - INTERVAL '6 days',
       'House 42, Street 7, DHA Phase 5, Lahore', 'Lahore',
       (now() - INTERVAL '2 days')::date,
       'TCS Express', 'TCS-884213907',
       'Courier hub congestion in Lahore following a public holiday backlog.'
FROM customers c WHERE c.phone = '+923001234567'
ON CONFLICT (order_number) DO UPDATE SET
  status = EXCLUDED.status, delay_reason = EXCLUDED.delay_reason,
  expected_delivery = EXCLUDED.expected_delivery;

-- UC-10453 : DELIVERED (used by the damaged-product and return scenarios)
INSERT INTO orders (order_number, customer_id, status, payment_status, total_amount,
                    order_date, delivery_address, delivery_city, expected_delivery,
                    delivered_at, courier, tracking_number)
SELECT 'UC-10453', c.id, 'delivered', 'paid', 24999.00,
       now() - INTERVAL '9 days',
       'Flat 3B, Sea Breeze Apartments, Clifton, Karachi', 'Karachi',
       (now() - INTERVAL '6 days')::date,
       now() - INTERVAL '6 days',
       'Leopards Courier', 'LCS-55219034'
FROM customers c WHERE c.phone = '+923214567890'
ON CONFLICT (order_number) DO UPDATE SET
  status = EXCLUDED.status, delivered_at = EXCLUDED.delivered_at;

-- UC-10454 : PENDING (order placed, awaiting confirmation call)
INSERT INTO orders (order_number, customer_id, status, payment_status, total_amount,
                    order_date, delivery_address, delivery_city, expected_delivery)
SELECT 'UC-10454', c.id, 'pending', 'cod_pending', 18499.00,
       now() - INTERVAL '8 hours',
       'House 12, Street 3, G-11/2, Islamabad', 'Islamabad',
       (now() + INTERVAL '3 days')::date
FROM customers c WHERE c.phone = '+923339876543'
ON CONFLICT (order_number) DO UPDATE SET status = EXCLUDED.status;

-- UC-10455 : OUT FOR DELIVERY (happy-path order status lookup)
INSERT INTO orders (order_number, customer_id, status, payment_status, total_amount,
                    order_date, delivery_address, delivery_city, expected_delivery,
                    courier, tracking_number)
SELECT 'UC-10455', c.id, 'out_for_delivery', 'paid', 15998.00,
       now() - INTERVAL '2 days',
       'House 88, Block C, Johar Town, Lahore', 'Lahore',
       now()::date,
       'M&P Express', 'MNP-33410226'
FROM customers c WHERE c.phone = '+923451112233'
ON CONFLICT (order_number) DO UPDATE SET status = EXCLUDED.status;

-- UC-10456 : DELIVERED, older - gives Ahmed Raza a purchase history so the AI
--            can "see the customer's previous information instead of starting
--            from zero".
INSERT INTO orders (order_number, customer_id, status, payment_status, total_amount,
                    order_date, delivery_address, delivery_city, expected_delivery,
                    delivered_at, courier, tracking_number)
SELECT 'UC-10456', c.id, 'delivered', 'paid', 189999.00,
       now() - INTERVAL '95 days',
       'House 42, Street 7, DHA Phase 5, Lahore', 'Lahore',
       (now() - INTERVAL '92 days')::date,
       now() - INTERVAL '92 days',
       'TCS Express', 'TCS-771002884'
FROM customers c WHERE c.phone = '+923001234567'
ON CONFLICT (order_number) DO UPDATE SET status = EXCLUDED.status;

-- -----------------------------------------------------------------------------
-- ORDER ITEMS
-- -----------------------------------------------------------------------------
INSERT INTO order_items (order_id, product_id, quantity, price)
SELECT o.id, p.id, v.quantity, v.price
FROM (VALUES
  ('UC-10452', 'UC-ELEC-001', 1, 249999.00),
  ('UC-10452', 'UC-ACC-001',  1,   2499.00),
  ('UC-10452', 'UC-ELEC-004', 1,  18499.00),
  ('UC-10453', 'UC-ELEC-003', 1,  24999.00),
  ('UC-10454', 'UC-ELEC-004', 1,  18499.00),
  ('UC-10455', 'UC-HOME-001', 1,  13499.00),
  ('UC-10455', 'UC-ACC-001',  1,   2499.00),
  ('UC-10456', 'UC-ELEC-005', 1, 189999.00)
) AS v(order_number, sku, quantity, price)
JOIN orders   o ON o.order_number = v.order_number
JOIN products p ON p.sku          = v.sku
ON CONFLICT (order_id, product_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- A PRE-EXISTING LEAD  (so the pipeline view is not empty on first run)
-- -----------------------------------------------------------------------------
INSERT INTO leads (reference, customer_id, product_id, product, budget, location,
                   purchase_intent, source, status, lead_score, is_high_value, notes)
SELECT 'LEAD-SEED-001', c.id, p.id, 'Samsung Galaxy S24', 220000.00, 'Karachi',
       'considering', 'instagram', 'contacted', 75, TRUE,
       'Asked about installment options. Sales called back once.'
FROM customers c, products p
WHERE c.phone = '+923214567890' AND p.sku = 'UC-ELEC-002'
ON CONFLICT (reference) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Keep the order-number sequence ahead of the seeded orders so that any new
-- order created by the application cannot collide with UC-10452..UC-10456.
-- -----------------------------------------------------------------------------
SELECT setval('seq_order_number',
              GREATEST(
                (SELECT COALESCE(MAX(substring(order_number FROM 4)::int), 10500) FROM orders),
                10500
              ) + 1,
              FALSE);
