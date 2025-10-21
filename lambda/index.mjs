import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as chrono from 'chrono-node';
import { createEvent } from 'ics';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION });

let botToken = null;

async function getBotToken() {
  if (botToken) return botToken;
  
  const command = new GetSecretValueCommand({ SecretId: process.env.SECRET_ID });
  const response = await secrets.send(command);
  const secret = JSON.parse(response.SecretString);
  botToken = secret.BOT_TOKEN;
  return botToken;
}

async function getUserPrefs(userId) {
  const command = new GetItemCommand({
    TableName: process.env.USERS_TABLE,
    Key: { user_id: { S: userId } }
  });
  
  try {
    const response = await dynamodb.send(command);
    return response.Item ? {
      timezone: response.Item.timezone?.S || 'Asia/Singapore',
      duration_min: parseInt(response.Item.duration_min?.N || '60')
    } : { timezone: 'Asia/Singapore', duration_min: 60 };
  } catch (error) {
    return { timezone: 'Asia/Singapore', duration_min: 60 };
  }
}

async function saveUserPrefs(userId, prefs) {
  const command = new PutItemCommand({
    TableName: process.env.USERS_TABLE,
    Item: {
      user_id: { S: userId },
      timezone: { S: prefs.timezone },
      duration_min: { N: prefs.duration_min.toString() }
    }
  });
  
  await dynamodb.send(command);
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const token = await getBotToken();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  return response.json();
}

function parseDateTime(text, timezone) {
  const results = chrono.parse(text, new Date(), { timezone });
  return results.length > 0 ? results[0] : null;
}

function extractTitle(text, dateMatch) {
  if (!dateMatch) return text.trim();
  
  const beforeDate = text.substring(0, dateMatch.index).trim();
  const afterDate = text.substring(dateMatch.index + dateMatch.text.length).trim();
  
  const title = beforeDate || afterDate || 'Event';
  return title.replace(/^(meeting|call|sync|event)\s*/i, '').trim() || 'Event';
}

async function createIcsFile(event) {
  const icsEvent = {
    title: event.title,
    start: [
      event.start.getFullYear(),
      event.start.getMonth() + 1,
      event.start.getDate(),
      event.start.getHours(),
      event.start.getMinutes()
    ],
    end: [
      event.end.getFullYear(),
      event.end.getMonth() + 1,
      event.end.getDate(),
      event.end.getHours(),
      event.end.getMinutes()
    ]
  };
  
  const { error, value } = createEvent(icsEvent);
  if (error) throw new Error('Failed to create ICS file');
  
  const fileName = `event-${Date.now()}.ics`;
  const command = new PutObjectCommand({
    Bucket: process.env.BUCKET,
    Key: fileName,
    Body: value,
    ContentType: 'text/calendar'
  });
  
  await s3.send(command);
  
  const signedUrl = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: process.env.BUCKET,
    Key: fileName
  }), { expiresIn: 3600 });
  
  return signedUrl;
}

async function handleCommand(message) {
  const { chat, from, text } = message;
  const userId = from.id.toString();
  const parts = text.split(' ');
  const command = parts[0];
  
  switch (command) {
    case '/help':
      await sendTelegramMessage(chat.id, 
        `🤖 <b>Telegram Scheduler Bot</b>\n\n` +
        `Send me messages with dates and times, I'll create calendar events!\n\n` +
        `<b>Examples:</b>\n` +
        `• "Team meeting tmr 3pm"\n` +
        `• "Doctor appointment next Friday 10:30am"\n` +
        `• "Project sync 25 Oct 2pm"\n\n` +
        `<b>Commands:</b>\n` +
        `/tz &lt;timezone&gt; - Set your timezone\n` +
        `/duration &lt;minutes&gt; - Set default event duration\n` +
        `/help - Show this help`
      );
      break;
      
    case '/tz':
      if (parts.length < 2) {
        await sendTelegramMessage(chat.id, 'Usage: /tz Asia/Singapore');
        return;
      }
      
      const timezone = parts.slice(1).join(' ');
      const prefs = await getUserPrefs(userId);
      prefs.timezone = timezone;
      await saveUserPrefs(userId, prefs);
      
      await sendTelegramMessage(chat.id, `✅ Timezone set to ${timezone}`);
      break;
      
    case '/duration':
      if (parts.length < 2 || isNaN(parts[1])) {
        await sendTelegramMessage(chat.id, 'Usage: /duration 60');
        return;
      }
      
      const duration = parseInt(parts[1]);
      const userPrefs = await getUserPrefs(userId);
      userPrefs.duration_min = duration;
      await saveUserPrefs(userId, userPrefs);
      
      await sendTelegramMessage(chat.id, `✅ Default duration set to ${duration} minutes`);
      break;
      
    default:
      await sendTelegramMessage(chat.id, 'Unknown command. Type /help for available commands.');
  }
}

async function handleMessage(message) {
  const { chat, from, text } = message;
  
  if (!text) return;
  
  if (text.startsWith('/')) {
    await handleCommand(message);
    return;
  }
  
  const userId = from.id.toString();
  const prefs = await getUserPrefs(userId);
  
  const dateMatch = parseDateTime(text, prefs.timezone);
  if (!dateMatch) return;
  
  const title = extractTitle(text, dateMatch);
  const start = dateMatch.start.date();
  const end = new Date(start.getTime() + prefs.duration_min * 60000);
  
  const event = { title, start, end };
  
  try {
    const icsUrl = await createIcsFile(event);
    
    const timeStr = start.toLocaleString('en-SG', {
      timeZone: prefs.timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    await sendTelegramMessage(chat.id,
      `📅 <b>Event detected:</b>\n` +
      `<b>Title:</b> ${title}\n` +
      `<b>When:</b> ${timeStr} (${prefs.duration_min}min)\n` +
      `<b>Timezone:</b> ${prefs.timezone}`,
      {
        inline_keyboard: [[
          { text: '📥 Add to Calendar', url: icsUrl }
        ]]
      }
    );
  } catch (error) {
    console.error('Error creating event:', error);
    await sendTelegramMessage(chat.id, '❌ Sorry, failed to create calendar event.');
  }
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    
    if (body.message) {
      await handleMessage(body.message);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};