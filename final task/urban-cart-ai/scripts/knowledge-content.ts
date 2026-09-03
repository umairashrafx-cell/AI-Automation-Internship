/**
 * Source content for UrbanCart's knowledge base.
 *
 * These are the documents the client said they would provide: "a product
 * catalog, return policy, shipping policy, warranty information and customer
 * support guidelines... some are PDFs, some are Word documents and some
 * information is maintained in spreadsheets."
 *
 * Held here as structured data so `scripts/generate-knowledge-base.ts` can
 * render the SAME content into real .pdf, .docx and .xlsx files. The RAG
 * pipeline then reads those binary files exactly as it would read files
 * downloaded from Google Drive - the demo never shortcuts to plain text.
 */

export interface DocSection {
  heading: string;
  paragraphs: string[];
}

export interface TextDocument {
  /** Output path relative to knowledge-base/ */
  path: string;
  title: string;
  subtitle: string;
  effectiveDate: string;
  sections: DocSection[];
}

/* ========================================================================== */
/* RETURN POLICY (PDF)                                                        */
/* ========================================================================== */

export const RETURN_POLICY: TextDocument = {
  path: 'Returns/urbancart-return-policy.pdf',
  title: 'UrbanCart Return and Refund Policy',
  subtitle: 'Applies to all orders placed on urbancart.pk, WhatsApp and Instagram',
  effectiveDate: '2026-07-01',
  sections: [
    {
      heading: '1. Standard Return Window',
      paragraphs: [
        'Customers may request a return within 14 days of delivery for most products. The 14 day period is counted from the date the order is marked as delivered in our system, not from the date the order was placed.',
        'The product must be returned in its original packaging, with all accessories, manuals, cables and free promotional items included. Products that are returned incomplete may be refused or may be subject to a deduction equal to the retail value of the missing items.',
      ],
    },
    {
      heading: '2. Shorter Return Window for Audio and Personal-Use Products',
      paragraphs: [
        'For hygiene reasons, headphones, earphones, earbuds, wireless audio products, smart watches, fitness bands and any product worn on the body may only be returned within 7 days of delivery.',
        'This 7 day limit is strict. A return request for headphones or earbuds made after 7 days from delivery will not be accepted under the standard return policy. If the product is faulty rather than unwanted, it is handled under the warranty policy instead, which has a much longer coverage period.',
        'Audio products may only be returned if the seal on the packaging is intact. An opened pair of earbuds cannot be returned simply because the customer changed their mind.',
      ],
    },
    {
      heading: '3. Products That Cannot Be Returned',
      paragraphs: [
        'The following are not eligible for return under any circumstances: items marked as final sale or clearance, gift cards, downloadable or digital products, consumable items, and products that have been physically damaged by the customer after delivery.',
        'Software, activation codes and subscription products cannot be returned once the code has been revealed or redeemed.',
      ],
    },
    {
      heading: '4. How to Request a Return',
      paragraphs: [
        'A return is requested by contacting UrbanCart support with the order number, which is in the format UC-10452. Support will confirm eligibility and arrange a pickup with our courier partner.',
        'Return pickup is free of charge when the return is caused by UrbanCart: a damaged item, a wrong item, or a defective product. When the return is a change of mind, a pickup charge of Rs. 300 is deducted from the refund.',
      ],
    },
    {
      heading: '5. Refund Processing Times',
      paragraphs: [
        'Once the returned product has been received and inspected at our Lahore warehouse, the refund is approved within 2 working days.',
        'Refunds to a bank account or debit card are credited within 7 to 10 working days. Refunds for cash on delivery orders are issued by bank transfer, and the customer must provide their account details. Store credit refunds are applied immediately on approval.',
      ],
    },
    {
      heading: '6. Damaged or Incorrect Items on Arrival',
      paragraphs: [
        'If a product arrives damaged, or the wrong product was delivered, the customer must report it within 48 hours of delivery with photographs of the item and the outer packaging.',
        'Damaged and incorrect deliveries are always escalated to a human support agent. They are never resolved automatically, and the customer is not charged any pickup fee. A replacement is dispatched as soon as the report is verified.',
      ],
    },
    {
      heading: '7. Exchanges',
      paragraphs: [
        'A product may be exchanged for a different variant of the same product, such as a different colour or storage size, within the applicable return window, provided the replacement variant is in stock.',
        'If the replacement variant is more expensive, the customer pays the difference. If it is cheaper, the difference is refunded as store credit.',
      ],
    },
  ],
};

