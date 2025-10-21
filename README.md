# Telegram Scheduler Bot

A serverless Telegram bot that parses natural language date/time phrases and creates calendar events. Built with AWS Lambda, API Gateway, and modern JavaScript.

## 🚀 Features

- 🗓️ **Natural Language Parsing** - "tmr 3pm", "next Friday 10:30am", "Meeting Friday"
- 📅 **Multiple Calendar Options** - Download .ics files or add directly to Google Calendar
- ⚡ **Serverless Architecture** - AWS Lambda + API Gateway + S3 + DynamoDB
- 🌍 **Timezone Support** - Configurable per user (default: Asia/Singapore)
- ⚙️ **User Preferences** - Custom timezone and event duration settings
- 📱 **All-Day Events** - Automatically detects date-only mentions
- 🔒 **Secure** - Bot token stored in AWS Secrets Manager

## 🏗️ Architecture

### System Overview
```
User Message → Telegram → API Gateway → Lambda Function → AWS Services
                                            ├── S3 (ICS files)
                                            ├── DynamoDB (user data)
                                            └── Secrets Manager (bot token)
```

### Tech Stack

**Backend:**
- **Runtime:** Node.js 20.x with ES Modules
- **Compute:** AWS Lambda (serverless)
- **API:** AWS API Gateway (HTTP)
- **Storage:** Amazon S3 (calendar files)
- **Database:** Amazon DynamoDB (user preferences)
- **Security:** AWS Secrets Manager (bot token)

**Infrastructure:**
- **IaC:** AWS CDK (TypeScript)
- **Deployment:** CloudFormation
- **Monitoring:** CloudWatch Logs

**Key Libraries:**
- **chrono-node** - Natural language date parsing
- **ics** - Calendar file generation
- **@aws-sdk/client-*** - AWS service integration

## 🔄 How It Works

### Complete Message Processing Flow

#### **Step 1: User Interaction**
When a user types "Meeting Friday 2pm" in the Telegram chat, their message is first sent to Telegram's servers. The Telegram client app encrypts and transmits the message through Telegram's infrastructure, where it gets processed and prepared for delivery to the bot.

```
User types: "Meeting Friday 2pm"
↓
Telegram Client → Telegram Servers
```

#### **Step 2: Telegram Webhook**
Telegram's servers recognize that this message is intended for the bot and immediately make an HTTP POST request to the configured webhook URL. This webhook URL points directly to the AWS API Gateway endpoint. The POST request contains all the message details including the user information, chat context, and the actual message text in a structured JSON format.

```
Telegram Server → POST Request
↓
URL: https://your-api-gateway.amazonaws.com/prod/webhook
Headers: {
  "Content-Type": "application/json",
  "X-Telegram-Bot-Api-Secret-Token": "..."
}
Body: {
  "update_id": 123456789,
  "message": {
    "message_id": 1234,
    "from": {
      "id": 987654321,
      "first_name": "Bryan",
      "username": "bryantan65"
    },
    "chat": {
      "id": 987654321,
      "type": "private"
    },
    "date": 1729507200,
    "text": "Meeting Friday 2pm"
  }
}
```

#### **Step 3: API Gateway Processing**
AWS API Gateway receives the HTTP POST request from Telegram and acts as the entry point to the serverless application. It first validates that this is a legitimate POST request to the correct `/webhook` route, then transforms the raw HTTP request into a Lambda event object that includes the original request data plus additional AWS context information. Finally, it synchronously invokes your Lambda function, meaning it waits for the function to complete before responding back to Telegram.

```
API Gateway receives HTTP POST
↓
1. Validates request method (POST)
2. Checks route (/webhook)
3. Transforms HTTP request → Lambda Event
4. Adds request context metadata
5. Invokes Lambda function synchronously
```

**Lambda Event Structure:**
```javascript
{
  "httpMethod": "POST",
  "path": "/webhook",
  "headers": {
    "Content-Type": "application/json",
    "User-Agent": "TelegramBot/1.0"
  },
  "body": "{\"message\":{\"text\":\"Meeting Friday 2pm\"}}",
  "requestContext": {
    "requestId": "abc-123-def",
    "stage": "prod",
    "apiId": "u9nmuerhc9"
  }
}
```

#### **Step 4: Lambda Function Execution**
The Lambda function now springs into action. AWS Lambda loads the `index.mjs` file and calls the exported `handler` function, passing in the event object created by API Gateway. This is where the bot's intelligence begins.

**4.1 Handler Invocation**
The Lambda handler first parses the JSON body from the API Gateway event to extract the Telegram message data. It then routes the message to the appropriate handler function based on whether it's a command or a regular message.

