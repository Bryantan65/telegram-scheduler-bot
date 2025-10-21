// Get bot token from AWS and check webhook status
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({ region: 'us-east-1' });
const WEBHOOK_URL = 'https://u9nmuerhc9.execute-api.us-east-1.amazonaws.com/prod/webhook';

async function verifyWebhook() {
  try {
    // Get bot token from AWS Secrets Manager
    const command = new GetSecretValueCommand({ SecretId: 'telegram/bot' });
    const response = await secrets.send(command);
    const secret = JSON.parse(response.SecretString);
    const botToken = secret.BOT_TOKEN;
    
    console.log('✅ Bot token retrieved from AWS Secrets Manager');
    console.log('Current webhook URL should be:', WEBHOOK_URL);
    
    // Check current webhook status
    const webhookResponse = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const webhookData = await webhookResponse.json();
    
    console.log('\n📡 Current webhook status:');
    console.log('URL:', webhookData.result.url);
    console.log('Has custom certificate:', webhookData.result.has_custom_certificate);
    console.log('Pending update count:', webhookData.result.pending_update_count);
    console.log('Last error date:', webhookData.result.last_error_date);
    console.log('Last error message:', webhookData.result.last_error_message);
    
    if (webhookData.result.url !== WEBHOOK_URL) {
      console.log('\n❌ Webhook URL mismatch!');
      console.log('Expected:', WEBHOOK_URL);
      console.log('Current:', webhookData.result.url);
      console.log('\nTo fix, run:');
      console.log(`curl -X POST "https://api.telegram.org/bot${botToken}/setWebhook" -H "Content-Type: application/json" -d '{"url":"${WEBHOOK_URL}"}'`);
    } else {
      console.log('\n✅ Webhook URL is correct!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

verifyWebhook();