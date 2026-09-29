require('dotenv').config();

const express = require('express');
const { MyPOSClient } = require('mypos-online-checkout');

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

const pack = process.env.MYPOS_CONFIG_PACK;

if (!pack) {
  console.error('❌ Липсва MYPOS_CONFIG_PACK');
  process.exit(1);
}

const config = JSON.parse(
  Buffer.from(pack.trim(), 'base64').toString('utf8')
);

const mypos = new MyPOSClient({
  storeId: String(config.sid),
  keyIndex: Number(config.idx),
  privateKey: config.pk,
  publicKey: config.pc,
  isSandbox: false,
});

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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'NovaMind myPOS Checkout',
    environment: 'production',
  });
});

app.get('/pay/:product', async (req, res) => {
  try {
    const product = products[req.params.product];

    if (!product) {
      return res.status(404).send('Product not found');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const orderId =
      'NM-' +
      req.params.product +
      '-' +
      Date.now();

    const fields = await mypos.generateCheckoutFields({
      orderId,
      amount: product.amount,
      currency: 'EUR',

      urlOk: `${baseUrl}/success`,
      urlCancel: `${baseUrl}/cancel`,
      urlNotify: `${baseUrl}/mypos/notify`,

      cartItems: [
        {
          name: product.name,
          quantity: 1,
          price: product.amount,
        },
      ],
    });

    const inputs = Object.entries(fields)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`
      )
      .join('');

    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>NovaMind Digital – myPOS</title>
      </head>

      <body>
        <p>Пренасочваме те към защитеното плащане на myPOS...</p>

        <form
          id="mypos-payment"
          method="POST"
          action="${escapeHtml(mypos.checkoutUrl)}"
        >
          ${inputs}
        </form>

        <script>
          document.getElementById('mypos-payment').submit();
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error(error);
    res.status(500).send('Payment initialization failed');
  }
});

app.post('/mypos/notify', async (req, res) => {
  try {
    const params = {};

    for (const [key, value] of Object.entries(req.body)) {
      params[key] = String(value);
    }

    const result =
      await mypos.validateNotification(params);

    if (result.success) {
      console.log(
        '✅ MYPOS PAYMENT CONFIRMED:',
        result.data.orderId,
        result.data.amount,
        result.data.currency
      );
    } else {
      console.error(
        '❌ myPOS notification:',
        result.error
      );
    }

    res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Invalid myPOS notification:', error.message);
    res.status(403).send('INVALID');
  }
});

app.get('/success', (req, res) => {
  res.send(`
    <h1>Благодарим за плащането!</h1>
    <p>Плащането се потвърждава от myPOS.</p>
    <p><a href="https://novamind-ai.store">Обратно към NovaMind Digital</a></p>
  `);
});

app.get('/cancel', (req, res) => {
  res.redirect('https://novamind-ai.store');
});

app.listen(PORT, () => {
  console.log(`✅ NovaMind myPOS: http://localhost:${PORT}`);
});