/* ========================================================================== */
/* SHIPPING POLICY (PDF)                                                      */
/* ========================================================================== */

export const SHIPPING_POLICY: TextDocument = {
  path: 'Shipping/urbancart-shipping-policy.pdf',
  title: 'UrbanCart Shipping and Delivery Policy',
  subtitle: 'Nationwide delivery across Pakistan',
  effectiveDate: '2026-07-01',
  sections: [
    {
      heading: '1. Delivery Coverage',
      paragraphs: [
        'UrbanCart delivers to all major cities in Pakistan, including Lahore, Karachi, Islamabad, Rawalpindi, Faisalabad, Multan, Peshawar and Quetta. We also deliver to most smaller towns through our courier partners.',
        'Yes, we deliver to Lahore. Lahore is a Zone A city and is also the location of our main warehouse, so it receives the fastest delivery times we offer.',
      ],
    },
    {
      heading: '2. Delivery Timelines by Zone',
      paragraphs: [
        'Zone A covers Lahore, Karachi, Islamabad and Rawalpindi. Orders to Lahore are delivered within 1 to 2 working days. Orders to Karachi, Islamabad and Rawalpindi are delivered within 2 to 3 working days.',
        'Zone B covers Faisalabad, Multan and Peshawar, with delivery in 2 to 4 working days. Zone C covers Quetta and remote areas, with delivery in 4 to 6 working days.',
        'Working days are Monday to Saturday. Sundays and public holidays are excluded from all delivery estimates.',
      ],
    },
    {
      heading: '3. Order Processing',
      paragraphs: [
        'Orders confirmed before 4:00 PM on a working day are dispatched the same day. Orders confirmed after 4:00 PM are dispatched the next working day.',
        'High value orders above Rs. 100,000 require a confirmation call before dispatch. This is a fraud-prevention measure and typically adds a few hours to processing.',
      ],
    },
    {
      heading: '4. Delivery Charges',
      paragraphs: [
        'Delivery is free for all orders above Rs. 5,000. For orders below Rs. 5,000 a flat delivery charge of Rs. 250 applies.',
        'Cash on delivery is available nationwide for orders up to Rs. 150,000 and carries an additional handling fee of Rs. 150. Orders above Rs. 150,000 must be prepaid.',
      ],
    },
    {
      heading: '5. Tracking an Order',
      paragraphs: [
        'A tracking number is sent by SMS and email as soon as the order is handed to the courier. Order status can also be checked at any time by giving the order number, which is in the format UC-10452, to our support team or assistant.',
        'The status values used are pending, confirmed, processing, shipped, out for delivery, delivered, delayed, cancelled and returned.',
      ],
    },
    {
      heading: '6. Delayed Deliveries',
      paragraphs: [
        'Deliveries can be delayed by weather, public holidays, political situations or courier capacity during sale periods. When a delay is known, the order is marked as delayed and the reason is recorded against the order.',
        'If an order is more than 3 working days past its expected delivery date, it is treated as a serious delivery issue and is escalated to the operations team for manual follow-up with the courier.',
      ],
    },
    {
      heading: '7. Failed Delivery Attempts',
      paragraphs: [
        'Our courier partners make up to 3 delivery attempts. If all 3 attempts fail because the customer is unreachable, the order is returned to our warehouse.',
        'For a prepaid order that is returned in this way, a refund is issued minus the actual delivery cost. Repeatedly refused cash on delivery orders may result in the customer being restricted to prepaid orders only.',
      ],
    },
  ],
};

/* ========================================================================== */
/* WARRANTY POLICY (DOCX)                                                     */
/* ========================================================================== */

