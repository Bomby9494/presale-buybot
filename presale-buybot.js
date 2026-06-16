#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const IMAGE_PATH = path.join(__dirname, 'buybotBDG.jpg');

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_CHAT_IDS,
  POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90', // Uniswap v4 PoolManager (mainnet)
  POOL_ID,
  TOKEN_ADDRESS = '0x10b2b342111cf1f45f5C0Ab2f3C1055549FE0A22',
  TOKEN_SYMBOL = 'BDSBC',
  TOKEN_DECIMALS = '18',
  ETH_DECIMALS = '18',
  TOKEN_CURRENCY_INDEX = '1',     // which currency in the pool is the token (0 or 1); ETH is the other
  TOKEN_TOTAL_SUPPLY = '1000000000',
  MIN_BUY_USD = '0',              // post every buy by default
  RPC_URL = 'https://ethereum-rpc.publicnode.com',
  RPC_FALLBACK = 'https://rpc.ankr.com/eth',
  POLL_INTERVAL_MS = '12000',
} = process.env;

// Accept either a single TELEGRAM_CHAT_ID or a comma-separated TELEGRAM_CHAT_IDS.
// Each target may be "chatId" or "chatId_threadId" to post into a forum topic.
const chatTargets = (TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TELEGRAM_BOT_TOKEN || chatTargets.length === 0 || !POOL_ID) {
  console.error('[buybot] Missing TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID(S), or POOL_ID in .env');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Uniswap v4 PoolManager: Swap(bytes32 indexed id, address indexed sender,
//   int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity,
//   int24 tick, uint24 fee). All swaps for every pool come from the one
//   singleton, so we filter by topic0 (Swap) + topic1 (our poolId).
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const poolIdTopic = POOL_ID.toLowerCase();

const POLL_MS = parseInt(POLL_INTERVAL_MS, 10);
const tokenDecimals = parseInt(TOKEN_DECIMALS, 10);
const ethDecimals = parseInt(ETH_DECIMALS, 10);
const tokenIndex = parseInt(TOKEN_CURRENCY_INDEX, 10); // 0 or 1
const totalSupply = parseFloat(TOKEN_TOTAL_SUPPLY);
const minBuyUsd = parseFloat(MIN_BUY_USD) || 0;

let provider = null;
let lastBlock = 0;
const processedTxs = new Set();
let ethPriceUsd = 0;

// ── RPC ──

// Ethereum mainnet, pinned. Passing a static network stops ethers v6 from
// running its background "detect network" routine, which on a flaky endpoint
// loops "failed to detect network ... retry in 1s" forever and floods the logs
// (~1GB/day) without ever recovering. With a static network the provider never
// auto-detects, so a bad endpoint fails fast and we rotate to the next one.
const ETH_MAINNET = ethers.Network.from(1);

// Primary + fallback from env, then a few reliable public endpoints. Deduped.
const RPC_ENDPOINTS = [...new Set([
  RPC_URL,
  RPC_FALLBACK,
  'https://eth.llamarpc.com',
  'https://eth.drpc.org',
  'https://cloudflare-eth.com',
].filter(Boolean))];

async function createProvider() {
  for (const url of RPC_ENDPOINTS) {
    let p;
    try {
      p = new ethers.JsonRpcProvider(url, ETH_MAINNET, { staticNetwork: ETH_MAINNET });
      await p.getBlockNumber();
      console.log(`[buybot] Connected to ${url}`);
      return p;
    } catch (e) {
      console.warn(`[buybot] RPC failed: ${url} — ${e.message}`);
      try { p?.destroy?.(); } catch {}
    }
  }
  throw new Error('All RPC endpoints failed');
}

// ── ETH price ──

async function fetchEthPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    ethPriceUsd = data.ethereum?.usd || ethPriceUsd;
    console.log(`[buybot] ETH price: $${ethPriceUsd}`);
  } catch (e) {
    console.warn(`[buybot] ETH price fetch failed: ${e.message}`);
  }
}

