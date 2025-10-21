import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import * as chrono from 'chrono-node';
import { createEvent } from 'ics';

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
      duration_min: parseInt(response.Item.duration_min?.N || '60'),
      bot_admins: response.Item.bot_admins?.SS || [],
      blacklist: response.Item.blacklist?.SS || ['now'],
      whitelist: response.Item.whitelist?.SS || []
    } : { timezone: 'Asia/Singapore', duration_min: 60, bot_admins: [], blacklist: ['now'], whitelist: [] };
  } catch (error) {
    return { timezone: 'Asia/Singapore', duration_min: 60, bot_admins: [], blacklist: ['now'], whitelist: [] };
  }
}

async function saveUserPrefs(userId, prefs) {
  const item = {
    user_id: { S: userId },
    timezone: { S: prefs.timezone },
    duration_min: { N: prefs.duration_min.toString() }
  };
  
  // Only add string sets if they have values (DynamoDB doesn't allow empty SS)
  if (prefs.bot_admins && prefs.bot_admins.length > 0) {
    item.bot_admins = { SS: prefs.bot_admins };
  }
  
  if (prefs.blacklist && prefs.blacklist.length > 0) {
    item.blacklist = { SS: prefs.blacklist };
  } else {
    item.blacklist = { SS: ['now'] }; // Default blacklist
  }
  
  if (prefs.whitelist && prefs.whitelist.length > 0) {
    item.whitelist = { SS: prefs.whitelist };
  }
  
  const command = new PutItemCommand({
    TableName: process.env.USERS_TABLE,
    Item: item
  });
  
  await dynamodb.send(command);
}

async function getBotAdmins(groupId) {
  const prefs = await getUserPrefs(groupId);
  return prefs.bot_admins || [];
}

async function addBotAdmin(groupId, userId) {
  const prefs = await getUserPrefs(groupId);
  if (!prefs.bot_admins) prefs.bot_admins = [];
  if (!prefs.bot_admins.includes(userId)) {
    prefs.bot_admins.push(userId);
    await saveUserPrefs(groupId, prefs);
  }
}

