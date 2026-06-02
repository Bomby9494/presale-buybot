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
  PRESALE_CONTRACT,
  TOKEN_SYMBOL = 'BDSBC',
  TOKEN_DECIMALS = '18',
  TOKEN_PRICE_PER_ETH,
  HARD_CAP_ETH,
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

if (!TELEGRAM_BOT_TOKEN || chatTargets.length === 0 || !PRESALE_CONTRACT) {
  console.error('[presale-bot] Missing TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID(S), or PRESALE_CONTRACT in .env');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const CONTRIBUTED_TOPIC = '0x76b049c6a58fbcb3b1b5c347116d3f7bb8ee99c66d0a424ef58b5539acde2e25';
const POLL_MS = parseInt(POLL_INTERVAL_MS, 10);
const decimals = parseInt(TOKEN_DECIMALS, 10);
const tokenPricePerEth = TOKEN_PRICE_PER_ETH ? parseFloat(TOKEN_PRICE_PER_ETH) : null;
const hardCapEth = HARD_CAP_ETH ? parseFloat(HARD_CAP_ETH) : null;

let provider = null;
let lastBlock = 0;
const processedTxs = new Set();
let ethPriceUsd = 0;
let totalRaisedWei = 0n;

// ── RPC ──

async function createProvider() {
  for (const url of [RPC_URL, RPC_FALLBACK]) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      console.log(`[presale-bot] Connected to ${url}`);
      return p;
    } catch (e) {
      console.warn(`[presale-bot] RPC failed: ${url} — ${e.message}`);
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
    console.log(`[presale-bot] ETH price: $${ethPriceUsd}`);
  } catch (e) {
    console.warn(`[presale-bot] ETH price fetch failed: ${e.message}`);
  }
}

// ── Contract balance (total raised) ──

async function fetchTotalRaised() {
  try {
    const balance = await provider.getBalance(PRESALE_CONTRACT);
    totalRaisedWei = balance;
  } catch (e) {
    console.warn(`[presale-bot] Balance fetch failed: ${e.message}`);
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
      console.warn(`[presale-bot] sendPhoto failed for ${target}, falling back to text:`, data.description);
    } catch (e) {
      console.warn(`[presale-bot] sendPhoto error for ${target}, falling back to text:`, e.message);
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
    if (!data.ok) console.error(`[presale-bot] Telegram error for ${target}:`, data.description);
  } catch (e) {
    console.error(`[presale-bot] Telegram send failed for ${target}:`, e.message);
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

function formatTokens(amount) {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${Math.round(amount).toLocaleString('en-US')}`;
  return amount.toFixed(2);
}

function progressBar(current, total, len = 16) {
  if (!total) return '';
  const pct = Math.min(current / total, 1);
  const filled = Math.round(pct * len);
  const empty = len - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${(pct * 100).toFixed(1)}%`;
}

function buyerEmoji() {
  return '🚀 New Presale Buy! 🚀';
}

// ── Build alert message ──

function buildMessage(contributor, ethAmount, txHash) {
  const usdSpent = ethAmount * ethPriceUsd;
  const tokensReceived = tokenPricePerEth ? ethAmount * tokenPricePerEth : null;
  const totalRaisedEth = parseFloat(ethers.formatEther(totalRaisedWei));
  const totalRaisedUsd = totalRaisedEth * ethPriceUsd;

  const lines = [];
  lines.push(`<b>${buyerEmoji()}</b>`);
  lines.push('');
  lines.push(`👤 <b>Buyer:</b>   <a href="https://etherscan.io/address/${contributor}">${shortAddr(contributor)}</a>`);
  lines.push(`💵 <b>Spent:</b>   ${formatUsd(usdSpent)} (${ethAmount.toFixed(4)} ETH)`);
  lines.push(`🌐 <b>Network:</b> Ethereum`);
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push(`📈 <b>Total Raised:</b>   ${formatUsd(totalRaisedUsd)}`);

  if (hardCapEth) {
    const hardCapUsd = hardCapEth * ethPriceUsd;
    lines.push('');
    lines.push(`<code>${progressBar(totalRaisedUsd, hardCapUsd)}</code>`);
  }

  const buttons = [
    [
      { text: '🔍 View TX', url: `https://etherscan.io/tx/${txHash}` },
      { text: '🚀 PinkSale', url: `https://www.pinksale.finance/launchpad/ethereum/${PRESALE_CONTRACT}` },
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

// ── Event processing ──

async function processLogs(fromBlock, toBlock) {
  const logs = await provider.getLogs({
    address: PRESALE_CONTRACT,
    topics: [CONTRIBUTED_TOPIC],
    fromBlock,
    toBlock,
  });

  for (const log of logs) {
    const txKey = `${log.transactionHash}-${log.logIndex}`;
    if (processedTxs.has(txKey)) continue;
    processedTxs.add(txKey);

    const contributor = ethers.getAddress('0x' + log.topics[1].slice(26));

    const dataHex = log.data.slice(2);
    const words = [];
    for (let i = 0; i < dataHex.length; i += 64) {
      words.push(BigInt('0x' + dataHex.slice(i, i + 64)));
    }
    // words[0] = currencyType, words[1] = amount (wei), words[2] = cumulative, words[3] = timestamp
    const amountWei = words[1] || 0n;
    const ethAmount = parseFloat(ethers.formatEther(amountWei));

    await fetchTotalRaised();

    const { text, buttons } = buildMessage(contributor, ethAmount, log.transactionHash);
    await sendTelegram(text, buttons);
    console.log(`[presale-bot] Alert sent: ${shortAddr(contributor)} contributed ${ethAmount} ETH`);
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
    if (currentBlock > lastBlock) {
      const from = lastBlock + 1;
      await processLogs(from, currentBlock);
      lastBlock = currentBlock;
    }
  } catch (e) {
    console.error(`[presale-bot] Poll error: ${e.message}`);
    try {
      provider = await createProvider();
    } catch (reconnectErr) {
      console.error(`[presale-bot] Reconnect failed: ${reconnectErr.message}`);
    }
  }
}

async function main() {
  console.log('[presale-bot] Starting...');
  console.log(`[presale-bot] Contract: ${PRESALE_CONTRACT}`);
  console.log(`[presale-bot] Token: ${TOKEN_SYMBOL}`);
  console.log(`[presale-bot] Poll interval: ${POLL_MS}ms`);
  console.log(`[presale-bot] Posting to ${chatTargets.length} chat target(s): ${chatTargets.join(', ')}`);

  provider = await createProvider();
  await fetchEthPrice();
  await fetchTotalRaised();

  const totalEth = parseFloat(ethers.formatEther(totalRaisedWei));
  console.log(`[presale-bot] Current total raised: ${totalEth.toFixed(4)} ETH (~${formatUsd(totalEth * ethPriceUsd)})`);

  lastBlock = await provider.getBlockNumber();
  console.log(`[presale-bot] Starting from block ${lastBlock}`);

  setInterval(fetchEthPrice, 60_000);
  setInterval(poll, POLL_MS);
}

process.on('uncaughtException', (e) => console.error('[presale-bot] Uncaught:', e.message));
process.on('unhandledRejection', (r) => console.error('[presale-bot] Unhandled:', r));
process.on('SIGINT', () => { console.log('[presale-bot] Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[presale-bot] Shutting down'); process.exit(0); });

main().catch(e => { console.error('[presale-bot] Fatal:', e.message); process.exit(1); });