```javascript
export const handler = async (event) => {
  // AWS Lambda starts here
  const body = JSON.parse(event.body);
  
  if (body.message) {
    await handleMessage(body.message);
  }
}
```

**4.2 User Preferences Retrieval**
Before processing the message, the Lambda function queries DynamoDB to retrieve the user's personal preferences such as their timezone and default event duration. If this is a new user, it falls back to default settings (Asia/Singapore timezone, 60-minute duration).

```javascript
// DynamoDB Query
const getUserPrefs = async (userId) => {
  const command = new GetItemCommand({
    TableName: process.env.USERS_TABLE,
    Key: { user_id: { S: "987654321" } }
  });
  
  const response = await dynamodb.send(command);
  // Returns: { timezone: "Asia/Singapore", duration_min: 60 }
}
```

**4.3 Natural Language Processing**
This is where the magic happens. The chrono-node library analyzes the message text "Meeting Friday 2pm" and intelligently extracts the date and time information. It understands natural language patterns and converts them into structured date objects, taking into account the user's timezone.

```javascript
// chrono-node parsing
const dateMatch = chrono.parse("Meeting Friday 2pm", new Date(), {
  timezone: "Asia/Singapore"
});

// Result:
{
  index: 8,           // Position of "Friday" in text
  text: "Friday 2pm", // Matched text
  start: {
    date: () => new Date(2024, 9, 25, 14, 0), // Oct 25, 2024 2:00 PM
    knownValues: { hour: 14, minute: 0, day: 25, month: 10 }
  }
}
```

**4.4 Title Extraction**
The function then extracts the event title by analyzing the text before and after the detected date/time phrase. In "Meeting Friday 2pm", it identifies "Meeting" as the title by taking the text that appears before "Friday 2pm".

```javascript
function extractTitle(text, dateMatch) {
  const beforeDate = text.substring(0, dateMatch.index); // "Meeting "
  const afterDate = text.substring(dateMatch.index + dateMatch.text.length); // ""
  
  return beforeDate.trim() || afterDate.trim() || "Event"; // "Meeting"
}
```

**4.5 Event Object Creation**
With all the parsed information, the function creates a structured event object containing the title, start time, end time (calculated using the user's default duration), and whether it's an all-day event.

```javascript
const event = {
  title: "Meeting",
  start: new Date(2024, 9, 25, 14, 0), // Oct 25, 2024 2:00 PM
  end: new Date(2024, 9, 25, 15, 0),   // Oct 25, 2024 3:00 PM
  allDay: false
};
```

#### **Step 5: Calendar File Generation**

**5.1 ICS File Creation**
```javascript
const icsEvent = {
  title: "Meeting",
  start: [2024, 10, 25, 14, 0], // Year, Month, Day, Hour, Minute
  end: [2024, 10, 25, 15, 0]
};

const { error, value } = createEvent(icsEvent);
// value contains:
/*
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Your Bot//Your Bot//EN
BEGIN:VEVENT
UID:abc123@yourbot.com
DTSTAMP:20241021T150000Z
DTSTART:20241025T140000Z
DTEND:20241025T150000Z
SUMMARY:Meeting
END:VEVENT
END:VCALENDAR
*/
```

**5.2 S3 Upload**
```javascript
const fileName = `event-${Date.now()}.ics`; // event-1729507200000.ics

const command = new PutObjectCommand({
  Bucket: "tg-calendar-ics-123456-us-east-1",
  Key: fileName,
  Body: value, // ICS file content
  ContentType: "text/calendar"
});

await s3.send(command);
```

**5.3 Signed URL Generation**
```javascript
const signedUrl = await getSignedUrl(s3, new GetObjectCommand({
  Bucket: "tg-calendar-ics-123456-us-east-1",
  Key: fileName
}), { expiresIn: 3600 }); // 1 hour expiry

// Result: https://tg-calendar-ics-123456-us-east-1.s3.amazonaws.com/event-1729507200000.ics?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...
```

**5.4 Google Calendar URL**
```javascript
function createGoogleCalendarUrl(event, timezone) {
  const startTime = event.start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const endTime = event.end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  
  const params = new URLSearchParams({
    text: "Meeting",
    dates: `${startTime}/${endTime}`, // 20241025T140000Z/20241025T150000Z
    ctz: "Asia/Singapore"
  });
  
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&${params.toString()}`;
}
```

#### **Step 6: Response Generation**

**6.1 Bot Token Retrieval**
```javascript
const getBotToken = async () => {
  const command = new GetSecretValueCommand({
    SecretId: "telegram/bot"
  });
  
  const response = await secrets.send(command);
  const secret = JSON.parse(response.SecretString);
  return secret.BOT_TOKEN; // "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789"
};
```

**6.2 Telegram API Call**
```javascript
const sendTelegramMessage = async (chatId, text, replyMarkup) => {
  const token = await getBotToken();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const body = {
    chat_id: 987654321,
    text: "📅 Event detected:\nTitle: Meeting\nWhen: Fri, 25 Oct, 2:00 PM (60min)\nTimezone: Asia/Singapore",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "📥 Download ICS", url: signedUrl },
        { text: "📅 Google Calendar", url: googleUrl }
      ]]
    }
  };
  
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
};
```

#### **Step 7: Response Chain**
```
Lambda → API Gateway → Telegram → User

