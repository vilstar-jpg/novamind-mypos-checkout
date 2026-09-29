require('dotenv').config();

const pack = process.env.MYPOS_CONFIG_PACK;

if (!pack) {
  console.error('❌ MYPOS_CONFIG_PACK липсва в .env');
  process.exit(1);
}

try {
  const decoded = Buffer.from(pack.trim(), 'base64').toString('utf8');
  const config = JSON.parse(decoded);

  console.log('\n✅ myPOS Configuration Pack е прочетен успешно\n');

  console.log('Store ID / SID:', config.sid);
  console.log('Client / Wallet Number:', config.cn);
  console.log('Key Index:', config.idx);

  console.log(
    'Private Key:',
    config.pk ? `✅ намерен (${config.pk.length} символа)` : '❌ липсва'
  );

  console.log(
    'myPOS Public Certificate:',
    config.pc ? `✅ намерен (${config.pc.length} символа)` : '❌ липсва'
  );

  console.log('\n🔒 Private Key НЕ е показан.');
} catch (error) {
  console.error('❌ Configuration Pack не може да бъде прочетен.');
  console.error(error.message);
}