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

### System Flow
```
User Message → Telegram → API Gateway → Lambda Function → AWS Services
                                            ├── S3 (ICS files)
                                            ├── DynamoDB (user data)
                                            └── Secrets Manager (bot token)
```

### How It Works
1. **User sends message** to Telegram bot (e.g., "Meeting 29th 5am")
2. **Telegram forwards** message to AWS API Gateway webhook
3. **API Gateway triggers** Lambda function with message data
4. **Lambda function:**
   - Retrieves bot token from Secrets Manager
   - Gets user preferences from DynamoDB
   - Parses date/time using chrono-node library
   - Creates .ics calendar file and uploads to S3
   - Generates Google Calendar URL
   - Sends response back to user via Telegram API

### AWS Components
- **Lambda Function:** Serverless compute running Node.js bot logic
- **API Gateway:** HTTP endpoint that receives Telegram webhooks
- **S3 Bucket:** Stores generated .ics calendar files (auto-deleted after 7 days)
- **DynamoDB:** NoSQL database storing user preferences (timezone, duration)
- **Secrets Manager:** Securely stores Telegram bot token
- **CDK:** Infrastructure as Code for deploying all AWS resources

### Why DynamoDB?

DynamoDB was chosen as the database for this Telegram bot because it's the **perfect fit for serverless applications**:

**Simple Data Model:**
- Only storing user preferences: `user_id`, `timezone`, `duration_min`
- No complex relationships or joins needed
- Key-value lookups by user ID

**Serverless-First Design:**
- **No server management** - fully managed by AWS
- **Auto-scaling** - handles traffic spikes automatically
- **Pay-per-use** - only charged for actual reads/writes
- **Single-digit millisecond latency** for user preference lookups

**Cost Efficiency:**
```
For 1000 users with occasional preference updates:
- Storage: 1KB × 1000 users = $0.0002/month
- Reads: 1000 × $0.25/million = $0.0003/month
- Writes: 100 × $1.25/million = $0.0001/month
Total: ~$0.0006/month
```

**Alternative Comparison:**

| Database | Why NOT Chosen |
|----------|----------------|
| **RDS/PostgreSQL** | Overkill for simple key-value data, requires connection management, higher cost |
| **Redis/ElastiCache** | In-memory only, data loss risk, more complex setup |
| **S3** | Not designed for frequent small updates, eventual consistency issues |
| **Lambda environment variables** | Limited size, no per-user storage |

**Serverless Stack Synergy:**
- **No cold start issues** - DynamoDB always ready
- **Automatic scaling** - matches Lambda's scaling behavior
- **Consistent performance** - predictable response times
- **Zero maintenance** - no database administration needed

DynamoDB is essentially the **default choice for serverless applications** storing simple, structured data with predictable access patterns.

## 📋 Setup Guide

### Prerequisites
- **AWS Account** with CLI configured (`aws configure`)
- **Node.js 18+** and npm installed
- **AWS CDK CLI:** `npm install -g aws-cdk`
- **Telegram Account** for creating bot

