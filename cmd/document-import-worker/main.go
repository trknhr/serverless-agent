package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/config"
	"github.com/trknhr/slack-ai-assistant/internal/documents"
	importcontracts "github.com/trknhr/slack-ai-assistant/internal/imports"
	"github.com/trknhr/slack-ai-assistant/internal/integrations"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/memory"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
	"github.com/trknhr/slack-ai-assistant/internal/slack"
	"github.com/trknhr/slack-ai-assistant/internal/tools"
)

const (
	defaultImportPrompt             = "Analyze the uploaded household document. " + memory.DocumentImportInstructions
	defaultMarkdownExtractionPrompt = "Transcribe the attached PDF into clean Markdown. Preserve the document structure with headings, paragraphs, lists, and tables when possible. Do not summarize, omit sections, or add commentary. If text is unreadable, keep the surrounding structure and mark the uncertain span with [unclear]. Return only Markdown."
)

var (
	importWorkerEnv             = config.MustLoadImportWorkerEnv()
	importWorkerLogger          = logger.Default()
	importWorkerAWSConfig, _    = awsconfig.LoadDefaultConfig(context.Background())
	importWorkerS3Client        = s3.NewFromConfig(importWorkerAWSConfig)
	importWorkerSecretsProvider = secrets.New(secretsmanager.NewFromConfig(importWorkerAWSConfig))
	importWorkerAnthropicClient = anthropic.NewClient(func(ctx context.Context) (string, error) {
		return importWorkerSecretsProvider.GetSecretString(ctx, importWorkerEnv.AnthropicAPIKeySecretID)
	}, importWorkerEnv.AnthropicManagedAgentsBeta)
	importWorkerCalendarDraftRepository = repo.NewCalendarDraftRepository(dynamodb.NewFromConfig(importWorkerAWSConfig), importWorkerEnv.CalendarDraftsTableName)
	importWorkerGoogleOAuthConnections  = repo.NewGoogleOAuthConnectionRepository(dynamodb.NewFromConfig(importWorkerAWSConfig), importWorkerEnv.GoogleOAuthConnectionsTable)
	importWorkerMemoryItemRepository    = repo.NewMemoryItemRepository(dynamodb.NewFromConfig(importWorkerAWSConfig), importWorkerEnv.MemoryItemsTableName)
	importWorkerTaskEventRepository     = repo.NewTaskEventRepository(dynamodb.NewFromConfig(importWorkerAWSConfig), importWorkerEnv.TaskEventsTableName)
	importWorkerTaskStateRepository     = repo.NewTaskStateRepository(dynamodb.NewFromConfig(importWorkerAWSConfig), importWorkerEnv.TasksTableName)
	importWorkerSourceDocRepository     = repo.NewSourceDocumentRepository(dynamodb.NewFromConfig(importWorkerAWSConfig), importWorkerEnv.SourceDocumentsTableName)
	importWorkerFileSanitizer           = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
	importWorkerHasExtensionPattern     = regexp.MustCompile(`\.[a-zA-Z0-9]+$`)
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event events.SQSEvent) error {
	for _, record := range event.Records {
		var queueMessage importcontracts.QueueMessage
		if err := json.Unmarshal([]byte(record.Body), &queueMessage); err != nil {
			return err
		}
		log := importWorkerLogger.Child(logger.Fields{
			"correlationId": queueMessage.CorrelationID,
			"sourceId":      queueMessage.SourceID,
			"component":     "document-import-worker",
		})

		source, err := importWorkerSourceDocRepository.Get(ctx, queueMessage.WorkspaceID, queueMessage.SourceID)
		if err != nil {
			return err
		}
		if source == nil {
			return fmt.Errorf("source document %s was not found", queueMessage.SourceID)
		}
		if source.S3Bucket == "" || source.S3Key == "" {
			return fmt.Errorf("source document %s is missing archive coordinates", queueMessage.SourceID)
		}

		output, err := importWorkerS3Client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: &source.S3Bucket,
			Key:    &source.S3Key,
		})
		if err != nil {
			return persistImportFailure(ctx, source, queueMessage.Operation, err, log)
		}
		bytes, err := io.ReadAll(output.Body)
		output.Body.Close()
		if err != nil {
			return persistImportFailure(ctx, source, queueMessage.Operation, err, log)
		}

		if queueMessage.Operation == "extract_markdown" {
			err = extractMarkdown(ctx, *source, queueMessage, bytes, log)
		} else {
			err = importDocument(ctx, *source, queueMessage, bytes, log)
		}
		if err != nil {
			return persistImportFailure(ctx, source, queueMessage.Operation, err, log)
		}
	}
	return nil
}

