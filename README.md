# AuctionLive – Live Auction Platform

A real-time, single-server auction platform with anti-sniping, concurrency-safe bidding, and SSE-powered live updates.

---

## 🚀 Quick Start

### Prerequisites
- Node.js v20 or later (`node --version` to verify)

### Install & Run

```bash
# 1. Install dependencies (Express only)
npm install

# 2. Start the server
npm start

# 3. Open your browser
#    http://localhost:3000
```

The server seeds **3 demo auctions** on startup so the UI is immediately usable.

For auto-reload during development:
```bash
npm run dev    # uses node --watch (Node 18+)
```

---

## 🧪 Running Tests

```bash
npm test
```

Uses Node's built-in test runner (`node --test`). No extra dependencies needed.

**Test coverage:**
| Test | What it verifies |
|---|---|
| 100 simultaneous bids | Exactly one winner; final price equals the highest bid |
| Anti-sniping | Bid in last 30 s extends `endsAt` by 30 s |
| Expired auction | Bid after `endsAt` is rejected with 409 |
| Equal bid | Bid equal to current price rejected with 400 |
| Lower bid | Bid below current price rejected with 400 |
| Idempotent close | Calling close twice never changes the winner |
| Validation | Missing title / price / duration return 400 |

---

## 📡 API Reference

All endpoints consume and produce `application/json`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auctions` | Create an auction |
| `GET`  | `/auctions` | List all auctions |
| `GET`  | `/auctions/:id` | Get a single auction |
| `POST` | `/auctions/:id/bids` | Place a bid |
| `GET`  | `/auctions/:id/stream` | SSE stream of live updates |

### POST /auctions

**Body:**
```json
{ "title": "Vintage Watch", "startingPrice": 500, "durationSeconds": 300 }
```

**Response 201:**
```json
{
  "id": "uuid",
  "title": "Vintage Watch",
  "startingPrice": 500,
  "currentPrice": 500,
  "highestBidder": null,
  "endsAt": 1716000000000,
  "status": "open",
  "bids": []
}
```

### POST /auctions/:id/bids

**Body:**
```json
{ "bidder": "alice", "amount": 650 }
```

**Response 201 (accepted):**
```json
{ ...auctionState, "extended": false }
```
`extended: true` when anti-sniping triggered.

**Error responses:**
| Status | Reason |
|--------|--------|
| 400 | Bid ≤ current price, missing fields |
| 404 | Auction not found |
| 409 | Auction is closed or time has expired |

### GET /auctions/:id/stream (SSE)

Events emitted on the stream:

| Event name | When |
|------------|------|
| `update` | On connect (initial snapshot) and after every accepted bid |
| `closed` | When the auction timer fires and the auction is sealed |

Heartbeat comment (`:heartbeat`) is sent every 15 s to keep proxies alive.

---

## 🏗️ Design Note – Scaling to 50,000 Auctions & 200,000 Watchers

### 1. One Writer Per Auction (Serialised Bids, Sharding by Auction ID)

Each auction owns a **promise-chained async mutex** (`_lock`). Bids for the same auction execute strictly one at a time, preventing any concurrent reads producing two simultaneous "winners". Across different auctions there is zero contention — operations are fully parallel. At scale this model maps directly to **actor-per-auction** or **partition-per-auction** patterns: shard by `hash(auctionId) % N` so a single-writer process owns each auction exclusively.

### 2. Horizontal Scaling — Auctions Are Independent, So Shard Across Servers

Because auctions share no mutable state with each other, the server fleet can be **horizontally partitioned** by auction ID. A thin routing layer (e.g., consistent-hash load balancer or a Redis-backed lookup of `auctionId → shard`) directs every request and SSE connection for the same auction to the same node. No distributed locking is required — correctness is local to the shard.

### 3. Watcher Fan-Out via SSE/WebSocket + Redis Pub/Sub (Never DB Polling)

The current in-process `Set` of SSE `Response` objects scales to tens of thousands of watchers on one machine but breaks when the fleet grows beyond one node. The solution is a **publish-subscribe bus** (Redis Pub/Sub, Kafka, or NATS): the shard that owns the auction publishes each state change to a channel named `auction:<id>`; every node holding watchers for that auction subscribes and fans out to its local `Set`. Watchers are never required to poll the database — the event is pushed from the write path atomically.

### 4. Last-10-Seconds Bid Spike — Rate Limiting and Early Low-Bid Rejection

As an auction nears its end, bid volume spikes dramatically. Two mitigations prevent this from overwhelming the shard:  
(a) **Rate limiting per bidder per auction** (e.g., token bucket, 1 req/s) drops frivolous retries at the edge, before they reach the lock.  
(b) **Speculative early rejection**: before acquiring the lock, compare the incoming `amount` against `currentPrice` (read without a lock — an optimistic read). Bids that are obviously too low are rejected immediately with 400, never queuing behind the mutex. Only bids that *could* win enter the serialised critical section.

### 5. Server-Clock Authority, Extension Applied Atomically With Bid Acceptance

The server **never trusts the client's timestamp**. `Date.now()` is called *inside* the critical section so the check and update share the same logical clock tick. The 30-second anti-snipe extension is computed and applied in the same atomic step that updates `currentPrice` and `highestBidder`, making it impossible for a concurrent bid to observe a partially-applied state.

### 6. Closing via a Timer That Re-Checks endsAt — Exactly One Winner

Each auction's close is driven by a `setTimeout` scheduled for `endsAt`. When the timer fires, it re-reads `endsAt` before acting; if anti-sniping extended the deadline after the timer was scheduled, it simply reschedules rather than closing. The `status === 'closed'` guard makes the close **idempotent** — calling it twice (e.g., from a duplicate timer or a race between two nodes in a distributed setup) is a safe no-op. In a multi-node deployment this translates to a **distributed lock + conditional write** (`SET auction:<id>:status closed NX` in Redis) so only one node ever seals the auction.

---

## 📂 Project Structure

```
live-auction-platform/
├── server.js              # Express server, in-memory store, all business logic
├── package.json
├── README.md
├── public/
│   └── index.html         # Full SPA: grid + detail view, SSE client, premium UI
└── test/
    └── bidding.test.js    # Node --test suite (7 test cases)
```
