#!/usr/bin/env node
// One-off: replay the most recent BUY swap on the Uniswap v4 pool, using the
// same decode + format logic as the live bot. Prints a preview by default;
// pass --send to actually fan it out to all TELEGRAM_CHAT_IDS.
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const POOL_MANAGER = process.env.POOL_MANAGER || '0x000000000004444c5dc75cB358380D2e3dE08A90';
const POOL_ID = process.env.POOL_ID;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || '0x10b2b342111cf1f45f5C0Ab2f3C1055549FE0A22';
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'BDSBC';
const tokenDecimals = parseInt(process.env.TOKEN_DECIMALS || '18', 10);
const ethDecimals = parseInt(process.env.ETH_DECIMALS || '18', 10);
const tokenIndex = parseInt(process.env.TOKEN_CURRENCY_INDEX || '1', 10);
const totalSupply = parseFloat(process.env.TOKEN_TOTAL_SUPPLY || '1000000000');
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const IMAGE_PATH = path.join(__dirname, 'buybotBDG.jpg');
const SEND = process.argv.includes('--send');

const chatTargets = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function shortAddr(a) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
function formatUsd(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}
function formatPrice(v) { if (!v || v <= 0) return '$0'; return v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(4)}`; }
function formatTokens(a) {
  if (a >= 1e6) return `${(a / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `${Math.round(a).toLocaleString('en-US')}`;
  return a.toFixed(2);
}
function toSigned(word) { let v = BigInt('0x' + word); if (v >= (1n << 255n)) v -= (1n << 256n); return v; }

async function sendToTarget(target, text, buttons) {
  const chatId = target.includes('_') ? target.split('_')[0] : target;
  const threadId = target.includes('_') ? target.split('_')[1] : null;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', text);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([fs.readFileSync(IMAGE_PATH)], { type: 'image/jpeg' }), 'buybotBDG.jpg');
    if (threadId) form.append('message_thread_id', threadId);
    form.append('reply_markup', JSON.stringify({ inline_keyboard: buttons }));
    const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.ok) { console.log(`  ✅ ${target} — message_id ${data.result.message_id}`); return; }
    console.error(`  ❌ ${target} — ${data.description}`);
  } catch (e) {
    console.error(`  ❌ ${target} — ${e.message}`);
  }
}

(async () => {
  console.log(`Targets: ${chatTargets.join(', ')} | mode: ${SEND ? 'SEND' : 'preview only'}`);
  const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com', ethers.Network.from(1), { staticNetwork: ethers.Network.from(1) });
  const head = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: POOL_MANAGER, topics: [SWAP_TOPIC, POOL_ID.toLowerCase()],
    fromBlock: head - 50000, toBlock: head - 1,
  });
  if (!logs.length) { console.log('No swaps found in recent blocks'); return; }

  // newest buy (token delta > 0)
  let chosen = null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const d = logs[i].data.slice(2);
    const w = []; for (let j = 0; j < d.length; j += 64) w.push(d.slice(j, j + 64));
    const tokenDelta = tokenIndex === 0 ? toSigned(w[0]) : toSigned(w[1]);
    if (tokenDelta > 0n) { chosen = logs[i]; break; }
  }
  if (!chosen) { console.log('No BUY swaps found (only sells)'); return; }

  const d = chosen.data.slice(2);
  const w = []; for (let j = 0; j < d.length; j += 64) w.push(d.slice(j, j + 64));
  const amount0 = toSigned(w[0]), amount1 = toSigned(w[1]), sqrtPriceX96 = BigInt('0x' + w[2]);
  const tokenDelta = tokenIndex === 0 ? amount0 : amount1;
  const ethDelta = tokenIndex === 0 ? amount1 : amount0;
  const tokensBought = parseFloat(ethers.formatUnits(tokenDelta, tokenDecimals));
  const ethSpent = parseFloat(ethers.formatUnits(ethDelta < 0n ? -ethDelta : ethDelta, ethDecimals));

  const sq = Number(sqrtPriceX96) / 2 ** 96;
  const price1per0 = sq * sq;
  let ethPerToken;
  if (tokenIndex === 1) { const tpe = price1per0 * 10 ** (ethDecimals - tokenDecimals); ethPerToken = tpe > 0 ? 1 / tpe : 0; }
  else { ethPerToken = price1per0 * 10 ** (tokenDecimals - ethDecimals); }

  const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd').then(r => r.json());
  const ethPrice = priceRes.ethereum.usd;
  const priceUsd = ethPerToken * ethPrice;
  const usdSpent = ethSpent * ethPrice;
  const marketCapUsd = priceUsd * totalSupply;

  let buyer = ethers.getAddress('0x' + chosen.topics[2].slice(26));
  try { const tx = await provider.getTransaction(chosen.transactionHash); if (tx?.from) buyer = tx.from; } catch {}

  console.log(`\nDecoded: spent ${ethSpent} ETH (${formatUsd(usdSpent)}), got ${formatTokens(tokensBought)} ${TOKEN_SYMBOL}`);
  console.log(`Price: ${formatPrice(priceUsd)} | MCap: ${formatUsd(marketCapUsd)} | buyer ${buyer}`);

  const lines = [
    `<b>🚀 New ${TOKEN_SYMBOL} Buy! 🚀</b>`, '',
    `👤 <b>Buyer:</b>   <a href="https://etherscan.io/address/${buyer}">${shortAddr(buyer)}</a>`,
    `💵 <b>Spent:</b>   ${formatUsd(usdSpent)} (${ethSpent.toFixed(4)} ETH)`,
    `🪙 <b>Got:</b>     ${formatTokens(tokensBought)} ${TOKEN_SYMBOL}`,
    '━━━━━━━━━━━━━━━━━━',
    `💲 <b>Price:</b>   ${formatPrice(priceUsd)}`,
    `📊 <b>MCap:</b>    ${formatUsd(marketCapUsd)}`,
    `🌐 <b>Network:</b> Ethereum`,
  ];
  const text = lines.join('\n');
  const buttons = [
    [
      { text: '🔍 View TX', url: `https://etherscan.io/tx/${chosen.transactionHash}` },
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
    [{ text: '🌐 Website', url: 'https://bdsbc.net/' }],
  ];

  console.log('\n--- preview ---');
  console.log(text.replace(/<[^>]+>/g, ''));
  console.log('--- end preview ---\n');

  if (!SEND) { console.log('(preview only; pass --send to post to Telegram)'); return; }
  for (const target of chatTargets) await sendToTarget(target, text, buttons);
})();
