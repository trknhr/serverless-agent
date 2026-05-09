package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/trknhr/slack-ai-assistant/internal/config"
	"github.com/trknhr/slack-ai-assistant/internal/lambdahttp"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
	"github.com/trknhr/slack-ai-assistant/internal/slack"
)

var (
	env                  = config.MustLoadIngressEnv()
	baseLogger           = logger.Default()
	awsRuntimeConfig, _  = awsconfig.LoadDefaultConfig(context.Background())
	sqsClient            = sqs.NewFromConfig(awsRuntimeConfig)
	secretsProvider      = secrets.New(secretsmanager.NewFromConfig(awsRuntimeConfig))
	eventDedupRepository = repo.NewEventDedupRepository(dynamodb.NewFromConfig(awsRuntimeConfig), env.ProcessedEventsTableName)
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	log := baseLogger.Child(logger.Fields{
		"requestId": event.RequestContext.RequestID,
		"component": "slack-events-ingress",
	})

	rawBody, err := decodeBody(event.Body, event.IsBase64Encoded)
	if err != nil {
		log.Error("Slack request body decode failed", logger.Fields{"error": err.Error()})
		return lambdahttp.JSON(400, map[string]any{"ok": false, "error": "invalid_body"}), nil
	}

	signingSecret, err := secretsProvider.GetSecretString(ctx, env.SlackSigningSecretSecretID)
	if err != nil {
		log.Error("Slack signing secret lookup failed", logger.Fields{"error": err.Error()})
		return lambdahttp.JSON(500, map[string]any{"ok": false, "error": "internal_error"}), nil
	}

	if !slack.VerifySignature(slack.VerifySignatureInput{
		RawBody:       rawBody,
		Signature:     getHeader(event.Headers, "X-Slack-Signature"),
		Timestamp:     getHeader(event.Headers, "X-Slack-Request-Timestamp"),
		SigningSecret: signingSecret,
	}) {
		log.Warn("Slack signature verification failed", nil)
		return lambdahttp.JSON(401, map[string]any{"ok": false, "error": "invalid_signature"}), nil
	}

	envelope, err := slack.ParseEnvelope(rawBody)
	if err != nil {
		log.Error("Slack envelope parse failed", logger.Fields{"error": err.Error()})
		return lambdahttp.JSON(400, map[string]any{"ok": false, "error": "invalid_payload"}), nil
	}

	if envelope.Type == "url_verification" {
		return lambdahttp.JSON(200, map[string]any{"challenge": envelope.Challenge}), nil
	}
	if envelope.EventID == "" {
		return lambdahttp.JSON(200, map[string]any{"ok": true, "ignored": true}), nil
	}

	accepted, err := eventDedupRepository.MarkProcessed(ctx, envelope.EventID, env.EventDedupTTLSeconds)
	if err != nil {
		log.Error("Slack event dedup failed", logger.Fields{"error": err.Error(), "eventId": envelope.EventID})
		return lambdahttp.JSON(500, map[string]any{"ok": false, "error": "internal_error"}), nil
	}
	if !accepted {
		log.Info("Duplicate Slack event ignored", logger.Fields{"eventId": envelope.EventID})
		return lambdahttp.JSON(200, map[string]any{"ok": true, "duplicate": true}), nil
	}

	correlationID := event.RequestContext.RequestID + ":" + envelope.EventID
	queueMessage, err := slack.ExtractSlackQueueMessage(envelope, correlationID)
	if err != nil {
		log.Error("Slack event extraction failed", logger.Fields{"error": err.Error(), "eventId": envelope.EventID})
		return lambdahttp.JSON(400, map[string]any{"ok": false, "error": "invalid_event"}), nil
	}
	if queueMessage == nil {
		log.Info("Slack event ignored", logger.Fields{"eventId": envelope.EventID})
		return lambdahttp.JSON(200, map[string]any{"ok": true, "ignored": true}), nil
	}

	payload, err := json.Marshal(queueMessage)
	if err != nil {
		log.Error("Slack queue message marshal failed", logger.Fields{"error": err.Error(), "eventId": envelope.EventID})
		return lambdahttp.JSON(500, map[string]any{"ok": false, "error": "internal_error"}), nil
	}

	_, err = sqsClient.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    &env.SlackQueueURL,
		MessageBody: stringPtr(string(payload)),
	})
	if err != nil {
		log.Error("Slack event enqueue failed", logger.Fields{"error": err.Error(), "eventId": envelope.EventID})
		return lambdahttp.JSON(500, map[string]any{"ok": false, "error": "internal_error"}), nil
	}

	log.Info("Slack event enqueued", logger.Fields{
		"eventId":        queueMessage.EventID,
		"channelId":      queueMessage.ChannelID,
		"conversationTs": queueMessage.ConversationTS,
		"replyThreadTs":  queueMessage.ReplyThreadTS,
		"contextScope":   queueMessage.ContextScope,
	})
	return lambdahttp.JSON(200, map[string]any{"ok": true}), nil
}

func decodeBody(body string, isBase64Encoded bool) (string, error) {
	if !isBase64Encoded {
		return body, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func getHeader(headers map[string]string, name string) string {
	if value, ok := headers[name]; ok {
		return value
	}
	lower := strings.ToLower(name)
	for key, value := range headers {
		if strings.ToLower(key) == lower {
			return value
		}
	}
	return ""
}

func stringPtr(value string) *string {
	return &value
}