func importDocument(ctx context.Context, source documents.SourceDocument, queueMessage importcontracts.QueueMessage, bytes []byte, log *logger.Logger) error {
	now := time.Now().UTC().Format(time.RFC3339)
	source.Status = "processing"
	source.ErrorMessage = ""
	source.UpdatedAt = now
	if _, err := importWorkerSourceDocRepository.Save(ctx, source); err != nil {
		return err
	}

	session, err := anthropic.CreateSession(ctx, importWorkerAnthropicClient, anthropic.CreateSessionInput{
		AgentID:       importWorkerEnv.AnthropicAgentID,
		EnvironmentID: importWorkerEnv.AnthropicEnvironmentID,
		VaultIDs:      importWorkerEnv.AnthropicVaultIDs,
		Title:         "Imported document " + source.Title,
		Metadata: map[string]string{
			"source":       "local_import",
			"source_id":    source.SourceID,
			"workspace_id": source.WorkspaceID,
		},
	})
	if err != nil {
		return err
	}

	seenEventIDs, err := collectSessionEventIDs(ctx, session.ID)
	if err != nil {
		return err
	}

	executor := tools.NewExecutor(tools.Repositories{
		MemoryItems:    importWorkerMemoryItemRepository,
		Tasks:          importWorkerTaskStateRepository,
		TaskEvents:     importWorkerTaskEventRepository,
		CalendarDrafts: importWorkerCalendarDraftRepository,
	}, tools.ToolExecutionContext{
		WorkspaceID: queueMessage.WorkspaceID,
		UserID:      queueMessage.UserID,
		Logger:      log,
	}, tools.Integrations{
		GoogleCalendarProvider: func(ctx context.Context) (*calendar.GoogleCalendarClient, error) {
			return integrations.CreateUserGoogleCalendarClient(
				queueMessage.WorkspaceID,
				queueMessage.UserID,
				importWorkerEnv.GoogleCalendarTimeZone,
				importWorkerEnv.GoogleCalendarSecretID,
				importWorkerEnv.GoogleOAuthStartURL,
				importWorkerSecretsProvider,
				importWorkerGoogleOAuthConnections,
			), nil
		},
		DefaultCalendarTimeZone: importWorkerEnv.GoogleCalendarTimeZone,
	})

	prompt := queueMessage.Prompt
	if strings.TrimSpace(prompt) == "" {
		prompt = defaultImportPrompt
	}
	if err := anthropic.SendUserMessage(ctx, importWorkerAnthropicClient, session.ID, append([]anthropic.InputBlock{
		{
			"type": "text",
			"text": prompt + "\n\nSource path: " + source.SourceRef,
		},
	}, documents.BuildClaudeContentBlocksForDocument(source.Title, source.MimeType, bytes)...)); err != nil {
		return err
	}

	completion, err := anthropic.WaitForCompletion(ctx, importWorkerAnthropicClient, anthropic.WaitForCompletionInput{
		SessionID:     session.ID,
		SinceEventIDs: seenEventIDs,
		TimeoutMS:     importWorkerEnv.AgentResponseTimeoutMS,
		OnCustomToolUse: func(ctx context.Context, event anthropic.SessionEvent) (*anthropic.ToolExecutionResult, error) {
			result, err := executor.Execute(ctx, event)
			if err != nil {
				return nil, err
			}
			return &anthropic.ToolExecutionResult{Content: result.Content, IsError: result.IsError}, nil
		},
	})
	if err != nil {
		return err
	}
	summary := executor.Summary()

	source.Status = "imported"
	source.Summary = completion.Text
	source.ImportedTaskIDs = summary.TaskIDs
	source.SavedMemoryIDs = summary.SavedMemoryIDs
	source.ErrorMessage = ""
	source.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if _, err := importWorkerSourceDocRepository.Save(ctx, source); err != nil {
		return err
	}

	log.Info("Document imported", logger.Fields{
		"sessionId":   session.ID,
		"taskCount":   len(summary.TaskIDs),
		"memoryCount": len(summary.SavedMemoryIDs),
	})
	return nil
}

