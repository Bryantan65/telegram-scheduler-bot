import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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
  let results = chrono.parse(text, new Date(), { timezone });
  
  // If no results, try fallback for standalone weekdays
  if (results.length === 0) {
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const lowerText = text.toLowerCase();
    
    for (const day of weekdays) {
      if (lowerText.includes(day)) {
        // Parse as "this [weekday]"
        const fallbackResults = chrono.parse(`this ${day}`, new Date(), { timezone });
        if (fallbackResults.length > 0) {
          results = fallbackResults;
          break;
        }
      }
    }
  }
  
  return results.length > 0 ? results[0] : null;
}

function extractTitle(text, dateMatch) {
  if (!dateMatch) return text.trim();
  
  const beforeDate = text.substring(0, dateMatch.index).trim();
  const afterDate = text.substring(dateMatch.index + dateMatch.text.length).trim();
  
  const title = beforeDate || afterDate || 'Event';
  return title.replace(/^(meeting|call|sync|event)\s*/i, '').trim() || 'Event';
}

function createGoogleCalendarUrl(event, timezone) {
  const baseUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE';
  
  let dates;
  if (event.allDay) {
    // All-day event format: YYYYMMDD
    const startDate = event.start.toISOString().split('T')[0].replace(/-/g, '');
    const endDate = new Date(event.start.getTime() + 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0].replace(/-/g, '');
    dates = `${startDate}/${endDate}`;
  } else {
    // Timed event format: YYYYMMDDTHHMMSSZ
    const startTime = event.start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const endTime = event.end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    dates = `${startTime}/${endTime}`;
  }
  
  const params = new URLSearchParams({
    text: event.title,
    dates: dates,
    ctz: timezone
  });
  
  return `${baseUrl}&${params.toString()}`;
}

async function createIcsFile(event) {
  const icsEvent = {
    title: event.title
  };
  
  if (event.allDay) {
    // All-day event - only date, no time
    icsEvent.start = [
      event.start.getFullYear(),
      event.start.getMonth() + 1,
      event.start.getDate()
    ];
    // For all-day events, don't set end time
  } else {
    // Timed event
    icsEvent.start = [
      event.start.getFullYear(),
      event.start.getMonth() + 1,
      event.start.getDate(),
      event.start.getHours(),
      event.start.getMinutes()
    ];
    icsEvent.end = [
      event.end.getFullYear(),
      event.end.getMonth() + 1,
      event.end.getDate(),
      event.end.getHours(),
      event.end.getMinutes()
    ];
  }
  
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
    case '/start':
    case '/help':
      await sendTelegramMessage(chat.id, 
        `🤖 <b>Welcome to Telegram Scheduler Bot!</b>\n\n` +
        `I help you create calendar events from natural language! Just send me messages with dates and times.\n\n` +
        `<b>Examples:</b>\n` +
        `• "Team meeting tmr 3pm"\n` +
        `• "Doctor appointment next Friday 10:30am"\n` +
        `• "Project sync 25 Oct 2pm"\n\n` +
        `<b>Commands:</b>\n` +
        `/tz &lt;timezone&gt; - Set your timezone (default: Asia/Singapore)\n` +
        `/duration &lt;minutes&gt; - Set default event duration (default: 60min)\n` +
        `/help - Show this help\n\n` +
        `Try sending me: <i>"Meeting tomorrow 2pm"</i> 🚀`
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
  
  // Check if time was specified or just date
  const hasTime = dateMatch.start.knownValues.hour !== undefined;
  
  let event;
  if (hasTime) {
    // Timed event
    const end = new Date(start.getTime() + prefs.duration_min * 60000);
    event = { title, start, end, allDay: false };
  } else {
    // All-day event
    event = { title, start, allDay: true };
  }
  
  try {
    const icsUrl = await createIcsFile(event);
    
    let whenText;
    if (event.allDay) {
      whenText = start.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric'
      }) + ' (All day)';
    } else {
      whenText = start.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }) + ` (${prefs.duration_min}min)`;
    }
    
    // Create Google Calendar URL
    const googleUrl = createGoogleCalendarUrl(event, prefs.timezone);
    
    await sendTelegramMessage(chat.id,
      `📅 <b>Event detected:</b>\n` +
      `<b>Title:</b> ${title}\n` +
      `<b>When:</b> ${whenText}\n` +
      `<b>Timezone:</b> ${prefs.timezone}`,
      {
        inline_keyboard: [
          [
            { text: '📥 Download ICS', url: icsUrl },
            { text: '📅 Google Calendar', url: googleUrl }
          ]
        ]
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