// ── Telegram ──

// Send one alert to a single target ("chatId" or "chatId_threadId").
async function sendToTarget(target, text, buttons) {
  const chatId = target.includes('_') ? target.split('_')[0] : target;
  const threadId = target.includes('_') ? target.split('_')[1] : null;

  const hasImage = fs.existsSync(IMAGE_PATH);

  if (hasImage) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', text);
      form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([fs.readFileSync(IMAGE_PATH)], { type: 'image/jpeg' }), 'buybotBDG.jpg');
      if (threadId) form.append('message_thread_id', threadId);
      if (buttons) form.append('reply_markup', JSON.stringify({ inline_keyboard: buttons }));

      const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
      const data = await res.json();
      if (data.ok) return;
      console.warn(`[buybot] sendPhoto failed for ${target}, falling back to text:`, data.description);
    } catch (e) {
      console.warn(`[buybot] sendPhoto error for ${target}, falling back to text:`, e.message);
    }
  }

  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (threadId) body.message_thread_id = parseInt(threadId, 10);
  if (buttons) body.reply_markup = JSON.stringify({ inline_keyboard: buttons });

  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[buybot] Telegram error for ${target}:`, data.description);
  } catch (e) {
    console.error(`[buybot] Telegram send failed for ${target}:`, e.message);
  }
}

// Fan out the same alert to every configured target.
async function sendTelegram(text, buttons) {
  for (const target of chatTargets) {
    await sendToTarget(target, text, buttons);
  }
}

// ── Format helpers ──

function shortAddr(addr) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsd(value) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${Math.round(value).toLocaleString('en-US')}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

// Sub-cent token prices need significant figures, not fixed decimals.
function formatPrice(value) {
  if (!value || value <= 0) return '$0';
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(4)}`;
}

function formatTokens(amount) {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${Math.round(amount).toLocaleString('en-US')}`;
  return amount.toFixed(2);
}

// int128 values are ABI sign-extended across the full 256-bit word, so read
// each data word as a 256-bit two's-complement integer.
function toSigned(word) {
  let v = BigInt('0x' + word);
  if (v >= (1n << 255n)) v -= (1n << 256n);
  return v;
}

// ── Build alert message ──

function buildMessage({ buyer, ethSpent, tokensBought, priceUsd, txHash }) {
  const usdSpent = ethSpent * ethPriceUsd;
  const marketCapUsd = priceUsd * totalSupply;

  const lines = [];
  lines.push(`<b>🚀 New ${TOKEN_SYMBOL} Buy! 🚀</b>`);
  lines.push('');
  lines.push(`👤 <b>Buyer:</b>   <a href="https://etherscan.io/address/${buyer}">${shortAddr(buyer)}</a>`);
  lines.push(`💵 <b>Spent:</b>   ${formatUsd(usdSpent)} (${ethSpent.toFixed(4)} ETH)`);
  lines.push(`🪙 <b>Got:</b>     ${formatTokens(tokensBought)} ${TOKEN_SYMBOL}`);
  lines.push('━━━━━━━━━━━━━━━━━━');
  if (priceUsd > 0) lines.push(`💲 <b>Price:</b>   ${formatPrice(priceUsd)}`);
  if (marketCapUsd > 0) lines.push(`📊 <b>MCap:</b>    ${formatUsd(marketCapUsd)}`);
  lines.push(`🌐 <b>Network:</b> Ethereum`);

  const buttons = [
    [
      { text: '🔍 View TX', url: `https://etherscan.io/tx/${txHash}` },
    ],
    // 🛒 Buy & Track BDSBC
    [
      { text: '🦎 GeckoTerminal', url: 'https://www.geckoterminal.com/eth/pools/0x40e344af275ae7a6fcf208d257146ba47942f31d3eac9927a83dfb5975487cc6' },
      { text: '🐦 Birdeye', url: 'https://birdeye.so/ethereum/token/0x10b2b342111cf1f45f5C0Ab2f3C1055549FE0A22' },
    ],
    [
      { text: '📊 DEXTools', url: 'https://www.dextools.io/app/ether/pair-explorer/0x40e344af275ae7a6fcf208d257146ba47942f31d3eac9927a83dfb5975487cc6' },
      { text: '📈 DEXScreener', url: 'https://dexscreener.com/ethereum/0x40e344af275ae7a6fcf208d257146ba47942f31d3eac9927a83dfb5975487cc6' },
    ],
    [
      { text: '⚡️ GMGN', url: 'https://gmgn.ai/eth/token/0x10b2b342111cf1f45f5c0ab2f3c1055549fe0a22' },
      { text: '🦄 Buy on Uniswap', url: 'https://app.uniswap.org/swap?chain=ethereum&outputCurrency=0x10b2b342111cf1f45f5C0Ab2f3C1055549FE0A22' },
    ],
    [
      { text: '🤖 Android APP', url: 'https://play.google.com/store/apps/details?id=com.kirogames.bugsdestroyerinsectsmash' },
      { text: '🍎 iOS APP', url: 'https://apps.apple.com/in/app/bugs-destroyer-insect-smash/id1518031439' },
    ],
    [
      { text: '🌐 Website', url: 'https://bdsbc.net/' },
    ],
  ];

  return { text: lines.join('\n'), buttons };
}