func extractMarkdown(ctx context.Context, source documents.SourceDocument, queueMessage importcontracts.QueueMessage, bytes []byte, log *logger.Logger) error {
	now := time.Now().UTC().Format(time.RFC3339)
	source.ExtractionStatus = "processing"
	source.ExtractionErrorMessage = ""
	source.UpdatedAt = now
	if _, err := importWorkerSourceDocRepository.Save(ctx, source); err != nil {
		return err
	}

	session, err := anthropic.CreateSession(ctx, importWorkerAnthropicClient, anthropic.CreateSessionInput{
		AgentID:       importWorkerEnv.AnthropicAgentID,
		EnvironmentID: importWorkerEnv.AnthropicEnvironmentID,
		VaultIDs:      importWorkerEnv.AnthropicVaultIDs,
		Title:         "Markdown extraction " + source.Title,
		Metadata: map[string]string{
			"source":       "markdown_extraction",
			"source_id":    source.SourceID,
			"workspace_id": source.WorkspaceID,
		},
	})
	if err != nil {
		return err
	}

	seenEventIDs, err := collectSessionEventIDs(ctx, session.ID)
	if err != nil {
		return err
	}
	prompt := queueMessage.Prompt
	if strings.TrimSpace(prompt) == "" {
		prompt = defaultMarkdownExtractionPrompt
	}
	if err := anthropic.SendUserMessage(ctx, importWorkerAnthropicClient, session.ID, append([]anthropic.InputBlock{
		{
			"type": "text",
			"text": prompt + "\n\nSource path: " + source.SourceRef,
		},
	}, documents.BuildClaudeContentBlocksForDocument(source.Title, source.MimeType, bytes)...)); err != nil {
		return err
	}

	completion, err := anthropic.WaitForCompletion(ctx, importWorkerAnthropicClient, anthropic.WaitForCompletionInput{
		SessionID:     session.ID,
		SinceEventIDs: seenEventIDs,
		TimeoutMS:     importWorkerEnv.AgentResponseTimeoutMS,
		OnCustomToolUse: func(context.Context, anthropic.SessionEvent) (*anthropic.ToolExecutionResult, error) {
			return &anthropic.ToolExecutionResult{
				IsError: true,
				Content: []anthropic.InputBlock{
					{
						"type": "text",
						"text": "Custom tools are not available during markdown extraction.",
					},
				},
			}, nil
		},
	})
	if err != nil {
		return err
	}

	markdown := strings.TrimSpace(completion.Text)
	now = time.Now().UTC().Format(time.RFC3339)
	hash := sha256.Sum256([]byte(markdown))
	checksum := hex.EncodeToString(hash[:])
	s3Key := buildExtractedMarkdownS3Key(source.WorkspaceID, source.SourceID, source.Title, now)
	_, err = importWorkerS3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      &importWorkerEnv.DocumentArchiveBucket,
		Key:         &s3Key,
		Body:        strings.NewReader(markdown),
		ContentType: stringPtr("text/markdown; charset=utf-8"),
		Metadata: map[string]string{
			"source_id":    source.SourceID,
			"workspace_id": source.WorkspaceID,
			"checksum":     checksum,
		},
	})
	if err != nil {
		return err
	}

	size := int64(len([]byte(markdown)))
	source.ExtractionStatus = "extracted"
	source.ExtractionErrorMessage = ""
	source.ExtractedMarkdownS3Bucket = importWorkerEnv.DocumentArchiveBucket
	source.ExtractedMarkdownS3Key = s3Key
	source.ExtractedMarkdownChecksum = checksum
	source.ExtractedMarkdownSize = &size
	source.UpdatedAt = now
	if _, err := importWorkerSourceDocRepository.Save(ctx, source); err != nil {
		return err
	}

	log.Info("Markdown extracted", logger.Fields{
		"sessionId":              session.ID,
		"extractedMarkdownS3Key": s3Key,
	})
	return nil
}

func collectSessionEventIDs(ctx context.Context, sessionID string) (map[string]struct{}, error) {
	events, err := importWorkerAnthropicClient.ListSessionEvents(ctx, sessionID, "asc", 0)
	if err != nil {
		return nil, err
	}
	result := map[string]struct{}{}
	for _, event := range events {
		result[event.ID] = struct{}{}
	}
	return result, nil
}

func persistImportFailure(ctx context.Context, source *documents.SourceDocument, operation string, err error, log *logger.Logger) error {
	message := err.Error()
	now := time.Now().UTC().Format(time.RFC3339)
	if operation == "extract_markdown" {
		source.ExtractionStatus = "failed"
		source.ExtractionErrorMessage = message
	} else {
		source.Status = "failed"
		source.ErrorMessage = message
	}
	source.UpdatedAt = now
	_, _ = importWorkerSourceDocRepository.Save(ctx, *source)
	if operation == "extract_markdown" {
		log.Error("Markdown extraction failed", logger.Fields{"error": message})
	} else {
		log.Error("Document import failed", logger.Fields{"error": message})
	}
	return err
}

func buildExtractedMarkdownS3Key(workspaceID string, sourceID string, title string, timestamp string) string {
	date, _ := time.Parse(time.RFC3339, timestamp)
	safeName := sanitizeFileName(title, sourceID, "text/markdown")
	return fmt.Sprintf("derived/private/extractions/%s/%04d/%02d/%s/%s", workspaceID, date.UTC().Year(), int(date.UTC().Month()), sourceID, safeName)
}

func sanitizeFileName(fileName string, sourceID string, mimeType string) string {
	trimmed := strings.TrimSpace(fileName)
	normalized := importWorkerFileSanitizer.ReplaceAllString(trimmed, "_")
	normalized = strings.Trim(normalized, "_")
	safeBase := normalized
	if safeBase == "" {
		safeBase = sourceID
	}
	if importWorkerHasExtensionPattern.MatchString(safeBase) {
		return safeBase
	}
	return safeBase + slack.DefaultExtensionForMimeType(mimeType)
}

func stringPtr(value string) *string {
	return &value
}
