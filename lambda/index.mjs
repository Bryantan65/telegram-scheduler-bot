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
  const now = new Date();
  
  // First try chrono-node's natural parsing
  let results = chrono.parse(text, now, { timezone });
  
  // If chrono found results, check if they make sense
  if (results.length > 0) {
    const result = results[0];
    // If chrono found a date but it's today and we have a day pattern, try fallback
    const dayPattern = /(\d{1,2})(st|nd|rd|th)/i;
    const dayMatch = text.match(dayPattern);
    
    if (dayMatch && result.start.date().getDate() === now.getDate()) {
      // Chrono might have defaulted to today, try our fallback
      results = [];
    }
  }
  
  // Fallback for day patterns like "29th 5am"
  if (results.length === 0) {
    // More precise regex for day + time patterns
    const dayTimeMatch = text.match(/(\d{1,2})(st|nd|rd|th)\s+(\d{1,2})(:\d{2})?(am|pm)/i);
    
    if (dayTimeMatch) {
      const day = parseInt(dayTimeMatch[1]);
      const hour = parseInt(dayTimeMatch[3]);
      const ampm = dayTimeMatch[5].toLowerCase();
      const minutes = dayTimeMatch[4] ? parseInt(dayTimeMatch[4].substring(1)) : 0;
      
      console.log('Matched day+time:', { day, hour, ampm, minutes });
      
      // Convert to 24-hour format
      let hour24 = hour;
      if (ampm === 'pm' && hour !== 12) hour24 += 12;
      if (ampm === 'am' && hour === 12) hour24 = 0;
      
      console.log('Converted to 24h:', hour24);
      
      // Get current month and year
      const currentMonth = now.getMonth(); // 0-based month
      const currentYear = now.getFullYear();
      
      // Create date object directly instead of parsing string
      const targetDate = new Date(currentYear, currentMonth, day, hour24, minutes);
      console.log('Created target date:', targetDate.toISOString());
      
      // Create a mock chrono result
      results = [{
        index: dayTimeMatch.index,
        text: dayTimeMatch[0],
        start: {
          date: () => targetDate,
          knownValues: { year: currentYear, month: currentMonth + 1, day, hour: hour24, minute: minutes }
        }
      }];
    }
    
    // Try day-only patterns like "29th"
    if (results.length === 0) {
      const dayOnlyMatch = text.match(/(\d{1,2})(st|nd|rd|th)(?!\s*\d)/i);
      if (dayOnlyMatch) {
        const day = parseInt(dayOnlyMatch[1]);
        const currentMonth = now.toLocaleString('en-US', { month: 'long', timeZone: timezone });
        const currentYear = now.getFullYear();
        
        const dateStr = `${currentMonth} ${day}, ${currentYear}`;
        console.log('Parsing day-only pattern:', dateStr);
        
        const fallbackResults = chrono.parse(dateStr, now, { timezone });
        if (fallbackResults.length > 0) {
          results = fallbackResults;
        }
      }
    }
    
    // Fallback for standalone weekdays
    if (results.length === 0) {
      const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const lowerText = text.toLowerCase();
      
      for (const day of weekdays) {
        if (lowerText.includes(day)) {
          const fallbackResults = chrono.parse(`this ${day}`, now, { timezone });
          if (fallbackResults.length > 0) {
            results = fallbackResults;
            break;
          }
        }
      }
    }
  }
  
  return results.length > 0 ? results[0] : null;
}

function extractTitle(text, dateMatch) {
  if (!dateMatch) return text.trim();
  
  // Find all date/time patterns in the text to remove them
  const patterns = [
    /(\d{1,2})(st|nd|rd|th)\s+(\d{1,2})(:\d{2})?(am|pm)/gi, // "29th 5am"
    /(\d{1,2})(st|nd|rd|th)/gi, // "29th"
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, // weekdays
    /\b(tomorrow|tmr|today)\b/gi, // relative days
    /\b\d{1,2}(:\d{2})?(am|pm)\b/gi // standalone times
  ];
  
  let cleanText = text;
  
  // Remove all date/time patterns
  patterns.forEach(pattern => {
    cleanText = cleanText.replace(pattern, ' ');
  });
  
  // Clean up extra spaces and common words
  cleanText = cleanText
    .replace(/\s+/g, ' ') // multiple spaces to single
    .replace(/\b(at|on|the|a|an)\b/gi, ' ') // common words
    .trim();
  
  // If nothing left, use fallback
  if (!cleanText || cleanText.length < 2) {
    return 'Event';
  }
  
  return cleanText;
}

function createGoogleCalendarUrl(event, timezone) {
  const baseUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE';
  
  let dates;
  if (event.allDay) {
    // All-day event format: YYYYMMDD (no timezone conversion needed)
    const startDate = event.start.toISOString().split('T')[0].replace(/-/g, '');
    const endDate = new Date(event.start.getTime() + 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0].replace(/-/g, '');
    dates = `${startDate}/${endDate}`;
  } else {
    // For timed events, format as local time without timezone conversion
    const formatLocalTime = (date) => {
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const hour = date.getHours().toString().padStart(2, '0');
      const minute = date.getMinutes().toString().padStart(2, '0');
      return `${year}${month}${day}T${hour}${minute}00`;
    };
    
    const startTime = formatLocalTime(event.start);
    const endTime = formatLocalTime(event.end);
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
    // Timed event - use local time components directly
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
    // Add timezone info to ICS
    icsEvent.startInputType = 'local';
    icsEvent.endInputType = 'local';
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
  console.log('Final parsed date:', start.toISOString());
  
  // Check if time was specified or just date
  const hasTime = dateMatch.start.knownValues.hour !== undefined;
  console.log('Has time:', hasTime, 'Known values:', dateMatch.start.knownValues);
  

  
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
        day: 'numeric',
        timeZone: prefs.timezone
      }) + ' (All day)';
    } else {
      // Create a new date in the user's timezone to avoid UTC conversion issues
      const localDate = new Date(start.getTime());
      whenText = localDate.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
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