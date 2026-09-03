# UrbanCart — Architecture Diagrams

All diagrams are Mermaid. They render natively on GitHub, in VS Code (Markdown
Preview Mermaid extension), in Notion, and at <https://mermaid.live>.

---

## 1. System architecture

```mermaid
flowchart TB
    subgraph CH["CUSTOMER CHANNELS"]
        WEB["Website chat"]
        WA["WhatsApp"]
        IG["Instagram"]
        PHONE["Phone call"]
    end

    subgraph AI["AI INTERACTION LAYER"]
        VAPI["Vapi<br/><i>voice: telephony, STT,<br/>turn loop, TTS</i>"]
        CHAT["Chat API<br/><i>/api/chat</i>"]
    end

    N8N{{"n8n<br/><b>ORCHESTRATION</b><br/>7 workflows"}}

    subgraph BE["BACKEND SERVICES"]
        INTENT["Intent + entity<br/>extraction"]
        RAGSVC["RAG<br/>retrieve → ground → answer"]
        BIZ["Product · Order · Customer<br/>Lead · Escalation"]
        GUARD["Confidence gate<br/>+ hallucination guard"]
    end

    subgraph DATA["DATA STORES"]
        PG[("PostgreSQL<br/><b>system of record</b><br/>customers · products · orders<br/>order_items · leads · conversations<br/>tickets · tasks · executions · outbox")]
        SB[("Supabase / pgvector<br/><b>knowledge</b><br/>documents · document_chunks<br/>embeddings")]
    end

    subgraph OUT["BUSINESS SURFACES"]
        AT["Airtable<br/><i>operational UI</i>"]
        SLACK["Slack<br/><i>selective alerts</i>"]
        ZAP["Zapier<br/><i>CRM · email · calendar</i>"]
        NOTION["Notion<br/><i>internal handbook</i>"]
    end

    subgraph KB["KNOWLEDGE PIPELINE"]
        GD[("Google Drive<br/>Products · Shipping · Returns<br/>Warranty · Support · Training")]
        ING["Ingestion<br/>extract → clean → chunk<br/>→ embed"]
    end

    WEB --> CHAT
    WA  --> CHAT
    IG  --> CHAT
    PHONE --> VAPI

    CHAT --> N8N
    VAPI --> N8N
    N8N --> BE

    INTENT --> BIZ
    INTENT --> RAGSVC
    RAGSVC --> GUARD
    GUARD -->|"grounded"| CHAT
    GUARD -->|"not grounded"| BIZ

    BIZ  <--> PG
    RAGSVC --> SB

    BIZ -->|"mirror"| AT
    BIZ -->|"4 event types only"| SLACK
    BIZ -->|"high-value lead"| ZAP

    GD --> ING
    ING --> SB

    NOTION -.->|"docs published from git"| OUT

    classDef store fill:#1e3a5f,stroke:#4f8cff,color:#fff
    classDef orch fill:#4a2c5e,stroke:#b478ff,color:#fff
    classDef ai fill:#1f4d3d,stroke:#3fb950,color:#fff
    class PG,SB,GD store
    class N8N orch
    class VAPI,CHAT,RAGSVC ai
```

---

## 2. RAG pipeline — document to grounded answer

```mermaid
flowchart LR
    A["Google Drive<br/>PDF · DOCX · XLSX"] --> B["Detect new<br/>or changed<br/><i>SHA-256 hash</i>"]
    B -->|unchanged| B1["Skip<br/><i>no embedding cost</i>"]
    B -->|changed| C["Download"]
    C --> D["Extract text<br/><i>unpdf · mammoth<br/>· exceljs</i>"]
    D --> E["Clean<br/><i>de-hyphenate, strip<br/>headers, unescape</i>"]
    E --> F["Chunk<br/><i>heading-aware,<br/>900 chars, 150 overlap</i>"]
    F --> G["Embed<br/><i>1536-dim</i>"]
    G --> H[("Supabase<br/>pgvector<br/>HNSW index")]

    I["Customer question"] --> J["Classify intent"]
    J --> K["Pick document types<br/><i>metadata filter</i>"]
    K --> L["Embed question"]
    L --> M["Cosine search<br/><i>match_document_chunks</i>"]
    H --> M
    M --> N{"Confidence<br/>≥ threshold?"}
    N -->|"no"| O["ESCALATE<br/><i>ticket + human</i>"]
    N -->|"yes"| P["LLM with<br/>grounding prompt"]
    P --> Q{"Numeric claims<br/>traceable to<br/>evidence?"}
    Q -->|"no"| O
    Q -->|"yes"| R["Grounded answer<br/>+ sources"]

    style O fill:#5c2626,stroke:#f85149,color:#fff
    style R fill:#1f4d3d,stroke:#3fb950,color:#fff
    style N fill:#5c4a1a,stroke:#d29922,color:#fff
    style Q fill:#5c4a1a,stroke:#d29922,color:#fff
```

