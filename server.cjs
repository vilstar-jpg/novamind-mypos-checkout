require('dotenv').config();

const express = require('express');
const crypto = require('crypto');

const app = express();

app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const MYPOS_URL = 'https://www.mypos.com/vmp/checkout';

// ======================================================
// myPOS CONFIGURATION PACK
// ======================================================

const pack = process.env.MYPOS_CONFIG_PACK;

if (!pack) {
  console.error('❌ Липсва MYPOS_CONFIG_PACK');
  process.exit(1);
}

let config;

try {
  config = JSON.parse(
    Buffer.from(pack.trim(), 'base64').toString('utf8')
  );
} catch (error) {
  console.error('❌ Configuration Pack не може да бъде прочетен.');
  process.exit(1);
}

const requiredConfig = ['sid', 'cn', 'idx', 'pk', 'pc'];

for (const key of requiredConfig) {
  if (!config[key]) {
    console.error(`❌ Configuration Pack няма поле: ${key}`);
    process.exit(1);
  }
}

// ======================================================
// PRODUCTS
// ======================================================

const products = {
  chatgpt: {
    name: 'ChatGPT Настройки за 10 минути',
    amount: 20.00,
  },

  calls: {
    name: 'AI Анализ на Обаждания',
    amount: 89.00,
  },

  clients: {
    name: 'AI Клиентска Машина',
    amount: 97.99,
  },

  offers: {
    name: 'Система за запитвания и оферти',
    amount: 199.00,
  },
};

// ======================================================
// HELPERS
// ======================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Официалната myPOS логика:
//
// 1. concatenate values with "-"
// 2. Base64 encode
// 3. RSA SHA-256 sign
// 4. Base64 signature

function createSignature(params) {
  const values = Object.values(params).map(value => String(value));

  const joined = values.join('-');

  const base64Data = Buffer
    .from(joined, 'utf8')
    .toString('base64');

  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(base64Data, 'utf8'),
    config.pk
  );

  return signature.toString('base64');
}

function verifySignature(entries) {
  const signatureEntry = entries.find(
    ([key]) => key === 'Signature'
  );

  if (!signatureEntry) {
    return false;
  }

  const receivedSignature = signatureEntry[1];

  const values = entries
    .filter(([key]) => key !== 'Signature')
    .map(([, value]) => String(value));

  const joined = values.join('-');

  const base64Data = Buffer
    .from(joined, 'utf8')
    .toString('base64');

  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(base64Data, 'utf8'),
    config.pc,
    Buffer.from(receivedSignature, 'base64')
  );
}

// ======================================================
// HOME
// ======================================================

app.get('/', (req, res) => {
  res.send(`
    <h1>NovaMind Digital</h1>
    <p>myPOS Checkout backend is online.</p>
  `);
});

// ======================================================
// HEALTH
// ======================================================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'NovaMind myPOS Checkout',
    storeId: String(config.sid),
    environment: 'production',
  });
});

// ======================================================
// PAYMENT
// ======================================================

