#!/usr/bin/env node
// One-off: replay the most recent Contribute event to ALL configured groups,
// using the same fan-out logic as the live bot (TELEGRAM_CHAT_IDS).
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const PRESALE = process.env.PRESALE_CONTRACT;
const TOPIC = '0x76b049c6a58fbcb3b1b5c347116d3f7bb8ee99c66d0a424ef58b5539acde2e25';
const tokenPricePerEth = parseFloat(process.env.TOKEN_PRICE_PER_ETH);
const hardCapEth = parseFloat(process.env.HARD_CAP_ETH);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const IMAGE_PATH = path.join(__dirname, 'buybotBDG.jpg');

const chatTargets = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function shortAddr(a) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
function formatUsd(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}
function progressBar(c, t, l = 16) {
  if (!t) return '';
  const p = Math.min(c / t, 1);
  const f = Math.round(p * l);
  return '█'.repeat(f) + '░'.repeat(l - f) + ` ${(p * 100).toFixed(1)}%`;
}

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
  console.log(`Targets: ${chatTargets.join(', ')}`);
  const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: PRESALE, topics: [TOPIC],
    fromBlock: currentBlock - 10000, toBlock: 'latest',
  });
  if (!logs.length) { console.log('No contributions found in recent blocks'); return; }

  const log = logs[logs.length - 1];
  const contributor = ethers.getAddress('0x' + log.topics[1].slice(26));
  const dataHex = log.data.slice(2);
  const words = [];
  for (let i = 0; i < dataHex.length; i += 64) words.push(BigInt('0x' + dataHex.slice(i, i + 64)));
  const ethAmount = parseFloat(ethers.formatEther(words[1] || 0n));

  const [priceRes, balance] = await Promise.all([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd').then(r => r.json()),
    provider.getBalance(PRESALE),
  ]);
  const ethPrice = priceRes.ethereum.usd;
  const totalRaisedUsd = parseFloat(ethers.formatEther(balance)) * ethPrice;
  const usdSpent = ethAmount * ethPrice;
  const hardCapUsd = hardCapEth * ethPrice;

  const lines = [
    `<b>🚀 New Presale Buy! 🚀</b>`, '',
    `👤 <b>Buyer:</b>   <a href="https://etherscan.io/address/${contributor}">${shortAddr(contributor)}</a>`,
    `💵 <b>Spent:</b>   ${formatUsd(usdSpent)} (${ethAmount.toFixed(4)} ETH)`,
    `🌐 <b>Network:</b> Ethereum`,
    '━━━━━━━━━━━━━━━━━━',
    `📈 <b>Total Raised:</b>   ${formatUsd(totalRaisedUsd)}`, '',
    `<code>${progressBar(totalRaisedUsd, hardCapUsd)}</code>`,
  ];
  const text = lines.join('\n');
  const buttons = [
    [
      { text: '🔍 View TX', url: `https://etherscan.io/tx/${log.transactionHash}` },
      { text: '🚀 PinkSale', url: `https://www.pinksale.finance/launchpad/ethereum/${PRESALE}` },
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

  for (const target of chatTargets) await sendToTarget(target, text, buttons);
})();