export const WARRANTY_POLICY: TextDocument = {
  path: 'Warranty/urbancart-warranty-policy.docx',
  title: 'UrbanCart Warranty Policy',
  subtitle: 'Manufacturer and UrbanCart warranty coverage',
  effectiveDate: '2026-07-01',
  sections: [
    {
      heading: '1. Warranty Coverage by Category',
      paragraphs: [
        'Smartphones and tablets carry a 12 month manufacturer warranty from the date of delivery. Laptops and computers carry a 12 month manufacturer warranty, extendable to 24 months on selected models.',
        'Headphones, earbuds and other audio products carry a 6 month warranty. Smart watches and wearables carry a 12 month warranty. Home appliances carry a 12 month warranty on parts and a 6 month warranty on labour.',
        'Accessories such as cases, screen protectors, cables and chargers carry a 3 month warranty against manufacturing defects.',
      ],
    },
    {
      heading: '2. What the Warranty Covers',
      paragraphs: [
        'The warranty covers manufacturing defects and hardware failures that occur under normal use. This includes a device that will not power on, a battery that fails to hold charge within the warranty period, dead pixels beyond the manufacturer threshold, and faulty buttons, ports or speakers.',
        'A warranty claim results in repair, replacement with an identical unit, or a refund, decided in that order and at UrbanCart\'s discretion after inspection.',
      ],
    },
    {
      heading: '3. What the Warranty Does Not Cover',
      paragraphs: [
        'The warranty does not cover physical damage, cracked screens, liquid or water damage, damage caused by voltage fluctuation or use of a non-approved charger, normal cosmetic wear, or any device on which the serial number has been removed or altered.',
        'Unauthorised repair immediately voids the warranty. Any device opened by a third-party repair shop is no longer eligible for a claim.',
        'Software issues, operating system updates and app compatibility problems are not hardware defects and are not covered.',
      ],
    },
    {
      heading: '4. Making a Warranty Claim',
      paragraphs: [
        'A warranty claim requires the UrbanCart order number, which is in the format UC-10452, and a description of the fault. The original invoice serves as the warranty certificate, so no separate warranty card is required.',
        'The customer does not need to keep the original box to make a warranty claim, although keeping it makes the process faster.',
      ],
    },
    {
      heading: '5. Warranty Turnaround Time',
      paragraphs: [
        'Warranty inspection is completed within 3 working days of receiving the product. Repairs handled in-house are completed within 7 to 10 working days.',
        'Claims that must be sent to the manufacturer\'s service centre can take 15 to 30 working days. The customer is informed of the expected timeline once the claim is registered.',
      ],
    },
    {
      heading: '6. Warranty Versus Return',
      paragraphs: [
        'A return is for an unwanted product and is limited to the return window, which is 14 days for most products and 7 days for audio and wearable products.',
        'A warranty claim is for a faulty product and is available for the full warranty period of that category. A customer whose headphones have stopped working after 3 months cannot return them, but can make a warranty claim because audio products carry a 6 month warranty.',
      ],
    },
  ],
};

/* ========================================================================== */
/* SUPPORT GUIDELINES (DOCX)                                                  */
/* ========================================================================== */

