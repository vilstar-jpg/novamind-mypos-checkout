require('dotenv').config();

const express = require('express');
const crypto = require('crypto');

const app = express();

app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const MYPOS_URL = 'https://www.mypos.com/vmp/checkout';
const MERCHANT_URL = (process.env.MERCHANT_URL || 'https://novamind-ai.store').replace(/\/$/, '');
const NOTIFY_URL = (process.env.MYPOS_NOTIFY_URL || 'https://novamind-mypos-checkout-wvkt.onrender.com/mypos/notify').replace(/\/$/, '');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || 'm4uz7j-hh.myshopify.com';

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
    shopifyVariantId: '58710575939968',
  },

  calls: {
    name: 'AI Анализ на Обаждания',
    amount: 89.00,
    shopifyVariantId: '59985549459840',
  },

  clients: {
    name: 'AI Клиентска Машина',
    amount: 97.99,
    shopifyVariantId: '58710126723456',
  },

  offers: {
    name: 'Система за запитвания и оферти',
    amount: 199.00,
    shopifyVariantId: '59985549459840',
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

function requirePersistence() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Payment persistence is not configured');
  }
}

async function supabaseRequest(path, options = {}) {
  requirePersistence();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function createPaymentIntent(orderId, productKey, product, amount) {
  const rows = await supabaseRequest('payment_intents', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify({
      mypos_order_id: orderId,
      product_key: productKey,
      product_title: product.name,
      shopify_variant_id: product.shopifyVariantId,
      amount,
      currency: 'EUR',
    }),
  });
  if (rows?.[0]) return rows[0];
  const existing = await supabaseRequest(`payment_intents?select=*&mypos_order_id=eq.${encodeURIComponent(orderId)}&limit=1`);
  if (!existing?.[0]) throw new Error('Could not create or load payment intent');
  return existing[0];
}

async function updatePaymentIntent(orderId, patch) {
  return supabaseRequest(`payment_intents?mypos_order_id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}

async function loadPaymentIntent(orderId) {
  const rows = await supabaseRequest(`payment_intents?select=*&mypos_order_id=eq.${encodeURIComponent(orderId)}&limit=1`);
  return rows?.[0] || null;
}

async function shopifyAccessToken() {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) throw new Error('Shopify credentials are not configured');
  const response = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Shopify token ${response.status}`);
  return body.access_token;
}

async function shopifyGraphql(query, variables) {
  const token = await shopifyAccessToken();
  const response = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Shopify GraphQL ${response.status}`);
  return body.data;
}

async function createAndMarkShopifyOrder(intent, data) {
  const order = await shopifyGraphql(`mutation CreateOrder($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) { order { id name } userErrors { field message } }
  }`, { order: {
    email: data.Email || data.CustomerEmail || undefined,
    lineItems: [{ variantId: `gid://shopify/ProductVariant/${intent.shopify_variant_id}`, quantity: 1 }],
    note: `myPOS OrderID: ${intent.mypos_order_id}`,
    customAttributes: [{ key: 'mypos_transaction_ref', value: String(data.IPC_Trnref) }],
  }});
  const errors = order.orderCreate.userErrors || [];
  if (errors.length || !order.orderCreate.order?.id) throw new Error(errors.map(x => x.message).join('; ') || 'Shopify order creation failed');
  const orderId = order.orderCreate.order.id;
  const paid = await shopifyGraphql(`mutation MarkPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) { order { id name } userErrors { field message } }
  }`, { input: { id: orderId } });
  const paidErrors = paid.orderMarkAsPaid.userErrors || [];
  if (paidErrors.length) throw new Error(paidErrors.map(x => x.message).join('; '));
  return orderId;
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

app.get('/pay/:product', async (req, res) => {
  try {
    const product = products[req.params.product];

    if (!product) {
      return res.status(404).send('Product not found');
    }

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

      // Redirects belong to the approved merchant website domain.
      URL_OK: MERCHANT_URL,
      URL_Cancel: MERCHANT_URL,
      // Notify is a public HTTPS server-to-server endpoint and may be hosted
      // separately from the merchant website.
      URL_Notify: NOTIFY_URL,

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

    await createPaymentIntent(orderId, req.params.product, product, amount);

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

  async (req, res) => {

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

      if (String(data.IPCmethod) !== 'IPCPurchaseNotify') {
        console.error('❌ Unexpected myPOS notification method');
        return res.status(400).type('text/plain').send('INVALID');
      }

      const pending = await loadPaymentIntent(data.OrderID);
      if (!pending) {
        console.error('❌ Unknown myPOS OrderID');
        return res.status(409).type('text/plain').send('INVALID');
      }

      if (
        String(data.Currency) !== pending.currency ||
        String(data.Amount) !== pending.amount
      ) {
        console.error('❌ myPOS amount/currency mismatch');
        return res.status(409).type('text/plain').send('INVALID');
      }

      if (String(data.Status) !== '0') {
        await updatePaymentIntent(data.OrderID, {
          status: 'FAILED',
          last_error: `myPOS declined: ${data.StatusMsg || data.Status}`,
        });
        console.error('❌ myPOS payment declined:', data.Status, data.StatusMsg || '');
        return res.status(200).type('text/plain').send('OK');
      }

      if (!data.IPC_Trnref) {
        console.error('❌ Missing myPOS transaction reference');
        return res.status(409).type('text/plain').send('INVALID');
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

      if (pending.status === 'SHOPIFY_CREATED' && pending.shopify_order_id) {
        return res.status(200).type('text/plain').send('OK');
      }

      await updatePaymentIntent(data.OrderID, {
        status: 'PAID_VERIFIED',
        mypos_transaction_ref: String(data.IPC_Trnref),
        customer_email: data.Email || data.CustomerEmail || null,
        paid_at: new Date().toISOString(),
      });

      try {
        await updatePaymentIntent(data.OrderID, { status: 'SHOPIFY_PENDING' });
        const shopifyOrderId = await createAndMarkShopifyOrder(pending, data);
        await updatePaymentIntent(data.OrderID, {
          status: 'SHOPIFY_CREATED',
          shopify_order_id: shopifyOrderId,
          shopify_created_at: new Date().toISOString(),
          last_error: null,
        });
      } catch (shopifyError) {
        await updatePaymentIntent(data.OrderID, {
          status: 'SHOPIFY_PENDING',
          last_error: shopifyError.message,
          retry_count: Number(pending.retry_count || 0) + 1,
        });
        console.error('❌ Shopify fulfillment pending:', shopifyError.message);
        return res.status(500).type('text/plain').send('RETRY');
      }

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