Lambda returns:
{
  statusCode: 200,
  body: JSON.stringify({ ok: true })
}

API Gateway converts to:
HTTP/1.1 200 OK
Content-Type: application/json
{"ok": true}

Telegram receives 200 OK → Marks webhook as successful
User sees bot reply with calendar buttons
```

## 🏗️ AWS Stack Deep Dive

### **AWS Lambda (Compute)**

**Function Configuration:**
```yaml
Runtime: Node.js 20.x
Architecture: x86_64
Memory: 128 MB (default)
Timeout: 30 seconds
Handler: index.handler
Environment Variables:
  - BUCKET: tg-calendar-ics-123456-us-east-1
  - USERS_TABLE: tg_users
  - SECRET_ID: telegram/bot
```

**Execution Environment:**
- **Cold Start:** ~500ms (first request)
- **Warm Start:** ~10ms (subsequent requests)
- **Concurrent Executions:** Up to 1000 (default limit)
- **Auto Scaling:** Automatic based on incoming requests

**IAM Permissions:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::tg-calendar-ics-*/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/tg_users"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:*:*:secret:telegram/bot-*"
    }
  ]
}
```

### **API Gateway (HTTP Endpoint)**

**Configuration:**
```yaml
Type: HTTP API (v2)
Protocol: HTTPS
Stage: prod (default)
CORS: Enabled
Throttling: 10,000 requests/second
Integration: Lambda Proxy
```

**Request Processing:**
1. **TLS Termination:** HTTPS → HTTP
2. **Request Validation:** Method, headers, body size
3. **Rate Limiting:** Per-client throttling
4. **Lambda Integration:** Synchronous invocation
5. **Response Transformation:** Lambda response → HTTP

**Monitoring:**
- **4XX Errors:** Client errors (bad requests)
- **5XX Errors:** Server errors (Lambda failures)
- **Latency:** End-to-end request time
- **Cache Hit/Miss:** (if caching enabled)

### **Amazon S3 (File Storage)**

**Bucket Configuration:**
```yaml
Bucket Name: tg-calendar-ics-{account}-{region}
Region: us-east-1
Versioning: Disabled
Encryption: AES-256 (default)
Public Access: Blocked
Lifecycle Policy:
  - Delete objects after 7 days
```

**File Operations:**
```javascript
// Upload
PutObject: {
  Bucket: "tg-calendar-ics-123456-us-east-1",
  Key: "event-1729507200000.ics",
  Body: "BEGIN:VCALENDAR...",
  ContentType: "text/calendar",
  ServerSideEncryption: "AES256"
}

// Signed URL Generation
getSignedUrl(s3, GetObjectCommand, {
  expiresIn: 3600, // 1 hour
  signatureVersion: "v4"
});
```

**Security:**
- **Pre-signed URLs:** Temporary access (1 hour)
- **IAM Policies:** Lambda-only access
- **Encryption:** At rest and in transit
- **Access Logging:** CloudTrail integration

### **DynamoDB (User Data)**

**Table Schema:**
```yaml
Table Name: tg_users
Partition Key: user_id (String)
Billing Mode: On-Demand
Encryption: AWS Managed Keys
Point-in-time Recovery: Disabled
Streams: Disabled
```

**Data Operations:**
```javascript
// Read User Preferences
GetItem: {
  TableName: "tg_users",
  Key: {
    user_id: { S: "987654321" }
  },
  ConsistentRead: false // Eventually consistent
}

// Write User Preferences
PutItem: {
  TableName: "tg_users",
  Item: {
    user_id: { S: "987654321" },
    timezone: { S: "Asia/Singapore" },
    duration_min: { N: "60" }
  }
}
```