export const SUPPORT_GUIDELINES: TextDocument = {
  path: 'Support/urbancart-support-guidelines.docx',
  title: 'UrbanCart Customer Support Guidelines',
  subtitle: 'Internal handling standards for support and AI-assisted channels',
  effectiveDate: '2026-07-01',
  sections: [
    {
      heading: '1. Support Availability',
      paragraphs: [
        'Human support agents are available from 9:00 AM to 9:00 PM, Monday to Saturday. The AI assistant answers on the website, WhatsApp and the phone line 24 hours a day, 7 days a week.',
        'Messages received outside working hours are answered immediately by the AI assistant where the answer is documented, and are queued for a human agent at the start of the next working day where they are not.',
      ],
    },
    {
      heading: '2. What the AI Assistant May Answer',
      paragraphs: [
        'The assistant may answer questions about product availability, price, delivery coverage and timelines, the return policy, the warranty policy and the status of an existing order.',
        'The assistant must answer only from UrbanCart\'s own documents and database. It must never estimate, assume or generalise a price, a delivery time, a return window or a warranty term. If the information is not available, the assistant must say that human assistance is required rather than guessing.',
      ],
    },
    {
      heading: '3. Cases That Must Be Escalated to a Human',
      paragraphs: [
        'A conversation must be handed to a human agent when a product has arrived damaged, when a refund request is complicated or disputed, when the customer is angry or abusive, when required information is missing, or when the assistant cannot answer confidently from the knowledge base.',
        'Escalation is not a failure. Handing a case to a person early is always preferable to giving a customer an answer that turns out to be wrong.',
      ],
    },
    {
      heading: '4. Response Time Targets',
      paragraphs: [
        'Urgent priority issues must receive a human response within 1 hour. High priority issues must receive a response within 4 hours. Medium priority issues are answered within 1 working day, and low priority issues within 2 working days.',
        'A damaged product report and an angry customer are always logged as high priority at minimum.',
      ],
    },
    {
      heading: '5. Tone and Language',
      paragraphs: [
        'Support communication is polite, brief and direct. Acknowledge the customer\'s frustration before presenting facts. Never argue with a customer, and never blame the courier, the manufacturer or another department in front of the customer.',
        'Amounts are always written in Pakistani Rupees in the format Rs. 200,000. Order numbers are always quoted in full, for example UC-10452.',
      ],
    },
    {
      heading: '6. Protecting Customer Information',
      paragraphs: [
        'Order details are only shared after the caller has been verified. Verification means the caller can confirm the phone number on the order or the full name on the order.',
        'Full delivery addresses, payment details and other customers\' information are never read out. If verification fails, the case is passed to a human agent rather than refused outright.',
      ],
    },
    {
      heading: '7. Internal Notifications',
      paragraphs: [
        'Slack notifications are reserved for events that need action: a high value sales lead, a serious customer complaint, a failed automation, or an important order issue.',
        'Ordinary customer questions must never notify the team. Every conversation is recorded and visible in Airtable and the admin dashboard, so nothing is lost by staying quiet.',
      ],
    },
  ],
};

/* ========================================================================== */
/* AGENT TRAINING (Markdown)                                                  */
/* ========================================================================== */

export const AGENT_TRAINING: TextDocument = {
  path: 'Training/urbancart-agent-training.md',
  title: 'UrbanCart Agent Training Notes',
  subtitle: 'Frequently asked questions and the approved way to answer them',
  effectiveDate: '2026-07-01',
  sections: [
    {
      heading: '1. Payment Methods',
      paragraphs: [
        'UrbanCart accepts cash on delivery, bank transfer, debit and credit cards, and mobile wallets including JazzCash and Easypaisa.',
        'Card payments are processed by our payment partner. UrbanCart never stores card numbers, and support agents must never ask a customer to read out a card number, CVV or one-time password.',
      ],
    },
    {
      heading: '2. Installment Plans',
      paragraphs: [
        'Installment plans are available on orders above Rs. 50,000 through partner banks, with tenures of 3, 6 or 12 months.',
        'Installment eligibility is decided by the customer\'s bank, not by UrbanCart. Agents must not promise approval.',
      ],
    },
    {
      heading: '3. Order Cancellation',
      paragraphs: [
        'An order can be cancelled free of charge at any time before it is dispatched. Once the order status is shipped or out for delivery, it can no longer be cancelled and must be handled as a return after delivery.',
        'A prepaid order cancelled before dispatch is refunded in full within 7 to 10 working days.',
      ],
    },
    {
      heading: '4. Product Authenticity',
      paragraphs: [
        'All products sold by UrbanCart are 100 percent original and sourced from authorised distributors. UrbanCart does not sell refurbished or used products unless the listing explicitly says so.',
        'Every smartphone sold is PTA approved unless the listing states otherwise.',
      ],
    },
    {
      heading: '5. Bulk and Corporate Orders',
      paragraphs: [
        'Orders of 5 units or more of the same product qualify as bulk orders and are handled by the sales team, not by standard support.',
        'Bulk enquiries must always be captured as a sales lead with the customer name, phone number, product, quantity, budget and location, and passed to the sales team.',
      ],
    },
    {
      heading: '6. Identifying a Sales Lead',
      paragraphs: [
        'A customer is a sales lead when they express intent to buy: asking for the best price, asking about installment options, asking whether a product is available in a specific city, or asking how to place an order.',
        'The information to collect is always the same: name, phone number, the product they are interested in, their approximate budget, their location, and whether they are ready to purchase now or still comparing options.',
      ],
    },
  ],
};