function isValidTimezone(timezone) {
  try {
    new Date().toLocaleString('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  try {
    const token = await getBotToken();
    console.log('Bot token retrieved:', token ? 'Yes' : 'No');
    
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    const body = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    
    console.log('Sending message to Telegram:', { chatId, textLength: text.length });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const result = await response.json();
    console.log('Telegram API response:', { ok: result.ok, status: response.status });
    
    if (!result.ok) {
      console.error('Telegram API error:', result);
    }
    
    return result;
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    throw error;
  }
}

function parseDateTime(text, timezone) {
  const now = new Date();
  
  // Use safe timezone - fallback to Singapore if invalid
  const safeTimezone = isValidTimezone(timezone) ? timezone : 'Asia/Singapore';
  
  // Convert dot notation to colon notation for better parsing
  let cleanedText = text.replace(/(\d{1,2})\.(\d{2})(am|pm)/gi, '$1:$2$3');
  
  // Try to extract just the first time from ranges like "3:30pm-4:30pm"
  const timeRangeMatch = cleanedText.match(/(\d{1,2}):?(\d{2})?(am|pm)\s*[-–]\s*(\d{1,2}):?(\d{2})?(am|pm)/i);
  if (timeRangeMatch) {
    // Replace the range with just the start time
    const startTime = `${timeRangeMatch[1]}${timeRangeMatch[2] ? ':' + timeRangeMatch[2] : ''}${timeRangeMatch[3]}`;
    cleanedText = cleanedText.replace(timeRangeMatch[0], startTime);
  }
  
  console.log('Original text:', text);
  console.log('Cleaned text:', cleanedText);
  
  // First try chrono-node's natural parsing
  let results = chrono.parse(cleanedText, now, { timezone: safeTimezone });
  
  console.log('Chrono results:', results.length > 0 ? results[0].start.date().toISOString() : 'No results');
  
  // If chrono found results, use them unless they seem wrong
  if (results.length > 0) {
    const result = results[0];
    // Only override chrono if it found today's date but we have a specific day pattern
    const dayPattern = /(\d{1,2})(st|nd|rd|th)/i;
    const dayMatch = text.match(dayPattern);
    
    if (dayMatch && result.start.date().getDate() === now.getDate() && result.start.date().getMonth() === now.getMonth()) {
      // Chrono might have defaulted to today when user meant a specific day, try our fallback
      results = [];
    } else {
      // Chrono found a good result, use it
      return results[0];
    }
  }
  
  // Fallback for 24-hour time format like "1630", "16:30", "0900"
  if (results.length === 0) {
    const militaryTimeMatch = text.match(/\b(\d{1,2}):?(\d{2})\b/);
    if (militaryTimeMatch) {
      const hour = parseInt(militaryTimeMatch[1]);
      const minutes = parseInt(militaryTimeMatch[2]);
      
      // Only process if it looks like a valid time (hour 0-23, minutes 0-59)
      if (hour >= 0 && hour <= 23 && minutes >= 0 && minutes <= 59) {
        console.log('Found 24-hour time:', { hour, minutes });
        
        const targetDate = new Date(now);
        if (text.toLowerCase().includes('tmr') || text.toLowerCase().includes('tomorrow')) {
          targetDate.setDate(targetDate.getDate() + 1);
        }
        targetDate.setHours(hour, minutes, 0, 0);
        
        console.log('24-hour target date:', targetDate.toISOString());
        
        results = [{
          index: militaryTimeMatch.index,
          text: militaryTimeMatch[0],
          start: {
            date: () => targetDate,
            knownValues: { 
              year: targetDate.getFullYear(), 
              month: targetDate.getMonth() + 1, 
              day: targetDate.getDate(),
              hour: hour, 
              minute: minutes 
            }
          }
        }];
      }
    }
  }
  
  // Fallback for dot notation times like "3.30pm"
  if (results.length === 0) {
    const dotTimeMatch = text.match(/(\d{1,2})\.(\d{2})(am|pm)/i);
    if (dotTimeMatch) {
      console.log('Found dot time match:', dotTimeMatch);
      const hour = parseInt(dotTimeMatch[1]);
      const minutes = parseInt(dotTimeMatch[2]);
      const ampm = dotTimeMatch[3].toLowerCase();
      
      console.log('Parsed time:', { hour, minutes, ampm });
      
      // Convert to 24-hour format
      let hour24 = hour;
      if (ampm === 'pm' && hour !== 12) hour24 += 12;
      if (ampm === 'am' && hour === 12) hour24 = 0;
      
      console.log('24-hour format:', hour24);
      
      // Create target date for tomorrow if "tmr" is in text
      const targetDate = new Date(now);
      if (text.toLowerCase().includes('tmr') || text.toLowerCase().includes('tomorrow')) {
        targetDate.setDate(targetDate.getDate() + 1);
      }
      // Set time in local timezone, not UTC
      targetDate.setHours(hour24, minutes, 0, 0);
      
      console.log('Final target date:', targetDate.toISOString());
      
      results = [{
        index: dotTimeMatch.index,
        text: dotTimeMatch[0],
        start: {
          date: () => targetDate,
          knownValues: { 
            year: targetDate.getFullYear(), 
            month: targetDate.getMonth() + 1, 
            day: targetDate.getDate(),
            hour: hour24, 
            minute: minutes 
          }
        }
      }];
    }
  }
  
  // Fallback for day patterns like "29th 5am"
  if (results.length === 0) {
    // More precise regex for day + time patterns (supports both : and . notation)
    const dayTimeMatch = text.match(/(\d{1,2})(st|nd|rd|th)\s+(\d{1,2})([:.:]\d{2})?(am|pm)/i);
    
    if (dayTimeMatch) {
      const day = parseInt(dayTimeMatch[1]);
      const hour = parseInt(dayTimeMatch[3]);
      const ampm = dayTimeMatch[5].toLowerCase();
      const minutes = dayTimeMatch[4] ? parseInt(dayTimeMatch[4].replace(/[:.]/g, '')) : 0;
      
      console.log('Matched day+time:', { day, hour, ampm, minutes });
      
      // Convert to 24-hour format
      let hour24 = hour;
      if (ampm === 'pm' && hour !== 12) hour24 += 12;
      if (ampm === 'am' && hour === 12) hour24 = 0;
      
      console.log('Converted to 24h:', hour24);
      
      // Get current month and year
      const currentMonth = now.getMonth(); // 0-based month
      const currentYear = now.getFullYear();
      
      // Create date object in local time
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
        const currentMonth = now.toLocaleString('en-US', { month: 'long', timeZone: safeTimezone });
        const currentYear = now.getFullYear();
        
        const dateStr = `${currentMonth} ${day}, ${currentYear}`;
        console.log('Parsing day-only pattern:', dateStr);
        
        const fallbackResults = chrono.parse(dateStr, now, { timezone: safeTimezone });
        if (fallbackResults.length > 0) {
          results = fallbackResults;
        }
      }
    }
    
    // Fallback for relative time patterns like "1 minute", "30 min", "50mins"
    if (results.length === 0) {
      const relativeTimeMatch = text.match(/(\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i);
      if (relativeTimeMatch) {
        const amount = parseInt(relativeTimeMatch[1]);
        const unit = relativeTimeMatch[2].toLowerCase();
        
        let minutes = 0;
        if (unit.startsWith('min')) {
          minutes = amount;
        } else if (unit.startsWith('h')) {
          minutes = amount * 60;
        }
        
        const targetDate = new Date(now.getTime() + minutes * 60000);
        console.log('Parsed relative time:', { amount, unit, minutes, targetDate: targetDate.toISOString() });
        
        results = [{
          index: relativeTimeMatch.index,
          text: relativeTimeMatch[0],
          start: {
            date: () => targetDate,
            knownValues: { 
              year: targetDate.getFullYear(), 
              month: targetDate.getMonth() + 1, 
              day: targetDate.getDate(),
              hour: targetDate.getHours(), 
              minute: targetDate.getMinutes() 
            }
          }
        }];
      }
    }
    
    // Fallback for standalone weekdays
    if (results.length === 0) {
      const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const lowerText = text.toLowerCase();
      
      for (const day of weekdays) {
        if (lowerText.includes(day)) {
          const fallbackResults = chrono.parse(`this ${day}`, now, { timezone: safeTimezone });
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
    /\b\d{1,2}([:.:]\d{2})?(am|pm)\b/gi, // standalone times
    /\b\d+\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/gi, // relative time
    /\d{1,2}[.:]?\d{0,2}(am|pm)\s*[-–]\s*\d{1,2}[.:]?\d{0,2}(am|pm)/gi // time ranges
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
    const startDate = event.start.toISOString().split('T')[0].replace(/-/g, '');
    const endDate = new Date(event.start.getTime() + 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0].replace(/-/g, '');
    dates = `${startDate}/${endDate}`;
  } else {
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

function createIcsContent(event, timezone) {
  // Use the same time format as Google Calendar - local time with timezone
  const { error, value } = createEvent({
    title: event.title,
    start: event.allDay ? 
      [event.start.getFullYear(), event.start.getMonth() + 1, event.start.getDate()] :
      [event.start.getFullYear(), event.start.getMonth() + 1, event.start.getDate(), event.start.getHours(), event.start.getMinutes()],
    end: event.allDay ? 
      [event.start.getFullYear(), event.start.getMonth() + 1, event.start.getDate() + 1] :
      [event.end.getFullYear(), event.end.getMonth() + 1, event.end.getDate(), event.end.getHours(), event.end.getMinutes()],
    startInputType: 'local',
    endInputType: 'local',
    startOutputType: 'local',
    endOutputType: 'local'
  });
  
  if (error) throw new Error('Failed to create ICS content');
  return value;
}

async function sendIcsDocument(chatId, icsContent, eventTitle) {
  const token = await getBotToken();
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  
  const fileName = `${eventTitle.replace(/[^a-zA-Z0-9]/g, '_')}.ics`;
  const boundary = '----formdata-' + Math.random().toString(36);
  
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="chat_id"',
    '',
    chatId,
    `--${boundary}`,
    `Content-Disposition: form-data; name="document"; filename="${fileName}"`,
    'Content-Type: text/calendar',
    '',
    icsContent,
    `--${boundary}`,
    'Content-Disposition: form-data; name="caption"',
    '',
    '📅 Tap to add to your calendar',
    `--${boundary}--`
  ].join('\r\n');
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: body
  });
  
  return await response.json();
}





async function handleCommand(message) {
  const { chat, from, text } = message;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const prefId = isGroup ? chat.id.toString() : from.id.toString();
  const parts = text.split(' ');
  const command = parts[0];
  
  // Check if user is admin for group settings
  const isAdmin = async () => {
    if (!isGroup) return true; // Always admin in private chat
    
    // Check if user is a bot admin
    const botAdmins = await getBotAdmins(prefId);
    if (botAdmins.includes(from.id.toString())) return true;
    
    try {
      const token = await getBotToken();
      const response = await fetch(`https://api.telegram.org/bot${token}/getChatMember?chat_id=${chat.id}&user_id=${from.id}`);
      const data = await response.json();
      return ['creator', 'administrator'].includes(data.result?.status);
    } catch {
      return false;
    }
  };
  
  switch (command) {
    case '/start':
    case '/help':
      const helpText = isGroup ? 
        `🤖 <b>Telegram Scheduler Bot - Group Mode</b>\n\n` +
        `I help create calendar events from natural language in group chats!\n\n` +
        `<b>Examples:</b>\n` +
        `• "Team meeting tmr 3pm"\n` +
        `• "Project sync next Friday 10:30am"\n` +
        `• "Standup Monday 9am"\n\n` +
        `<b>Group Commands (Admin Only):</b>\n` +
        `/tz &lt;timezone&gt; - Set group timezone\n` +
        `/duration &lt;minutes&gt; - Set group default duration\n` +
        `/admin - Reply to a message to promote user as bot admin\n` +
        `/blacklist &lt;word&gt; - Add/remove words from blacklist\n` +
        `/whitelist &lt;word&gt; - Add/remove words from whitelist\n` +
        `/showblacklist - Show blacklisted words\n` +
        `/showwhitelist - Show whitelisted words\n\n` +
        `<b>Anyone can:</b> Create events by mentioning dates/times\n` +
        `Try: <i>"Meeting tomorrow 2pm"</i> 🚀` :
        `🤖 <b>Welcome to Telegram Scheduler Bot!</b>\n\n` +
        `I help you create calendar events from natural language! Just send me messages with dates and times.\n\n` +
        `<b>Examples:</b>\n` +
        `• "Team meeting tmr 3pm"\n` +
        `• "Doctor appointment next Friday 10:30am"\n` +
        `• "Project sync 25 Oct 2pm"\n\n` +
        `<b>Commands:</b>\n` +
        `/tz &lt;timezone&gt; - Set your timezone (default: Singapore)\n` +
        `/duration &lt;minutes&gt; - Set default event duration (default: 60min)\n` +
        `/blacklist &lt;word&gt; - Add/remove words from blacklist\n` +
        `/whitelist &lt;word&gt; - Add/remove words from whitelist\n` +
        `/showblacklist - Show blacklisted words\n` +
        `/showwhitelist - Show whitelisted words\n` +
        `/help - Show this help\n\n` +
        `Try sending me: <i>"Meeting tomorrow 2pm"</i> 🚀`;
      
      await sendTelegramMessage(chat.id, helpText);
      break;
      
    case '/tz':
      if (parts.length < 2) {
        const scope = isGroup ? 'group' : 'your';
        await sendTelegramMessage(chat.id, 
          `Usage: /tz <timezone>\nSets ${scope} timezone\n\n` +
          `<b>Examples:</b>\n` +
          `• /tz Asia/Singapore (Singapore Time)\n` +
          `• /tz America/New_York (Eastern Time)\n` +
          `• /tz America/Los_Angeles (Pacific Time)\n` +
          `• /tz Europe/London (GMT/BST)\n` +
          `• /tz Australia/Sydney (AEST/AEDT)`
        );
        return;
      }
      
      if (isGroup && !(await isAdmin())) {
        await sendTelegramMessage(chat.id, '❌ Only group admins can change timezone settings');
        return;
      }
      
      const timezone = parts.slice(1).join(' ');
      
      if (!isValidTimezone(timezone)) {
        await sendTelegramMessage(chat.id, 
          `❌ Invalid timezone: "${timezone}"\n\n` +
          `<b>Valid timezone examples:</b>\n` +
          `• Asia/Singapore (Singapore Time)\n` +
          `• America/New_York (Eastern Time)\n` +
          `• America/Los_Angeles (Pacific Time)\n` +
          `• America/Chicago (Central Time)\n` +
          `• Europe/London (GMT/BST)\n` +
          `• Europe/Paris (CET/CEST)\n` +
          `• Asia/Tokyo (JST)\n` +
          `• Australia/Sydney (AEST/AEDT)\n\n` +
          `Use format: Continent/City`
        );
        return;
      }
      
      const prefs = await getUserPrefs(prefId);
      prefs.timezone = timezone;
      await saveUserPrefs(prefId, prefs);
      
      const scopeMsg = isGroup ? 'Group' : 'Your';
      await sendTelegramMessage(chat.id, `✅ ${scopeMsg} timezone set to ${timezone}`);
      break;
      
    case '/duration':
      if (parts.length < 2 || isNaN(parts[1])) {
        const scope = isGroup ? 'group' : 'your';
        await sendTelegramMessage(chat.id, `Usage: /duration 60\nSets ${scope} default event duration`);
        return;
      }
      
      if (isGroup && !(await isAdmin())) {
        await sendTelegramMessage(chat.id, '❌ Only group admins can change duration settings');
        return;
      }
      
      const duration = parseInt(parts[1]);
      const userPrefs = await getUserPrefs(prefId);
      userPrefs.duration_min = duration;
      await saveUserPrefs(prefId, userPrefs);
      
      const durationScopeMsg = isGroup ? 'Group' : 'Your';
      await sendTelegramMessage(chat.id, `✅ ${durationScopeMsg} default duration set to ${duration} minutes`);
      break;
      
    case '/admin':
      if (!isGroup) {
        await sendTelegramMessage(chat.id, '❌ Admin command only works in groups');
        return;
      }
      
      if (!(await isAdmin())) {
        await sendTelegramMessage(chat.id, '❌ Only group admins can promote bot admins');
        return;
      }
      
      if (parts.length < 2) {
        await sendTelegramMessage(chat.id, 'Usage: /admin @username or reply to a message');
        return;
      }
      
      let targetUserId;
      if (message.reply_to_message) {
        targetUserId = message.reply_to_message.from.id.toString();
      } else {
        await sendTelegramMessage(chat.id, 'Please reply to a user\'s message to promote them as bot admin');
        return;
      }
      
      await addBotAdmin(prefId, targetUserId);
      await sendTelegramMessage(chat.id, '✅ User promoted to bot admin for this group');
      break;
      
    case '/blacklist':
      if (parts.length < 2) {
        const scope = isGroup ? 'group' : 'your';
        const blacklist = await getUserPrefs(prefId);
        await sendTelegramMessage(chat.id, `Current ${scope} blacklist: ${blacklist.blacklist.join(', ')}\n\nUsage: /blacklist <word> to add/remove`);
        return;
      }
      
      if (isGroup && !(await isAdmin())) {
        await sendTelegramMessage(chat.id, '❌ Only group admins can manage blacklist');
        return;
      }
      
      const word = parts[1].toLowerCase();
      const blacklistPrefs = await getUserPrefs(prefId);
      
      if (blacklistPrefs.blacklist.includes(word)) {
        blacklistPrefs.blacklist = blacklistPrefs.blacklist.filter(w => w !== word);
        await saveUserPrefs(prefId, blacklistPrefs);
        await sendTelegramMessage(chat.id, `✅ Removed "${word}" from blacklist`);
      } else {
        blacklistPrefs.blacklist.push(word);
        await saveUserPrefs(prefId, blacklistPrefs);
        await sendTelegramMessage(chat.id, `✅ Added "${word}" to blacklist`);
      }
      break;
      
    case '/whitelist':
      if (parts.length < 2) {
        const scope = isGroup ? 'group' : 'your';
        const whitelist = await getUserPrefs(prefId);
        await sendTelegramMessage(chat.id, `Current ${scope} whitelist: ${whitelist.whitelist.join(', ') || 'None'}\n\nUsage: /whitelist <word> to add/remove`);
        return;
      }
      
      if (isGroup && !(await isAdmin())) {
        await sendTelegramMessage(chat.id, '❌ Only group admins can manage whitelist');
        return;
      }
      
      const whiteWord = parts[1].toLowerCase();
      const whitelistPrefs = await getUserPrefs(prefId);
      
      if (whitelistPrefs.whitelist.includes(whiteWord)) {
        whitelistPrefs.whitelist = whitelistPrefs.whitelist.filter(w => w !== whiteWord);
        await saveUserPrefs(prefId, whitelistPrefs);
        await sendTelegramMessage(chat.id, `✅ Removed "${whiteWord}" from whitelist`);
      } else {
        whitelistPrefs.whitelist.push(whiteWord);
        await saveUserPrefs(prefId, whitelistPrefs);
        await sendTelegramMessage(chat.id, `✅ Added "${whiteWord}" to whitelist`);
      }
      break;
      
    case '/showblacklist':
      const blacklistData = await getUserPrefs(prefId);
      const scope1 = isGroup ? 'Group' : 'Your';
      await sendTelegramMessage(chat.id, `${scope1} blacklist: ${blacklistData.blacklist.join(', ')}`);
      break;
      
    case '/showwhitelist':
      const whitelistData = await getUserPrefs(prefId);
      const scope2 = isGroup ? 'Group' : 'Your';
      await sendTelegramMessage(chat.id, `${scope2} whitelist: ${whitelistData.whitelist.join(', ') || 'None'}`);
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
  
  // Support both private chats and groups
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const prefId = isGroup ? chat.id.toString() : from.id.toString();
  const prefs = await getUserPrefs(prefId);
  
  // Check blacklist/whitelist logic
  const lowerText = text.toLowerCase();
  const hasBlacklistedWord = prefs.blacklist.some(word => lowerText.includes(word));
  const hasWhitelistedWord = prefs.whitelist.length > 0 && prefs.whitelist.some(word => lowerText.includes(word));
  
  // If word is blacklisted and not whitelisted, skip
  if (hasBlacklistedWord && !hasWhitelistedWord) return;
  
  const dateMatch = parseDateTime(text, prefs.timezone);
  if (!dateMatch) return;
  
  const title = extractTitle(text, dateMatch);
  let start = dateMatch.start.date();
  
  // Fix: Use the parsed values directly instead of relying on timezone conversion
  if (dateMatch.start.knownValues.hour !== undefined) {
    const targetHour = dateMatch.start.knownValues.hour;
    const targetMinute = dateMatch.start.knownValues.minute || 0;
    const targetDay = dateMatch.start.knownValues.day || start.getDate();
    const targetMonth = (dateMatch.start.knownValues.month || start.getMonth() + 1) - 1;
    const targetYear = dateMatch.start.knownValues.year || start.getFullYear();
    
    // Create date in local time - this represents the user's intended time
    start = new Date(targetYear, targetMonth, targetDay, targetHour, targetMinute);
    console.log('Created local time date:', start.toISOString());
  }
  
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
    const safeTimezone = isValidTimezone(prefs.timezone) ? prefs.timezone : 'Asia/Singapore';
    
    console.log('Event start time:', start.toISOString());
    console.log('User timezone:', prefs.timezone);
    console.log('Safe timezone:', safeTimezone);
    
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
        minute: '2-digit',
        hour12: true
      }) + ` (${prefs.duration_min}min)`;
      
      console.log('Formatted time:', whenText);
    }
    
    // Create calendar URLs and ICS content
    const googleUrl = createGoogleCalendarUrl(event, safeTimezone);
    const icsContent = createIcsContent(event, safeTimezone);
    
    const createdBy = isGroup ? `\n<b>Created by:</b> ${from.first_name || from.username || 'Unknown'}` : '';
    
    // Send main message with Google Calendar option
    await sendTelegramMessage(chat.id,
      `📅 <b>Event detected:</b>\n` +
      `<b>Title:</b> ${title}\n` +
      `<b>When:</b> ${whenText}\n` +
      `<b>Timezone:</b> ${prefs.timezone}${createdBy}`,
      {
        inline_keyboard: [
          [
            { text: '🌐 Google Calendar', url: googleUrl }
          ]
        ]
      }
    );
    
    // Send ICS file as document
    await sendIcsDocument(chat.id, icsContent, title);
  } catch (error) {
    console.error('Error creating event:', error);
    await sendTelegramMessage(chat.id, '❌ Sorry, failed to create calendar event.');
  }
}

export const handler = async (event) => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    const body = JSON.parse(event.body);
    console.log('Parsed body:', JSON.stringify(body, null, 2));
    console.log('Lambda v2.0 - with ICS document support');
    
    if (body.message) {
      console.log('Processing message:', body.message);
      await handleMessage(body.message);
    } else {
      console.log('No message in body');
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