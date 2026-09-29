import * as MyPOSEmbedded from 'mypos-embedded-checkout';

const paymentParams = {
  sid: '000000000000010',
  ipcLanguage: 'en',
  walletNumber: '61938166610',

  amount: 9.99,
  currency: 'EUR',

  orderID: 'ORDER-' + Date.now(),

  urlNotify: 'https://example.com/payment-notify',
  urlOk: window.location.href,
  urlCancel: window.location.href,

  keyIndex: 1,

  cartItems: [
    {
      article: 'Digital Product',
      quantity: 1,
      price: 9.99,
      currency: 'EUR'
    }
  ]
};

const callbackParams = {
  isSandbox: true,

  onSuccess: function (data) {
    console.log('Payment successful:', data);
    alert('Payment successful');
  },

  onError: function (error) {
    console.error('Payment failed:', error);
  }
};

MyPOSEmbedded.createPayment(
  'myPOSEmbeddedCheckout',
  paymentParams,
  callbackParams
);