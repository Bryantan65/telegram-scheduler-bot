# Telegram Scheduler Bot

A serverless Telegram bot that parses natural language date/time phrases and creates calendar events (.ics files).

## Features

- 🗓️ Natural language date/time parsing ("tmr 3pm", "next Friday 10:30am")
- 📅 Generates .ics calendar files compatible with Google, Apple, Outlook
- ⚡ Serverless AWS architecture (Lambda + API Gateway + S3 + DynamoDB)
- 🌍 Timezone support (default: Asia/Singapore)
- ⚙️ User preferences (timezone, default duration)

## Setup

### Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js 18+ and npm
- AWS CDK CLI (`npm install -g aws-cdk`)

### 1. Clone and Install

```bash
git clone <your-repo>
cd telegram-scheduler-bot
npm install
cd lambda && npm install
cd ../cdk && npm install
```

### 2. Create Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Create new bot with `/newbot`
3. Save the bot token

### 3. Deploy Infrastructure

```bash
cd cdk
cdk bootstrap  # First time only
cdk deploy
```

Note the webhook URL from the output.

### 4. Configure Bot Token

```bash
aws secretsmanager put-secret-value \
  --secret-id telegram/bot \
  --secret-string '{"BOT_TOKEN":"YOUR_BOT_TOKEN_HERE"}'
```

### 5. Set Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<YOUR_WEBHOOK_URL>"}'
```

## Usage

### Commands

- `/help` - Show help message
- `/tz <timezone>` - Set your timezone (e.g., `/tz America/New_York`)
- `/duration <minutes>` - Set default event duration (e.g., `/duration 90`)

### Creating Events

Send messages with date/time phrases:

- "Team meeting tmr 3pm"
- "Doctor appointment next Friday 10:30am"
- "Project sync 25 Oct 2pm"
- "Call with client Monday 9am"

The bot will detect the date/time and reply with a calendar event link.

## Architecture

```
Telegram → API Gateway → Lambda → S3 (ICS files)
                              → DynamoDB (user prefs)
                              → Secrets Manager (bot token)
```

## Development

### Local Testing

1. Copy `.env.example` to `.env`
2. Add your bot token to `.env`
3. Use tools like ngrok for local webhook testing

### Deployment

```bash
cd cdk
npm run deploy
```

### Cleanup

```bash
cd cdk
npm run destroy
```

## License

MIT