// ── Swap decoding ──

// Decode a v4 Swap log into the fields we care about. Returns null if it is not
// a buy of our token (i.e. the swapper did not receive the token).
function decodeSwap(log) {
  const d = log.data.slice(2);
  const words = [];
  for (let i = 0; i < d.length; i += 64) words.push(d.slice(i, i + 64));
  const amount0 = toSigned(words[0]);
  const amount1 = toSigned(words[1]);
  const sqrtPriceX96 = BigInt('0x' + words[2]);

  const tokenDelta = tokenIndex === 0 ? amount0 : amount1; // >0 means swapper received the token (BUY)
  const ethDelta = tokenIndex === 0 ? amount1 : amount0;
  if (tokenDelta <= 0n) return null; // sell or zero — skip

  const tokensBought = parseFloat(ethers.formatUnits(tokenDelta, tokenDecimals));
  const ethSpent = parseFloat(ethers.formatUnits(ethDelta < 0n ? -ethDelta : ethDelta, ethDecimals));

  // Spot price from sqrtPriceX96 (post-swap). price1per0 = (sqrt/2^96)^2 is the
  // raw token1-per-token0 ratio; adjust for the two currencies' decimals.
  const sq = Number(sqrtPriceX96) / 2 ** 96;
  const price1per0 = sq * sq; // token1 raw per token0 raw
  let ethPerToken;
  if (tokenIndex === 1) {
    // token = c1, eth = c0. tokens(c1) per eth(c0) = price1per0 * 10^(dec0-dec1)
    const tokensPerEth = price1per0 * 10 ** (ethDecimals - tokenDecimals);
    ethPerToken = tokensPerEth > 0 ? 1 / tokensPerEth : 0;
  } else {
    // token = c0, eth = c1. eth(c1) per token(c0) = price1per0 * 10^(dec0-dec1)
    ethPerToken = price1per0 * 10 ** (tokenDecimals - ethDecimals);
  }
  const priceUsd = ethPerToken * ethPriceUsd;

  return { tokensBought, ethSpent, priceUsd };
}

// ── Event processing ──

