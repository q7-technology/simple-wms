# Simple WMS — process flows

Every task ends in a ledger line. Every ledger line can become an event.
Gold (dashed) paths in the diagrams are exceptions.

## Overview

```mermaid
flowchart TB
  subgraph in[API in]
    A1[ERP: deliveries, receipts] ; A2[Production orders] ; A3[Transfers, replenishments] ; A4[Web store, CSV import]
  end
  subgraph tasks[Tasks]
    R[Receive] --> P[Put away] --> RP[Replenish] --> PK[Pick] --> PA[Pack] --> S[Ship]
    T[Transfer · count · move]
  end
  L[(Append-only stock ledger)]
  subgraph out[Events out · one envelope, durable queue, HMAC signed]
    E1[ERP: goods issue / receipt] ; E2[Carriers: tracking] ; E3[EDI broker: ASN] ; E4[Platen: labels and pages]
  end
  in --> tasks --> L --> out
```

## Flow 1 — Outbound delivery

```mermaid
flowchart LR
  A([POST /deliveries]) --> D{Same message_id?}
  D -- new --> R[Reserve stock · FIFO] --> M{Pick mode?} --> T[Create pick task · walk by pick sequence]
  D -- duplicate --> X([Same reply, nothing happens])
  T --> PK[Scanner: pick lines] --> F{All found?}
  F -- yes --> PA[Pack cartons]
  F -. no .-> SR[Short reason + supervisor badge] -. ship short .-> PA
  SR -.-> C[Count task for that shelf]
  PA --> PL[Platen: carton-label]
  PA --> S[Ship · ledger: stock leaves] --> E([delivery.shipped → ERP, carrier, EDI])
```

## Flow 2 — Inbound receipt and putaway

```mermaid
flowchart LR
  A([POST /receipts or ASN or CSV]) --> W[Expected receipt at a dock] --> SC[Scan product · GS1 fills batch + qty] --> Q[Confirm quantity]
  Q --> TOL{Within tolerance?}
  TOL -- yes --> SG[Suggest shelf: same SKU → zone → any → overflow]
  TOL -. no .-> SUP[Supervisor badge or close short] -.-> SG
  SG --> SH[Scan shelf · override allowed] --> L[Ledger line · +qty, received date]
  L --> PL[Platen: location-label] & E([receipt.confirmed])
```

## Flow 3 — Production

```mermaid
flowchart LR
  A([POST /production-orders]) --> R[Reserve components] --> PK[Pick components] --> DR[Drop at line-side] --> E1([production.components_issued])
  DR --> LINE[[Line makes product]] --> SP[Scan production order QR · SKU + batch read-only] --> PQ[Pallet quantity · running total]
  PQ --> TOL{Over tolerance?}
  TOL -. yes .-> SUP[Supervisor badge] -.-> SH
  TOL -- no --> SH[Scan shelf]
  SH --> CFG{ERP counted GR?}
  CFG -- yes --> B([Bins only, ERP told nothing])
  CFG -- no --> E2([production.received → ERP posts GR])
```

## Flow 4 — Cross-warehouse transfer

```mermaid
flowchart LR
  A([POST /transfers]) --> PK[Sender: pick and pack] --> SH[Ship · stock → in-transit bucket] --> E1([transfer.shipped · leg 1])
  SH --> RD[[On the road · batch + received date travel]] --> EX[Receiver: expected receipt auto-created] --> RC[Scan and count] --> V{Matches?}
  V -- yes --> PA[Put away · out of in-transit] --> E2([transfer.received · leg 2])
  V -. no .-> OPEN[Variance stays in transit] -.-> CL[Close with reason] -.-> ADJ([stock.adjusted]) -.-> E2
```

## Flow 5 — Replenishment and cycle count

```mermaid
flowchart LR
  T1([Pick face below min]) & T2([POST /replenishments]) & T3([Manual]) --> REP[Replen task · FIFO source] --> MV[Scan from → to] --> L([Ledger move · replenishment.completed])
  C1([Count schedule or short-pick trigger]) --> BC[Blind count] --> M{Matches?}
  M -- yes --> OK([Location verified])
  M -. no .-> RC[Recount] & AP[Supervisor approves with reason] -.-> ADJ([Ledger adjust · stock.adjusted])
```

## Flow 6 — Events and print jobs (the durable queue)

```mermaid
flowchart LR
  L([Ledger line written]) --> EV[Build event · one envelope] --> SUB{Who subscribes?} --> Q[Queue per subscriber · HMAC] --> SEND[POST to their URL] --> OK{2xx?}
  OK -- yes --> DONE([Delivered · status stored])
  OK -. no .-> RETRY[Retry with backoff · 1 min, 5, 30, 2 h] -.-> UI[Shown on Integrations page] -.-> MAN[Retry now / fix URL] -.-> SEND
  DONE -. print job .-> PL[[Platen renders template + JSON → printer]]
```

The full swimlane versions (ERP/API, WMS engine, Scanner, outside systems)
are in `design/flows/` and on the "Process flows" page of the Simple WMS UI
design file.