**Performance:**
- **Read Capacity:** Auto-scaling (1-40,000 RCU)
- **Write Capacity:** Auto-scaling (1-40,000 WCU)
- **Latency:** Single-digit milliseconds
- **Availability:** 99.99% SLA

### **Secrets Manager (Security)**

**Secret Configuration:**
```yaml
Secret Name: telegram/bot
Description: "Telegram bot token"
Encryption: AWS KMS (default key)
Rotation: Manual
Replica Regions: None
```

**Secret Structure:**
```json
{
  "BOT_TOKEN": "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789"
}
```

**Access Pattern:**
```javascript
// Lambda retrieves secret
const command = new GetSecretValueCommand({
  SecretId: "telegram/bot",
  VersionStage: "AWSCURRENT"
});

const response = await secretsManager.send(command);
const secret = JSON.parse(response.SecretString);
```

**Security Features:**
- **Encryption:** KMS encryption at rest
- **Access Control:** IAM policies
- **Audit Trail:** CloudTrail logging
- **Rotation:** Automatic rotation support

### **CloudWatch (Monitoring)**

**Log Groups:**
```
/aws/lambda/TelegramSchedulerBotStack-TelegramBotFunction-ABC123
/aws/apigateway/TelegramSchedulerBotStack-TelegramBotApi-DEF456
```

**Key Metrics:**
- **Lambda Duration:** Function execution time
- **Lambda Errors:** Function failures
- **API Gateway Latency:** End-to-end request time
- **DynamoDB Throttles:** Capacity exceeded events
- **S3 Requests:** Object operations

**Alarms & Notifications:**
```yaml
Lambda Error Rate > 5%: SNS notification
API Gateway 5XX > 10: SNS notification
DynamoDB Throttles > 0: SNS notification
```

### **Cost Breakdown (Monthly)**

**Assumptions:** 1000 messages/month

```yaml
Lambda:
  Requests: 1000 × $0.0000002 = $0.0002
  Duration: 1000 × 200ms × $0.0000166667 = $0.0033
  
API Gateway:
  Requests: 1000 × $0.0000035 = $0.0035
  
DynamoDB:
  Storage: 1KB × 1000 users × $0.25/GB = $0.0002
  Reads: 1000 × $0.25/million = $0.0003
  Writes: 100 × $1.25/million = $0.0001
  
S3:
  Storage: 1KB × 1000 files × $0.023/GB = $0.00002
  Requests: 1000 PUT + 1000 GET × $0.0004/1000 = $0.0008
  
Secrets Manager:
  Secret: 1 × $0.40 = $0.40
  API Calls: 1000 × $0.05/10000 = $0.005
  
Total: ~$0.41/month for 1000 messages
```

## 📋 Setup Guide

### Prerequisites

- **AWS Account** with CLI configured
- **Node.js 18+** and npm
- **AWS CDK CLI:** `npm install -g aws-cdk`
- **Telegram Account** for bot creation

### 1. Project Setup

```bash
# Clone repository
git clone https://github.com/yourusername/telegram-scheduler-bot.git
cd telegram-scheduler-bot

# Install all dependencies
npm run install-all
```

### 2. Create Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow prompts
3. Choose bot name: `Your Scheduler Bot`
4. Choose username: `your_scheduler_bot` (must end with 'bot')
5. **Save the bot token** - you'll need it later

### 3. Deploy AWS Infrastructure

```bash
cd cdk

# First-time setup (creates CDK bootstrap stack)
cdk bootstrap

# Deploy the bot infrastructure
cdk deploy
```

**Save the webhook URL** from the deployment output:
```
TelegramSchedulerBotStack.WebhookUrl = https://abc123.execute-api.region.amazonaws.com/prod/webhook
```

### 4. Configure Bot Token

```bash
# Store bot token securely in AWS Secrets Manager
aws secretsmanager put-secret-value \
  --secret-id telegram/bot \
  --secret-string '{"BOT_TOKEN":"1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789"}'
```

### 5. Set Telegram Webhook

```bash
# Connect Telegram to your AWS endpoint
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<YOUR_WEBHOOK_URL>"}'
```

**Success response:** `{"ok":true,"result":true,"description":"Webhook was set"}`

## 📱 Usage

### Bot Commands

| Command | Description | Example |
|---------|-------------|----------|
| `/start` or `/help` | Show welcome message and usage | `/help` |
| `/tz <timezone>` | Set your timezone | `/tz America/New_York` |
| `/duration <minutes>` | Set default event duration | `/duration 90` |

### Creating Events

