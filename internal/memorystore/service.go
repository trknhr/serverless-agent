package memorystore

import (
	"context"
	"time"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
)

type Service struct {
	userMemoryRepository *repo.UserMemoryRepository
	anthropicClient      *anthropic.Client
}

func New(userMemoryRepository *repo.UserMemoryRepository, anthropicClient *anthropic.Client) *Service {
	return &Service{
		userMemoryRepository: userMemoryRepository,
		anthropicClient:      anthropicClient,
	}
}

func (s *Service) GetOrCreateMemoryStore(ctx context.Context, workspaceID string, userID string) (*contracts.UserMemoryRecord, error) {
	existing, err := s.userMemoryRepository.Find(ctx, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	store, err := s.anthropicClient.CreateMemoryStore(ctx, anthropic.CreateMemoryStoreInput{
		Name:        "workspace-" + workspaceID + "-user-" + userID,
		Description: "Per-user preferences and durable project context.",
	})
	if err != nil {
		return nil, err
	}

	record := contracts.UserMemoryRecord{
		WorkspaceID:   workspaceID,
		UserID:        userID,
		MemoryStoreID: store.ID,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.userMemoryRepository.Save(ctx, record); err != nil {
		return nil, err
	}
	return &record, nil
}