app.get('/pay/:product', (req, res) => {
  try {
    const product = products[req.params.product];

    if (!product) {
      return res.status(404).send('Product not found');
    }

    const protocol =
      req.headers['x-forwarded-proto'] || req.protocol;

    const baseUrl =
      `${protocol}://${req.get('host')}`;

    const orderId =
      `NM-${req.params.product}-${Date.now()}`;

    const amount =
      Number(product.amount).toFixed(2);

    // IMPORTANT:
    // Signature depends on EXACT parameter order.
    const params = {
      IPCmethod: 'IPCPurchase',
      IPCVersion: '1.4',
      IPCLanguage: 'BG',

      SID: String(config.sid),

      WalletNumber: String(config.cn),

      Amount: amount,
      Currency: 'EUR',

      OrderID: orderId,

      URL_OK: `${baseUrl}/success`,
      URL_Cancel: `${baseUrl}/cancel`,
      URL_Notify: `${baseUrl}/mypos/notify`,

      CardTokenRequest: '0',

      KeyIndex: String(config.idx),

      // Customer enters the required information
      // on the myPOS payment page.
      PaymentParametersRequired: '2',

      CartItems: '1',

      Article_1: product.name,
      Quantity_1: '1',
      Price_1: amount,
      Currency_1: 'EUR',
      Amount_1: amount,
    };

    params.Signature =
      createSignature(params);

    const inputs =
      Object.entries(params)
        .map(([key, value]) => {
          return `
            <input
              type="hidden"
              name="${escapeHtml(key)}"
              value="${escapeHtml(value)}"
            >
          `;
        })
        .join('');

    res.send(`
      <!doctype html>

      <html lang="bg">

      <head>
        <meta charset="utf-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >

        <title>NovaMind Digital – myPOS</title>
      </head>

      <body>

        <p>
          Пренасочваме те към защитеното
          плащане на myPOS...
        </p>

        <form
          id="mypos-payment"
          method="POST"
          action="${MYPOS_URL}"
        >

          ${inputs}

          <noscript>
            <button type="submit">
              Продължи към myPOS
            </button>
          </noscript>

        </form>

        <script>
          document
            .getElementById('mypos-payment')
            .submit();
        </script>

      </body>

      </html>
    `);

  } catch (error) {

    console.error(
      '❌ Payment initialization:',
      error.name,
      error.message
    );

    res.status(500).json({
      ok: false,
      error: error.name,
      message: error.message,
    });
  }
});

// ======================================================
// myPOS SERVER-TO-SERVER NOTIFICATION
// ======================================================

app.post(
  '/mypos/notify',

  express.text({
    type: '*/*',
  }),

  (req, res) => {

    try {

      const params =
        new URLSearchParams(req.body);

      const entries =
        Array.from(params.entries());

      const data =
        Object.fromEntries(entries);

      if (!verifySignature(entries)) {

        console.error(
          '❌ INVALID myPOS SIGNATURE'
        );

        return res
          .status(403)
          .type('text/plain')
          .send('INVALID');
      }

      if (
        String(data.SID) !==
        String(config.sid)
      ) {

        console.error(
          '❌ Wrong Store ID'
        );

        return res
          .status(403)
          .type('text/plain')
          .send('INVALID');
      }

      console.log(
        '✅ MYPOS PAYMENT CONFIRMED'
      );

      console.log(
        'Order:',
        data.OrderID
      );

      console.log(
        'Amount:',
        data.Amount,
        data.Currency
      );

      console.log(
        'Transaction:',
        data.IPC_Trnref
      );

      // ВАЖНО:
      // Следващата стъпка тук ще бъде:
      //
      // → Shopify order
      // → mark paid
      // → Digital Products PDF delivery

      return res
        .status(200)
        .type('text/plain')
        .send('OK');

    } catch (error) {

      console.error(
        '❌ Notify error:',
        error.message
      );

      return res
        .status(500)
        .type('text/plain')
        .send('ERROR');
    }
  }
);

// ======================================================
// SUCCESS
// ======================================================

app.all(
  '/success',

  express.urlencoded({
    extended: false,
  }),

  (req, res) => {

    res.send(`
      <!doctype html>

      <html lang="bg">

      <head>
        <meta charset="utf-8">

        <title>
          Плащането е прието
        </title>
      </head>

      <body>

        <h1>
          Благодарим!
        </h1>

        <p>
          Плащането е изпратено за
          потвърждение от myPOS.
        </p>

        <p>
          <a href="https://novamind-ai.store">
            Обратно към NovaMind Digital
          </a>
        </p>

      </body>

      </html>
    `);
  }
);

// ======================================================
// CANCEL
// ======================================================

app.all('/cancel', (req, res) => {

  res.redirect(
    'https://novamind-ai.store'
  );
});

// ======================================================
// START
// ======================================================

app.listen(PORT, () => {

  console.log(
    `✅ NovaMind myPOS backend started on port ${PORT}`
  );

});