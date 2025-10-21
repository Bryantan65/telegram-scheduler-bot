import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

export class TelegramSchedulerBotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table for users
    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'tg_users',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

    // Secrets Manager for bot token
    const botSecret = new secretsmanager.Secret(this, 'BotSecret', {
      secretName: 'telegram/bot',
      description: 'Telegram bot token',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'BOT_TOKEN',
        excludeCharacters: '"@/\\'
      }
    });

    // Lambda function
    const lambdaFunction = new lambda.Function(this, 'TelegramBotFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        USERS_TABLE: usersTable.tableName,
        SECRET_ID: botSecret.secretName
      }
    });

    // Grant permissions
    usersTable.grantReadWriteData(lambdaFunction);
    botSecret.grantRead(lambdaFunction);

    // API Gateway
    const api = new apigateway.RestApi(this, 'TelegramBotApi', {
      restApiName: 'Telegram Scheduler Bot API',
      description: 'API for Telegram webhook',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS
      }
    });

    const webhookIntegration = new apigateway.LambdaIntegration(lambdaFunction);
    api.root.addResource('webhook').addMethod('POST', webhookIntegration);

    // Outputs
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.url}webhook`,
      description: 'Telegram webhook URL'
    });

    new cdk.CfnOutput(this, 'SecretName', {
      value: botSecret.secretName,
      description: 'Secrets Manager secret name for bot token'
    });
  }
}