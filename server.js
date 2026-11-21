/**
 * Live Auction Platform – server.js
 *
 * Key design decisions:
 *  - In-memory store; each auction object is the single source of truth.
 *  - Bids are processed inside a per-auction synchronous critical section
 *    (implemented as a micro-task queue) so concurrent requests never race.
 *  - Anti-sniping: bids arriving in the last 30 s extend endsAt by 30 s.
 *  - SSE fan-out: each auction keeps a Set of live response objects.
 *  - Closing is idempotent: the timer re-checks endsAt before acting.
 */

'use strict';

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ────────────────────────────────────────────────────────

/** @type {Map<string, Auction>} */
const auctions = new Map();

/**
 * @typedef {Object} Bid
 * @property {string} bidder
 * @property {number} amount
 * @property {number} placedAt  – epoch ms (server clock)
 */

/**
 * @typedef {Object} Auction
 * @property {string}   id
 * @property {string}   title
 * @property {number}   startingPrice
 * @property {number}   currentPrice
 * @property {string|null} highestBidder
 * @property {number}   endsAt      – epoch ms (server clock)
 * @property {'open'|'closed'} status
 * @property {Bid[]}    bids
 * @property {Set}      _clients    – active SSE response objects
 * @property {Promise}  _lock       – per-auction serialisation promise
 * @property {NodeJS.Timeout|null} _timer
 */

// ─── Concurrency: per-auction async mutex ────────────────────────────────────
// Every mutating operation chains onto _lock so bids execute one-at-a-time
// per auction (never across auctions), satisfying requirement 5.

