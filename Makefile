SHELL := /usr/bin/env bash

GO := ./scripts/run-go.sh
GO_PACKAGES := ./...
GO_INTERNAL_PACKAGES := ./internal/...
GO_BUILD_FLAGS ?=
GO_TEST_FLAGS ?=
CDK_CONTEXT ?=

.DEFAULT_GOAL := help

.PHONY: help
help:
	@printf '%s\n' 'Targets:'
	@printf '  %-18s %s\n' 'go-build' 'Compile all Go packages under cmd/ and internal/.'
	@printf '  %-18s %s\n' 'go-test' 'Run all Go unit tests.'
	@printf '  %-18s %s\n' 'go-test-cover' 'Run internal Go unit tests with package coverage.'
	@printf '  %-18s %s\n' 'go-fmt' 'Format Go source files.'
	@printf '  %-18s %s\n' 'go-vet' 'Run go vet over cmd/ and internal/.'
	@printf '  %-18s %s\n' 'typecheck' 'Run TypeScript typecheck.'
	@printf '  %-18s %s\n' 'build' 'Run Go build and TypeScript build.'
	@printf '  %-18s %s\n' 'test' 'Run Go tests and TypeScript typecheck.'
	@printf '  %-18s %s\n' 'synth' 'Run CDK synth. Pass CDK_CONTEXT="-c key=value".'
	@printf '  %-18s %s\n' 'diff' 'Run CDK diff. Pass CDK_CONTEXT="-c key=value".'
	@printf '  %-18s %s\n' 'deploy' 'Run CDK deploy. Pass CDK_CONTEXT="-c key=value".'
	@printf '  %-18s %s\n' 'clean' 'Remove generated Go coverage files.'

.PHONY: go-build
go-build:
	$(GO) build $(GO_BUILD_FLAGS) $(GO_PACKAGES)

.PHONY: go-test
go-test:
	$(GO) test $(GO_TEST_FLAGS) $(GO_PACKAGES)

.PHONY: go-test-cover
go-test-cover:
	$(GO) test $(GO_TEST_FLAGS) -cover $(GO_INTERNAL_PACKAGES)

.PHONY: go-fmt
go-fmt:
	$(GO) fmt ./cmd/... ./internal/...

.PHONY: go-vet
go-vet:
	$(GO) vet $(GO_PACKAGES)

.PHONY: typecheck
typecheck:
	npm run typecheck

.PHONY: ts-build
ts-build:
	npm run build

.PHONY: build
build: go-build ts-build

.PHONY: test
test: go-test typecheck

.PHONY: synth
synth:
	npx cdk synth $(CDK_CONTEXT)

.PHONY: diff
diff:
	npx cdk diff $(CDK_CONTEXT)

.PHONY: deploy
deploy:
	npx cdk deploy $(CDK_CONTEXT)

.PHONY: clean
clean:
	rm -f coverage.out
