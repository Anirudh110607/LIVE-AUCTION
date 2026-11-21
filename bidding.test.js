/**
 * Live Auction Platform – test/bidding.test.js
 *
 * Run with:  npm test   (uses Node's built-in test runner, Node >= 20)
 *
 * Tests start a fresh server on a random port so they never conflict
 * with a running dev server.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const express = require('express');

// ── We re-use the app logic but start our own server on a free port ──────────
// Suppress seed data by temporarily overriding createAuction seeding.
// We import the factory helpers directly.
const { createAuction, withAuctionLock, closeAuction, auctions } = require('../server');

// Pick the already-bound app export; we'll attach our own listener.
const { app } = require('../server');

let server;
let BASE_URL;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(path, body) {
  return fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

function get(path) {
  return fetch(`${BASE_URL}${path}`);
}

/** Create a fresh auction via the API and return its JSON body. */
async function createTestAuction(durationSeconds = 300) {
  const res = await post('/auctions', {
    title:          `Test Auction ${Date.now()}`,
    startingPrice:  100,
    durationSeconds,
  });
  assert.equal(res.status, 201);
  return res.json();
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE_URL = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  // Clear all timers to avoid open handles
  for (const a of auctions.values()) {
    if (a._timer) clearTimeout(a._timer);
  }
  await new Promise(resolve => server.close(resolve));
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('100 simultaneous bids: exactly one winner, final price = highest accepted bid', async () => {
  const auction = await createTestAuction(600);
  const id = auction.id;

  // Fire 100 bids with unique amounts 101–200 all at once
  const bids = Array.from({ length: 100 }, (_, i) => ({
    bidder: `bidder${i}`,
    amount: 101 + i, // 101, 102, … 200
  }));

  const responses = await Promise.all(
    bids.map(b => post(`/auctions/${id}/bids`, b))
  );

  // Fetch final state
  const finalRes  = await get(`/auctions/${id}`);
  const finalState = await finalRes.json();

  // Exactly one bid must have set the highest price of $200
  assert.equal(finalState.currentPrice, 200,
    `Expected final price 200, got ${finalState.currentPrice}`);

  // The winner must be bidder99 (amount 200)
  assert.equal(finalState.highestBidder, 'bidder99',
    `Expected winner bidder99, got ${finalState.highestBidder}`);

  // Count accepted bids (HTTP 201)
  const accepted = responses.filter(r => r.status === 201);
  // All 100 bids should be accepted because each is strictly greater than the
  // previous, and the lock serialises them so they stack correctly.
  assert.equal(accepted.length, 100,
    `Expected all 100 bids accepted (they form a strict ascending sequence), got ${accepted.length}`);
});

test('bid in the last 30 seconds extends endsAt by 30 seconds', async () => {
  // Create auction that expires in 20 seconds (within snipe window)
  const auction = await createTestAuction(20);
  const id      = auction.id;
  const originalEndsAt = auction.endsAt;

  const res  = await post(`/auctions/${id}/bids`, { bidder: 'sniper', amount: 101 });
  const body = await res.json();

  assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.extended, true, 'Expected extended flag to be true');
  assert.ok(
    body.endsAt >= originalEndsAt + 29_000,
    `Expected endsAt to increase by ~30s. Before: ${originalEndsAt}, After: ${body.endsAt}`
  );
});

test('bid after the end time is rejected with 409', async () => {
  // Create an auction that expires immediately (1 ms)
  const auction = await createTestAuction(0.001);
  const id = auction.id;

  // Wait for it to expire
  await new Promise(r => setTimeout(r, 50));

  const res  = await post(`/auctions/${id}/bids`, { bidder: 'latecomer', amount: 200 });
  const body = await res.json();

  assert.equal(res.status, 409, `Expected 409 got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error, 'Expected error message');
});

test('bid equal to current price is rejected with 400', async () => {
  const auction = await createTestAuction(600);
  const id = auction.id;

  // Starting price is 100; bidding exactly 100 must fail
  const res  = await post(`/auctions/${id}/bids`, { bidder: 'alice', amount: 100 });
  const body = await res.json();

  assert.equal(res.status, 400, `Expected 400 got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error, 'Expected error message');
});

test('bid lower than current price is rejected with 400', async () => {
  const auction = await createTestAuction(600);
  const id = auction.id;

  // First, place a valid bid to raise the price
  const first = await post(`/auctions/${id}/bids`, { bidder: 'alice', amount: 150 });
  assert.equal(first.status, 201);

  // Now try to bid lower
  const res  = await post(`/auctions/${id}/bids`, { bidder: 'bob', amount: 120 });
  const body = await res.json();

  assert.equal(res.status, 400, `Expected 400 got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error, 'Expected error message');
});

test('closing twice never changes the winner', async () => {
  // Create a long auction so anti-sniping doesn't interfere
  const auctionData = await createTestAuction(600);
  const id = auctionData.id;

  // Place a bid at the normal price
  const bidRes = await post(`/auctions/${id}/bids`, { bidder: 'firstBidder', amount: 150 });
  assert.equal(bidRes.status, 201);

  // Directly close the auction via the in-memory reference
  // (bypasses the timer, so anti-sniping cannot extend it)
  const auctionObj = auctions.get(id);
  assert.ok(auctionObj, 'Auction object must exist in memory');

  // Force endsAt to the past so closeAuction() doesn't re-schedule
  auctionObj.endsAt = Date.now() - 1;
  closeAuction(auctionObj); // first close

  // Confirm it is now closed
  assert.equal(auctionObj.status, 'closed');
  const winner1 = auctionObj.highestBidder;

  // Call close again – must be a no-op (idempotency requirement 6)
  closeAuction(auctionObj);
  closeAuction(auctionObj);

  // Winner and price must be unchanged
  const snap = await (await get(`/auctions/${id}`)).json();
  assert.equal(snap.status, 'closed');
  assert.equal(snap.highestBidder, winner1, 'Winner changed after second close – idempotency broken!');
  assert.equal(snap.currentPrice, 150, 'Price changed after second close!');
});

test('bid on non-existent auction returns 404', async () => {
  const res = await post('/auctions/non-existent-id/bids', { bidder: 'x', amount: 999 });
  assert.equal(res.status, 404);
});

test('create auction validates required fields', async () => {
  const r1 = await post('/auctions', { startingPrice: 100, durationSeconds: 60 });
  assert.equal(r1.status, 400);

  const r2 = await post('/auctions', { title: 'T', durationSeconds: 60 });
  assert.equal(r2.status, 400);

  const r3 = await post('/auctions', { title: 'T', startingPrice: 100 });
  assert.equal(r3.status, 400);
});