function withAuctionLock(auction, fn) {
  // Atomically swap in a new promise that waits for the previous one,
  // then runs fn() exclusively.
  const next = auction._lock.then(() => fn());
  // Store the *settled* chain so errors in fn() don't break future bids.
  auction._lock = next.catch(() => {});
  return next;
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function sseWrite(res, eventName, data) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastAuction(auction, eventName = 'update') {
  const payload = publicView(auction);
  for (const client of auction._clients) {
    sseWrite(client, eventName, payload);
  }
}

// ─── Auction closing ─────────────────────────────────────────────────────────

/**
 * Schedule the closing check at endsAt.
 * Called on creation and after every anti-snipe extension.
 * Idempotent: existing timer is cleared before scheduling a new one.
 */
function scheduleClose(auction) {
  if (auction._timer) clearTimeout(auction._timer);

  const delay = auction.endsAt - Date.now();
  auction._timer = setTimeout(() => closeAuction(auction), Math.max(delay, 0));
}

/**
 * Close the auction exactly once. If endsAt was extended after the timer
 * was scheduled, we simply re-schedule instead of closing prematurely.
 * Idempotent: safe to call multiple times.
 */
function closeAuction(auction) {
  if (auction.status === 'closed') return; // already closed – idempotent

  // Re-check: anti-sniping may have pushed endsAt forward after this timer
  // was scheduled. If so, reschedule and do NOT close yet.
  if (Date.now() < auction.endsAt) {
    scheduleClose(auction);
    return;
  }

  auction.status = 'closed';
  if (auction._timer) {
    clearTimeout(auction._timer);
    auction._timer = null;
  }

  broadcastAuction(auction, 'closed');

  // Disconnect all SSE clients gracefully
  for (const client of auction._clients) {
    client.end();
  }
  auction._clients.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip internal fields before sending to clients. */
function publicView(auction) {
  return {
    id:             auction.id,
    title:          auction.title,
    startingPrice:  auction.startingPrice,
    currentPrice:   auction.currentPrice,
    highestBidder:  auction.highestBidder,
    endsAt:         auction.endsAt,
    status:         auction.status,
    bids:           auction.bids,
  };
}

function createAuction({ title, startingPrice, durationSeconds }) {
  const id     = crypto.randomUUID();
  const endsAt = Date.now() + durationSeconds * 1000;

  /** @type {Auction} */
  const auction = {
    id,
    title,
    startingPrice,
    currentPrice:   startingPrice,
    highestBidder:  null,
    endsAt,
    status:         'open',
    bids:           [],
    _clients:       new Set(),
    _lock:          Promise.resolve(), // resolved = no one holds the lock
    _timer:         null,
  };

  auctions.set(id, auction);
  scheduleClose(auction);
  return auction;
}

// ─── Seed data ───────────────────────────────────────────────────────────────

createAuction({ title: 'Vintage Rolex Submariner (1969)',  startingPrice: 4500, durationSeconds: 600 });
createAuction({ title: 'Signed Banksy Canvas – "Devolved Parliament"', startingPrice: 12000, durationSeconds: 900 });
createAuction({ title: 'First-Edition "The Great Gatsby" (1925)',      startingPrice: 800,  durationSeconds: 300 });

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /auctions – create a new auction
app.post('/auctions', (req, res) => {
  const { title, startingPrice, durationSeconds } = req.body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title is required' });
  }
  if (typeof startingPrice !== 'number' || startingPrice < 0) {
    return res.status(400).json({ error: 'startingPrice must be a non-negative number' });
  }
  if (typeof durationSeconds !== 'number' || durationSeconds <= 0) {
    return res.status(400).json({ error: 'durationSeconds must be a positive number' });
  }

  const auction = createAuction({ title: title.trim(), startingPrice, durationSeconds });
  res.status(201).json(publicView(auction));
});

// GET /auctions – list all auctions
app.get('/auctions', (_req, res) => {
  res.json([...auctions.values()].map(publicView));
});

// GET /auctions/:id – single auction
app.get('/auctions/:id', (req, res) => {
  const auction = auctions.get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  res.json(publicView(auction));
});

// POST /auctions/:id/bids – place a bid
app.post('/auctions/:id/bids', async (req, res) => {
  const auction = auctions.get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });

  const { bidder, amount } = req.body;

  if (!bidder || typeof bidder !== 'string' || bidder.trim() === '') {
    return res.status(400).json({ error: 'bidder name is required' });
  }
  if (typeof amount !== 'number' || isNaN(amount)) {
    return res.status(400).json({ error: 'amount must be a number' });
  }

  // All validation and mutation runs inside the per-auction lock
  // so concurrent bids are serialised and never race (requirement 5).
  try {
    const result = await withAuctionLock(auction, () => {
      // ── Inside critical section ──

      // Rule 2a: reject if closed or time expired (use SERVER clock only – rule 4)
      if (auction.status === 'closed' || Date.now() >= auction.endsAt) {
        return { ok: false, status: 409, error: 'Auction has ended' };
      }

      // Rule 2b: reject if bid not strictly greater than current price
      if (amount <= auction.currentPrice) {
        return {
          ok: false,
          status: 400,
          error: `Bid must be greater than current price of $${auction.currentPrice}`,
        };
      }

      // ── Accept the bid ──
      const now = Date.now();
      const bid = { bidder: bidder.trim(), amount, placedAt: now };

      auction.currentPrice  = amount;
      auction.highestBidder = bidder.trim();
      auction.bids.unshift(bid); // newest first

      // Rule 3: Anti-sniping – extend if bid lands in last 30 seconds
      let extended = false;
      if (auction.endsAt - now <= 30_000) {
        auction.endsAt += 30_000;
        extended = true;
        // Reschedule the close timer for the new endsAt
        scheduleClose(auction);
      }

      // Push live update to all SSE watchers
      broadcastAuction(auction, 'update');

      return { ok: true, auction, extended };
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(201).json({ ...publicView(result.auction), extended: result.extended });
  } catch (err) {
    console.error('Bid processing error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auctions/:id/stream – SSE stream
app.get('/auctions/:id/stream', (req, res) => {
  const auction = auctions.get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send current state immediately on connect
  sseWrite(res, 'update', publicView(auction));

  // If already closed, send final event and close connection
  if (auction.status === 'closed') {
    sseWrite(res, 'closed', publicView(auction));
    res.end();
    return;
  }

  // Register as a watcher
  auction._clients.add(res);

  // Keep-alive heartbeat every 15 s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 15_000);

  // Clean up when client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    auction._clients.delete(res);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
// Guard with require.main so the server only binds a port when run directly
// (node server.js), NOT when imported by tests.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🎯 Live Auction Platform running at http://localhost:${PORT}`);
    console.log(`   Seeded ${auctions.size} demo auctions.\n`);
  });
}

// Export for testing (allows test to import without side-effects)
module.exports = { app, auctions, createAuction, withAuctionLock, closeAuction };
