require('dotenv').config();

const express = require('express');
const { MyPOSClient } = require('mypos-online-checkout');

const app = express();
const PORT = 3000;

// 1. Прочитаме Configuration Pack
const pack = process.env.MYPOS_CONFIG_PACK;

if (!pack) {
  console.error('❌ Липсва MYPOS_CONFIG_PACK в .env');
  process.exit(1);
}

let config;

try {
  config = JSON.parse(
    Buffer.from(pack.trim(), 'base64').toString('utf8')
  );
} catch (err) {
  console.error('❌ Невалиден myPOS Configuration Pack');
  process.exit(1);
}

// 2. Създаваме myPOS client
const mypos = new MyPOSClient({
  storeId: String(config.sid),
  keyIndex: Number(config.idx),
  privateKey: config.pk,
  publicKey: config.pc,

  // Това е твоят реален myPOS магазин:
  isSandbox: false,
});

// 3. Само проверка, че backend-ът работи
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'NovaMind myPOS Checkout',
    storeId: String(config.sid),
    environment: 'production',
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('✅ NovaMind myPOS backend работи');
  console.log(`👉 http://localhost:${PORT}/health`);
  console.log('');
});