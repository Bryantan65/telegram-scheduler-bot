// Check webhook status
const WEBHOOK_URL = 'https://u9nmuerhc9.execute-api.us-east-1.amazonaws.com/prod/webhook';

async function checkWebhook() {
  // Get bot token from AWS Secrets Manager first
  console.log('You need to get your bot token and run:');
  console.log(`curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"`);
  console.log('');
  console.log('If webhook is not set, run:');
  console.log(`curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" -H "Content-Type: application/json" -d '{"url":"${WEBHOOK_URL}"}'`);
}

checkWebhook();