---

## 3. One chat turn — decision flow

```mermaid
flowchart TD
    START["Customer message"] --> V{"Valid?"}
    V -->|no| SAFE["Safe rephrase request"]
    V -->|yes| CLS["Classify intent<br/>+ extract entities"]

    CLS --> ESC{"Escalation<br/>signal?"}
    ESC -->|"damaged · angry ·<br/>refund · wants human"| TICKET["Create ticket + task<br/>Slack #support<br/>Airtable mirror"]
    TICKET --> HUMAN["Polite handover<br/><i>requiresHuman = true</i>"]

    ESC -->|no| ROUTE{"Intent"}

    ROUTE -->|order_status| ORD{"Order number<br/>present?"}
    ORD -->|no| ASKORD["Ask for it"]
    ORD -->|yes| VERIFY{"Caller owns<br/>the order?"}
    VERIFY -->|no| DENY["Ask to verify<br/><i>reveal nothing</i>"]
    VERIFY -->|yes| ORDANS["Status from PostgreSQL"]
    ORDANS --> OVERDUE{"Overdue?"}
    OVERDUE -->|yes| OPSALERT["Slack #support<br/>order issue"]

    ROUTE -->|"availability ·<br/>price"| PROD["PostgreSQL products<br/><i>exact, no LLM</i>"]

    ROUTE -->|lead_capture| FIELDS{"name + phone<br/>+ product?"}
    FIELDS -->|no| ASKF["Ask for the<br/>missing one"]
    FIELDS -->|yes| DEDUP{"Duplicate<br/>in 24h?"}
    DEDUP -->|yes| SAMELEAD["Reuse lead<br/><i>no second alert</i>"]
    DEDUP -->|no| SCORE["Score lead"]
    SCORE --> HV{"High value?"}
    HV -->|yes| NOTIFY["Slack #sales<br/>+ Zapier → CRM"]
    HV -->|no| QUIET["Store only<br/><i>suppression logged</i>"]

    ROUTE -->|"policy ·<br/>product info"| RAG["RAG retrieve"]
    RAG --> CONF{"Grounded?"}
    CONF -->|no| TICKET
    CONF -->|yes| ANSWER["Grounded answer<br/>+ sources"]

    style TICKET fill:#5c2626,stroke:#f85149,color:#fff
    style HUMAN fill:#5c2626,stroke:#f85149,color:#fff
    style NOTIFY fill:#1f4d3d,stroke:#3fb950,color:#fff
    style ANSWER fill:#1f4d3d,stroke:#3fb950,color:#fff
    style DENY fill:#5c4a1a,stroke:#d29922,color:#fff
```

---

## 4. Data model

```mermaid
erDiagram
    CUSTOMERS ||--o{ ORDERS : places
    CUSTOMERS ||--o{ LEADS : generates
    CUSTOMERS ||--o{ CONVERSATIONS : has
    CUSTOMERS ||--o{ SUPPORT_TICKETS : raises
    ORDERS    ||--|{ ORDER_ITEMS : contains
    PRODUCTS  ||--o{ ORDER_ITEMS : "sold as"
    PRODUCTS  ||--o{ LEADS : "interested in"
    CONVERSATIONS ||--o{ CONVERSATION_MESSAGES : contains
    CONVERSATIONS ||--o{ SUPPORT_TICKETS : escalates_to
    ORDERS    ||--o{ SUPPORT_TICKETS : about
    SUPPORT_TICKETS ||--o{ TASKS : "assigned as"
    LEADS     ||--o{ TASKS : "followed up by"
    DOCUMENTS ||--|{ DOCUMENT_CHUNKS : "chunked into"

    CUSTOMERS {
        uuid id PK
        text phone UK "E.164, cross-channel key"
        text name
        text email UK
        text location
    }
    PRODUCTS {
        uuid id PK
        text sku UK
        numeric price "PKR"
        text availability
        int stock_quantity
        text[] search_aliases
    }
    ORDERS {
        uuid id PK
        text order_number UK "UC-10452"
        uuid customer_id FK
        text status
        numeric total_amount
        date expected_delivery
    }
    LEADS {
        uuid id PK
        text reference UK "LEAD-001"
        uuid customer_id FK
        numeric budget
        text purchase_intent
        int lead_score
        bool is_high_value
    }
    SUPPORT_TICKETS {
        uuid id PK
        text reference UK "SUP-001"
        text issue_type
        text priority
        text assigned_team
    }
    TASKS {
        uuid id PK
        text reference UK "TASK-001"
        uuid ticket_id FK
        uuid lead_id FK
        text assigned_team
    }
    DOCUMENTS {
        uuid id PK
        text content_hash "change detection"
        int version
        text status "active|superseded"
        text document_type
    }
    DOCUMENT_CHUNKS {
        uuid id PK
        uuid document_id FK
        vector embedding "1536"
        jsonb metadata
    }
```