export const TEXT_DOCUMENTS: TextDocument[] = [
  RETURN_POLICY,
  SHIPPING_POLICY,
  WARRANTY_POLICY,
  SUPPORT_GUIDELINES,
  AGENT_TRAINING,
];

/* ========================================================================== */
/* PRODUCT CATALOGUE (XLSX)                                                   */
/* ========================================================================== */

/**
 * The catalogue spreadsheet is descriptive information for RAG only.
 *
 * Price and stock in the RAG index would go stale the moment someone edits the
 * products table, so the assistant is instructed to take price and availability
 * from the live database and to use this document only for specifications.
 */
export const PRODUCT_CATALOG_SHEET = {
  path: 'Products/urbancart-product-catalog.xlsx',
  sheetName: 'Product Catalog',
  header: [
    'SKU',
    'Product Name',
    'Category',
    'Brand',
    'Key Specifications',
    'In The Box',
    'Warranty',
    'Notes',
  ],
  rows: [
    [
      'UC-ELEC-001',
      'iPhone 15',
      'Electronics',
      'Apple',
      '6.1 inch Super Retina XDR display, A16 Bionic chip, 128GB storage, 48MP main camera, USB-C charging port',
      'iPhone 15, USB-C cable, documentation',
      '12 months',
      'PTA approved. Available in black, blue, pink and yellow.',
    ],
    [
      'UC-ELEC-002',
      'Samsung Galaxy S24',
      'Electronics',
      'Samsung',
      '6.2 inch Dynamic AMOLED 2X display, Snapdragon 8 Gen 3, 256GB storage, 50MP triple camera',
      'Galaxy S24, USB-C cable, SIM tool',
      '12 months',
      'PTA approved. Dual SIM supported.',
    ],
    [
      'UC-ELEC-003',
      'UrbanSound Pro Wireless Headphones',
      'Electronics',
      'UrbanSound',
      'Over-ear active noise cancelling, 40 hour battery life, Bluetooth 5.3, USB-C fast charge',
      'Headphones, carry case, USB-C cable, 3.5mm audio cable',
      '6 months',
      'Audio product: 7 day return window only, and only if the packaging seal is intact.',
    ],
    [
      'UC-ELEC-004',
      'UrbanFit Smart Watch Series 5',
      'Electronics',
      'UrbanFit',
      '1.8 inch AMOLED display, heart rate and SpO2 monitoring, 5ATM water resistance, 10 day battery life',
      'Watch, magnetic charger, spare strap',
      '12 months',
      'Wearable product: 7 day return window only.',
    ],
    [
      'UC-ELEC-005',
      'ThinkBook 14 Core i5 Laptop',
      'Electronics',
      'Lenovo',
      '14 inch FHD display, Intel Core i5 13th generation, 16GB RAM, 512GB SSD, Windows 11',
      'Laptop, 65W charger, warranty documentation',
      '12 months, extendable to 24 months',
      'Business laptop. Backlit keyboard, fingerprint reader.',
    ],
    [
      'UC-HOME-001',
      'UrbanBrew Automatic Coffee Maker',
      'Home',
      'UrbanHome',
      '1.5 litre capacity, 900W, programmable 24 hour timer, reusable filter, keep-warm plate',
      'Coffee maker, glass carafe, measuring spoon, manual',
      '12 months parts, 6 months labour',
      'Home appliance. Not eligible for return once used for hygiene reasons.',
    ],
    [
      'UC-ACC-001',
      'UrbanCharge 20W USB-C Fast Charger',
      'Accessories',
      'UrbanCharge',
      '20W power delivery, USB-C output, over-current and over-heat protection',
      'Charger, 1 metre USB-C cable',
      '3 months',
      'Compatible with iPhone 15 and Galaxy S24.',
    ],
    [
      'UC-LIFE-001',
      'UrbanCarry Everyday Backpack',
      'Lifestyle',
      'UrbanCarry',
      'Water resistant fabric, padded 15.6 inch laptop compartment, USB pass-through port, 22 litre capacity',
      'Backpack',
      '3 months against manufacturing defects',
      'Lifestyle product. Standard 14 day return window applies.',
    ],
  ],
};
