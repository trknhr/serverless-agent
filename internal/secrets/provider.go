package secrets

import (
	"context"
	"fmt"
	"sync"

	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

type Provider struct {
	client *secretsmanager.Client
	mu     sync.RWMutex
	cache  map[string]string
}

func New(client *secretsmanager.Client) *Provider {
	return &Provider{
		client: client,
		cache:  map[string]string{},
	}
}

func (p *Provider) GetSecretString(ctx context.Context, secretID string) (string, error) {
	p.mu.RLock()
	if value, ok := p.cache[secretID]; ok {
		p.mu.RUnlock()
		return value, nil
	}
	p.mu.RUnlock()

	output, err := p.client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: &secretID,
	})
	if err != nil {
		return "", err
	}
	if output.SecretString == nil {
		return "", fmt.Errorf("secret %s does not contain SecretString", secretID)
	}

	p.mu.Lock()
	p.cache[secretID] = *output.SecretString
	p.mu.Unlock()
	return *output.SecretString, nil
}