**Timed Events:**
- "Team meeting tmr 3pm" → Creates 1-hour meeting tomorrow at 3 PM
- "Doctor appointment next Friday 10:30am" → Creates appointment next Friday
- "Call with client Monday 9am" → Creates call next Monday

**All-Day Events:**
- "Meeting Friday" → Creates all-day event this Friday
- "Conference next week" → Creates all-day event (if date detected)
- "Holiday December 25" → Creates all-day holiday event

### Response Format

The bot replies with:
```
📅 Event detected:
Title: Team meeting
When: Fri, 25 Oct, 3:00 PM (60min)
Timezone: Asia/Singapore

[📥 Download ICS] [📅 Google Calendar]
```

## 🛠️ Development

### Project Structure

```
telegram-scheduler-bot/
├── lambda/                    # Lambda function code
│   ├── index.mjs             # Main bot logic
│   └── package.json          # Lambda dependencies
├── cdk/                      # Infrastructure as Code
│   ├── bin/                  # CDK app entry point
│   ├── lib/                  # Stack definitions
│   ├── package.json          # CDK dependencies
│   └── tsconfig.json         # TypeScript config
├── .env.example              # Environment template
├── .gitignore               # Git ignore rules
├── package.json             # Root project config
└── README.md                # This file
```

### Local Development

1. **Environment Setup:**
   ```bash
   cp .env.example .env
   # Add your bot token to .env for local testing
   ```

2. **Code Changes:**
   - Edit `lambda/index.mjs` for bot logic
   - Edit `cdk/lib/telegram-scheduler-bot-stack.ts` for infrastructure

3. **Deploy Changes:**
   ```bash
   cd cdk
   cdk deploy
   ```

### Testing

**Manual Testing:**
1. Send messages to your bot on Telegram
2. Check AWS CloudWatch Logs for debugging
3. Verify .ics files in S3 bucket

**Webhook Testing:**
```bash
# Check webhook status
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

## 🔧 Configuration

### Environment Variables (Lambda)

| Variable | Description | Example |
|----------|-------------|----------|
| `BUCKET` | S3 bucket for .ics files | `tg-calendar-ics-123456-us-east-1` |
| `USERS_TABLE` | DynamoDB table name | `tg_users` |
| `SECRET_ID` | Secrets Manager secret ID | `telegram/bot` |
| `AWS_REGION` | AWS region (auto-set) | `us-east-1` |

### User Data Model (DynamoDB)

```json
{
  "user_id": "123456789",
  "timezone": "Asia/Singapore",
  "duration_min": 60
}
```

## 🚀 Deployment

### Production Deployment

```bash
# Deploy to production
cd cdk
cdk deploy --profile production
```

### Multi-Environment Setup

```bash
# Deploy to different environments
cdk deploy --context environment=staging
cdk deploy --context environment=production
```

### Rollback

```bash
# Rollback to previous version
cdk deploy --rollback
```

## 🔍 Monitoring

### CloudWatch Logs

```bash
# View Lambda logs
aws logs tail /aws/lambda/TelegramSchedulerBotStack-TelegramBotFunction --follow
```

### Metrics to Monitor

- **Lambda Invocations** - Number of messages processed
- **Lambda Errors** - Failed message processing
- **Lambda Duration** - Response time
- **API Gateway 4xx/5xx** - Client/server errors
- **DynamoDB Throttles** - Database performance

## 🧹 Cleanup

### Remove All Resources

```bash
cd cdk
cdk destroy
```

**Note:** This will delete:
- Lambda function
- API Gateway
- DynamoDB table (and all user data)
- S3 bucket (and all .ics files)
- Secrets Manager secret

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🆘 Troubleshooting

### Common Issues

**Bot not responding:**
1. Check webhook URL is set correctly
2. Verify bot token in Secrets Manager
3. Check Lambda function logs in CloudWatch

**Calendar events showing wrong time:**
1. Set correct timezone: `/tz Your/Timezone`
2. Verify timezone format (use standard IANA names)

**Deployment fails:**
1. Ensure AWS CLI is configured: `aws sts get-caller-identity`
2. Check CDK bootstrap: `cdk bootstrap`
3. Verify permissions for Lambda, S3, DynamoDB

### Getting Help

- **AWS CDK Issues:** [CDK GitHub](https://github.com/aws/aws-cdk)
- **Telegram Bot API:** [Bot API Documentation](https://core.telegram.org/bots/api)
- **Project Issues:** [GitHub Issues](https://github.com/yourusername/telegram-scheduler-bot/issues)

---

**Built with ❤️ using AWS Serverless Technologies**