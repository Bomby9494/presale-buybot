#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const PRESALE = process.env.PRESALE_CONTRACT;
const TOPIC = '0x76b049c6a58fbcb3b1b5c347116d3f7bb8ee99c66d0a424ef58b5539acde2e25';
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL;
const tokenPricePerEth = parseFloat(process.env.TOKEN_PRICE_PER_ETH);
const hardCapEth = parseFloat(process.env.HARD_CAP_ETH);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IMAGE_PATH = path.join(__dirname, 'buybotBDG.jpg');

function shortAddr(a) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }

function formatUsd(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function formatTokens(a) {
  if (a >= 1e9) return `${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return Math.round(a).toLocaleString('en-US');
  return a.toFixed(2);
}

function progressBar(c, t, l = 16) {
  if (!t) return '';
  const p = Math.min(c / t, 1);
  const f = Math.round(p * l);
  return '█'.repeat(f) + '░'.repeat(l - f) + ` ${(p * 100).toFixed(1)}%`;
}

(async () => {
  const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
  const currentBlock = await provider.getBlockNumber();

  console.log(`Searching last 50000 blocks for Contribute events...`);
  const logs = await provider.getLogs({
    address: PRESALE,
    topics: [TOPIC],
    fromBlock: currentBlock - 50000,
    toBlock: currentBlock,
  });

  if (!logs.length) {
    console.log('No contributions found in recent blocks');
    return;
  }

  console.log(`Found ${logs.length} contributions. Replaying the last one...`);
  const log = logs[logs.length - 1];

  const contributor = ethers.getAddress('0x' + log.topics[1].slice(26));
  const dataHex = log.data.slice(2);
  const words = [];
  for (let i = 0; i < dataHex.length; i += 64) {
    words.push(BigInt('0x' + dataHex.slice(i, i + 64)));
  }
  const amountWei = words[1] || 0n;
  const ethAmount = parseFloat(ethers.formatEther(amountWei));

  const [priceRes, balance] = await Promise.all([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd').then(r => r.json()),
    provider.getBalance(PRESALE),
  ]);

  const ethPrice = priceRes.ethereum.usd;
  const totalEth = parseFloat(ethers.formatEther(balance));
  const usdSpent = ethAmount * ethPrice;
  const tokensReceived = ethAmount * tokenPricePerEth;
  const totalRaisedUsd = totalEth * ethPrice;
  const hardCapUsd = hardCapEth * ethPrice;

  const lines = [
    `<b>🚀 New Presale Buy! 🚀</b>`,
    '',
    `👤 <b>Buyer:</b>   <a href="https://etherscan.io/address/${contributor}">${shortAddr(contributor)}</a>`,
    `💵 <b>Spent:</b>   ${formatUsd(usdSpent)} (${ethAmount.toFixed(4)} ETH)`,
    `🌐 <b>Network:</b> Ethereum`,
    `📦 <b>Tokens Received:</b> ${formatTokens(tokensReceived)} ${TOKEN_SYMBOL}`,
    '━━━━━━━━━━━━━━━━━━',
    `📈 <b>Total Raised:</b>   ${formatUsd(totalRaisedUsd)}`,
    '',
    `<code>${progressBar(totalRaisedUsd, hardCapUsd)}</code>`,
  ];

  const text = lines.join('\n');
  const buttons = [[
    { text: '🔍 View TX', url: `https://etherscan.io/tx/${log.transactionHash}` },
    { text: '🚀 PinkSale', url: `https://www.pinksale.finance/launchpad/ethereum/${PRESALE}` },
  ]];

  console.log('\n--- Message preview ---');
  console.log(text.replace(/<[^>]+>/g, ''));
  console.log('--- End preview ---\n');

  // Send with image
  const hasImage = fs.existsSync(IMAGE_PATH);
  let sent = false;

  if (hasImage) {
    try {
      const form = new FormData();
      form.append('chat_id', CHAT_ID);
      form.append('caption', text);
      form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([fs.readFileSync(IMAGE_PATH)], { type: 'image/jpeg' }), 'buybotBDG.jpg');
      if (buttons) form.append('reply_markup', JSON.stringify({ inline_keyboard: buttons }));

      const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
      const data = await res.json();
      if (data.ok) {
        console.log(`Sent with image! Message ID: ${data.result.message_id}`);
        sent = true;
      } else {
        console.warn('sendPhoto failed, falling back:', data.description);
      }
    } catch (e) {
      console.warn('sendPhoto error, falling back:', e.message);
    }
  }

  if (!sent) {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: JSON.stringify({ inline_keyboard: buttons }),
    });
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json();
    if (data.ok) console.log(`Sent (text only)! Message ID: ${data.result.message_id}`);
    else console.error('Telegram error:', data.description);
  }

  console.log(`Contributor: ${contributor}`);
  console.log(`ETH: ${ethAmount} | USD: $${usdSpent.toFixed(2)} | Tokens: ${formatTokens(tokensReceived)}`);
})();