async function processLogs(fromBlock, toBlock) {
  const logs = await provider.getLogs({
    address: POOL_MANAGER,
    topics: [SWAP_TOPIC, poolIdTopic],
    fromBlock,
    toBlock,
  });

  for (const log of logs) {
    const txKey = `${log.transactionHash}-${log.logIndex}`;
    if (processedTxs.has(txKey)) continue;
    processedTxs.add(txKey);

    const swap = decodeSwap(log);
    if (!swap) continue; // not a buy

    const usdSpent = swap.ethSpent * ethPriceUsd;
    if (minBuyUsd > 0 && usdSpent < minBuyUsd) {
      console.log(`[buybot] Skipped sub-threshold buy: ${formatUsd(usdSpent)} < ${formatUsd(minBuyUsd)}`);
      continue;
    }

    // The event's `sender` is the router contract; the real buyer is the tx
    // origin. Fall back to the router address if the tx can't be fetched.
    let buyer = ethers.getAddress('0x' + log.topics[2].slice(26));
    try {
      const tx = await provider.getTransaction(log.transactionHash);
      if (tx?.from) buyer = tx.from;
    } catch (e) {
      console.warn(`[buybot] getTransaction failed for ${log.transactionHash}: ${e.message}`);
    }

    const { text, buttons } = buildMessage({
      buyer,
      ethSpent: swap.ethSpent,
      tokensBought: swap.tokensBought,
      priceUsd: swap.priceUsd,
      txHash: log.transactionHash,
    });
    await sendTelegram(text, buttons);
    console.log(`[buybot] Alert sent: ${shortAddr(buyer)} bought ${formatTokens(swap.tokensBought)} ${TOKEN_SYMBOL} for ${swap.ethSpent} ETH`);
  }

  if (processedTxs.size > 5000) {
    const arr = [...processedTxs];
    arr.splice(0, 2500);
    processedTxs.clear();
    arr.forEach(k => processedTxs.add(k));
  }
}

// ── Main loop ──

async function poll() {
  try {
    const currentBlock = await provider.getBlockNumber();
    // Lag one block: load-balanced RPCs sometimes report a head their getLogs
    // node hasn't reached yet, which throws -32602 "block range extends beyond
    // current head block". One confirmation avoids that race (~12s on ETH).
    const safeHead = currentBlock - 1;
    if (safeHead > lastBlock) {
      const from = lastBlock + 1;
      await processLogs(from, safeHead);
      lastBlock = safeHead;
    }
  } catch (e) {
    console.error(`[buybot] Poll error: ${e.message}`);
    // Tear down the wedged provider before reconnecting, otherwise its
    // background reconnection keeps looping and leaks a zombie provider per
    // failed poll (the original log-flood cause).
    try { provider?.destroy?.(); } catch {}
    try {
      provider = await createProvider();
    } catch (reconnectErr) {
      console.error(`[buybot] Reconnect failed: ${reconnectErr.message}`);
    }
  }
}

async function main() {
  console.log('[buybot] Starting...');
  console.log(`[buybot] PoolManager: ${POOL_MANAGER}`);
  console.log(`[buybot] PoolId: ${POOL_ID}`);
  console.log(`[buybot] Token: ${TOKEN_SYMBOL} (currency${tokenIndex})`);
  console.log(`[buybot] Min buy: ${minBuyUsd > 0 ? formatUsd(minBuyUsd) : 'none (all buys)'}`);
  console.log(`[buybot] Poll interval: ${POLL_MS}ms`);
  console.log(`[buybot] Posting to ${chatTargets.length} chat target(s): ${chatTargets.join(', ')}`);

  provider = await createProvider();
  await fetchEthPrice();

  lastBlock = await provider.getBlockNumber();
  console.log(`[buybot] Starting from block ${lastBlock}`);

  setInterval(fetchEthPrice, 60_000);
  setInterval(poll, POLL_MS);
}

process.on('uncaughtException', (e) => console.error('[buybot] Uncaught:', e.message));
process.on('unhandledRejection', (r) => console.error('[buybot] Unhandled:', r));
process.on('SIGINT', () => { console.log('[buybot] Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[buybot] Shutting down'); process.exit(0); });

main().catch(e => { console.error('[buybot] Fatal:', e.message); process.exit(1); });