---

## 5. Platform responsibilities

```mermaid
flowchart LR
    subgraph OURS["OURS — engineering owns, on the latency path"]
        direction TB
        N["n8n<br/>orchestration"]
        B["Backend API<br/>business logic"]
        P[("PostgreSQL<br/>system of record")]
        S[("Supabase<br/>vectors")]
    end

    subgraph THEIRS["THEIRS — business owns, off the latency path"]
        direction TB
        A["Airtable<br/>daily operations"]
        Z["Zapier<br/>CRM + sales stack"]
        G[("Google Drive<br/>source documents")]
        NO["Notion<br/>documentation"]
    end

    subgraph EDGE["EDGE — customer contact"]
        direction TB
        V["Vapi<br/>voice"]
        C["Chat UI<br/>web · WhatsApp"]
    end

    SL["Slack<br/>4 alert types only"]

    EDGE --> OURS
    OURS -->|"after commit"| THEIRS
    OURS -->|"important events"| SL
    G -->|"ingestion"| S

    classDef ours fill:#1e3a5f,stroke:#4f8cff,color:#fff
    classDef theirs fill:#4a3a1e,stroke:#d29922,color:#fff
    classDef edge fill:#1f4d3d,stroke:#3fb950,color:#fff
    class N,B,P,S ours
    class A,Z,G,NO theirs
    class V,C edge
```

---

## 6. Escalation and notification policy

```mermaid
flowchart TD
    EV["Event occurs"] --> Q{"Which class?"}

    Q -->|"High-value lead<br/>budget ≥ Rs.150k<br/>or score ≥ 70"| S1["Slack #sales<br/>+ Zapier → CRM"]
    Q -->|"Damaged product ·<br/>complex refund ·<br/>angry customer ·<br/>wants a human"| S2["Slack #support<br/>urgent ticket + task"]
    Q -->|"Automation failure"| S3["Slack #alerts<br/>workflow_executions row"]
    Q -->|"Order >3 days<br/>overdue"| S4["Slack #support<br/>order issue"]

    Q -->|"Normal question ·<br/>normal lead ·<br/>low AI confidence"| NONE["NO Slack<br/><i>stored + visible in<br/>Airtable and /api/admin;<br/>suppression logged<br/>with its reason</i>"]

    style S1 fill:#1f4d3d,stroke:#3fb950,color:#fff
    style S2 fill:#5c2626,stroke:#f85149,color:#fff
    style S3 fill:#5c4a1a,stroke:#d29922,color:#fff
    style S4 fill:#5c2626,stroke:#f85149,color:#fff
    style NONE fill:#2a2f3a,stroke:#9aa3b2,color:#fff
```

---

## 7. Failure handling

```mermaid
sequenceDiagram
    participant C as Customer
    participant N as n8n
    participant B as Backend
    participant D as PostgreSQL
    participant S as Slack #alerts

    C->>N: "Can I return this?"
    N->>B: POST /api/chat
    B->>D: retrieve knowledge
    D--xB: connection refused

    Note over B: AppError(DATABASE_ERROR)<br/>safeMessage set, notify = true

    B->>D: record failed execution
    Note over B,D: best-effort; failure here<br/>must not mask the original
    B->>S: ⚠️ Automation Failed<br/>(internal detail)
    B-->>N: 200 + safe customer message
    N-->>C: "I'm having trouble with that<br/>right now. Our team has been<br/>notified and will follow up."

    Note over C: never sees a stack trace,<br/>a SQL error, or a 500
```