### Step 1: Create Telegram Bot
1. **Message [@BotFather](https://t.me/botfather)** on Telegram
2. **Send `/newbot`** and follow prompts:
   - Bot name: `Your Scheduler Bot`
   - Username: `your_scheduler_bot` (must end with 'bot')
3. **Copy the bot token** (format: `123456789:ABCdef...`)
4. **Keep this token secure** - you'll need it later

### Step 2: Deploy AWS Infrastructure
```bash
# Clone and setup
git clone <your-repo>
cd telegram-scheduler-bot

# Install dependencies
cd lambda && npm install
cd ../cdk && npm install

# Deploy to AWS (creates all resources)
cdk bootstrap  # First-time AWS CDK setup
cdk deploy     # Deploys Lambda, API Gateway, S3, DynamoDB, etc.
```

**What gets created:**
- Lambda function with your bot code
- API Gateway endpoint for Telegram webhooks
- S3 bucket for calendar files
- DynamoDB table for user preferences
- Secrets Manager secret for bot token
- IAM roles and policies

**Save the webhook URL** from deployment output:
```
TelegramSchedulerBotStack.WebhookUrl = https://abc123.execute-api.us-east-1.amazonaws.com/prod/webhook
```

### Step 3: Store Bot Token Securely
```bash
# Store in AWS Secrets Manager (replace with your actual token)
aws secretsmanager put-secret-value \
  --secret-id telegram/bot \
  --secret-string '{"BOT_TOKEN":"123456789:ABCdef_your_actual_token_here"}'
```

### Step 4: Connect Telegram to AWS
```bash
# Tell Telegram where to send messages (replace with your values)
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<YOUR_WEBHOOK_URL>"}'
```

**Success response:**
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### Step 5: Test Your Bot
1. **Find your bot** on Telegram (search for your bot username)
2. **Send `/start`** to see the welcome message
3. **Try creating an event:** "Meeting tomorrow 2pm"
4. **Check AWS CloudWatch Logs** if something goes wrong

## 🔄 CI/CD Setup (Optional)

### Automated Deployment with GitHub Actions

Set up automatic deployment so every push to main branch updates your live bot.

**Step 1: Get AWS Credentials**
```bash
# Check your current AWS user
aws sts get-caller-identity

# Note down your Access Key ID and Secret Access Key
aws configure list
```

**Step 2: Add GitHub Repository Secrets**
1. **Go to your GitHub repo** → **Settings** → **Secrets and variables** → **Actions**
2. **Click "New repository secret"** and add:
   - Name: `AWS_ACCESS_KEY_ID`, Value: `your-access-key-id`
   - Name: `AWS_SECRET_ACCESS_KEY`, Value: `your-secret-access-key`

**Step 3: Workflow Configuration**
The workflow file `.github/workflows/deploy.yml` is already configured to:
- **Trigger on push** to main branch
- **Install dependencies** (Node.js, CDK)
- **Deploy to AWS** using `cdk deploy`
- **Complete in 2-3 minutes**

**Step 4: Test Auto-Deployment**
```bash
# Make any change to your code
git add .
git commit -m "test: trigger auto-deployment"
git push origin main  # ← This automatically deploys to AWS
```

**Step 5: Monitor Deployment**
- **GitHub:** Go to **Actions** tab to watch deployment progress
- **AWS:** Check CloudWatch logs for any issues
- **Telegram:** Test your bot to confirm updates work

**Benefits:**
- ✅ **Zero-touch deployment** - push code, bot updates automatically
- ✅ **Consistent process** - same deployment every time
- ✅ **Fast feedback** - see results in 2-3 minutes
- ✅ **Team collaboration** - anyone can deploy by pushing to main

## 📱 Usage

### Bot Commands
- `/start` or `/help` - Show help
- `/tz <timezone>` - Set timezone (e.g., `/tz America/New_York`)
- `/duration <minutes>` - Set default duration (e.g., `/duration 90`)

### Creating Events
**Examples:**
- "Team meeting tmr 3pm" → 1-hour meeting tomorrow at 3 PM
- "Doctor appointment next Friday 10:30am" → Appointment next Friday
- "Meeting Friday" → All-day event this Friday
- "Call 29th 5am" → Call on 29th of current month at 5 AM

**Response:**
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
├── lambda/           # Lambda function code
│   ├── index.mjs    # Main bot logic
│   └── package.json # Dependencies
├── cdk/             # Infrastructure as Code
│   ├── lib/         # CDK stack definitions
│   └── package.json # CDK dependencies
└── .github/
    └── workflows/
        └── deploy.yml # CI/CD pipeline
```

### Local Development
```bash
# Make changes to lambda/index.mjs or cdk files
# Push to main branch for auto-deployment
git push origin main

# Or deploy manually
cd cdk && cdk deploy
```

### Monitoring & Debugging

**CloudWatch Logs:**
```bash
# View real-time logs
aws logs tail /aws/lambda/TelegramSchedulerBotStack-TelegramBotFunction --follow
```

**Common Issues:**
- **Bot not responding:** Check webhook URL is set correctly
- **"Internal server error":** Check CloudWatch logs for Lambda errors
- **Wrong timezone:** User can set with `/tz America/New_York`
- **Deployment failed:** Check GitHub Actions logs

**Testing:**
- **Basic:** Send `/start` to your bot
- **Date parsing:** Try "Meeting tomorrow 2pm"
- **Timezone:** Try "Call 29th 5am" (uses current month)
- **All-day:** Try "Conference Friday" (no time = all-day)

## 💰 Cost Breakdown

**Monthly cost for 1000 messages:**
- **Lambda:** $0.003 (requests + compute time)
- **API Gateway:** $0.004 (HTTP requests)
- **DynamoDB:** $0.0006 (storage + reads/writes)
- **S3:** $0.001 (storage + requests)
- **Secrets Manager:** $0.40 (secret storage)
- **Total:** ~$0.41/month

**Scaling:** Costs scale linearly with usage. 10,000 messages ≈ $4/month.

## 🔒 Security Features

**Secure by Design:**
- **No secrets in code** - Bot token stored in AWS Secrets Manager
- **Encrypted storage** - All data encrypted at rest with AWS KMS
- **IAM permissions** - Lambda has minimal required permissions only
- **HTTPS only** - All API communication over TLS
- **Temporary URLs** - Calendar file URLs expire after 1 hour

**Security Note:**
This repository previously contained an exposed API token in commit history. The token has been revoked and replaced. All secrets are now properly stored in AWS Secrets Manager.

**Best Practices:**
- Never commit API tokens or secrets to Git
- Use AWS Secrets Manager for sensitive data
- Regularly rotate API tokens
- Monitor AWS CloudTrail for suspicious activity

## 🤝 Contributing
1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## 📄 License
MIT License - see [LICENSE](LICENSE) file for details.

---
**Built with ❤️ using AWS Serverless Technologies**e for details.

---
**Built with ❤️ using AWS Serverless Technologies**