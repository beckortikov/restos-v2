# RestOS v4 — Go backend Makefile

SHELL := /bin/bash
GO ?= go
BIN_DIR := bin
BIN_NAME := restos-server
PKG := ./...

VERSION   := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT    := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w \
  -X main.version=$(VERSION) \
  -X main.commit=$(COMMIT) \
  -X main.buildTime=$(BUILD_TIME)

# Sidecar copy target — куда копируем бинарь для упаковки в Electron.
# Электрон-сборка читает из ../desktop/resources/restos-server (относительно server/).
SIDECAR_DEST := ../desktop/resources/restos-server

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

.PHONY: tidy
tidy: ## go mod tidy
	$(GO) mod tidy

.PHONY: run
run: ## Run with auto embedded Postgres (downloads PG16 on first run)
	$(GO) run ./cmd/restos-server

# DSN по умолчанию для локальной разработки на машине разработчика.
# Перебивается через `PG_DSN=...` или `RESTOS_EXTERNAL_PG_DSN=...`.
DEV_PG_DSN ?= host=127.0.0.1 port=5432 user=restos dbname=restos_v4 sslmode=disable

.PHONY: run-dev
run-dev: ## Run against local Postgres 18 (db: restos_v4, user: restos)
	$(GO) run ./cmd/restos-server --external-pg-dsn="$(DEV_PG_DSN)"

.PHONY: run-external
run-external: ## Run with custom external Postgres: make run-external PG_DSN="host=... ..."
	@if [ -z "$(PG_DSN)" ]; then echo "PG_DSN is required"; exit 1; fi
	$(GO) run ./cmd/restos-server --external-pg-dsn="$(PG_DSN)"

.PHONY: build
build: ## Build local binary into bin/
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BIN_NAME) ./cmd/restos-server

.PHONY: build-all
build-all: ## Cross-compile for darwin/linux/windows × amd64/arm64
	mkdir -p $(BIN_DIR)
	GOOS=darwin  GOARCH=arm64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BIN_NAME)-darwin-arm64  ./cmd/restos-server
	GOOS=darwin  GOARCH=amd64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BIN_NAME)-darwin-amd64  ./cmd/restos-server
	GOOS=linux   GOARCH=amd64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BIN_NAME)-linux-amd64   ./cmd/restos-server
	GOOS=linux   GOARCH=arm64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BIN_NAME)-linux-arm64   ./cmd/restos-server
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BIN_NAME)-windows-amd64.exe ./cmd/restos-server

.PHONY: build-sidecar
build-sidecar: build ## Build for current OS and copy as Electron sidecar
	mkdir -p $(dir $(SIDECAR_DEST))
	cp $(BIN_DIR)/$(BIN_NAME) $(SIDECAR_DEST)
	@echo "→ copied $(BIN_NAME) to $(SIDECAR_DEST)"

# Electron-builder ожидает бинари в desktop/resources/ с предсказуемыми именами
# (без target-triple) — main.js per-process выбирает нужный. Мы кладём все
# 5 бинарей и main.js выбирает по process.platform + process.arch.
.PHONY: build-sidecar-all
build-sidecar-all: build-all ## Cross-compile all platforms and copy as Electron sidecars
	mkdir -p $(dir $(SIDECAR_DEST))
	cp $(BIN_DIR)/$(BIN_NAME)-darwin-arm64       $(dir $(SIDECAR_DEST))$(BIN_NAME)-darwin-arm64
	cp $(BIN_DIR)/$(BIN_NAME)-darwin-amd64       $(dir $(SIDECAR_DEST))$(BIN_NAME)-darwin-amd64
	cp $(BIN_DIR)/$(BIN_NAME)-linux-amd64        $(dir $(SIDECAR_DEST))$(BIN_NAME)-linux-amd64
	cp $(BIN_DIR)/$(BIN_NAME)-linux-arm64        $(dir $(SIDECAR_DEST))$(BIN_NAME)-linux-arm64
	cp $(BIN_DIR)/$(BIN_NAME)-windows-amd64.exe  $(dir $(SIDECAR_DEST))$(BIN_NAME)-windows-amd64.exe
	@echo "→ copied 5 sidecar binaries to $(dir $(SIDECAR_DEST))"

# License CLI — генерация keypair и токенов (отдельный бинарь).
.PHONY: build-license-gen
build-license-gen: ## Build license-gen CLI
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/license-gen ./cmd/license-gen

.PHONY: license-keypair
license-keypair: build-license-gen ## Generate new Ed25519 keypair
	@./$(BIN_DIR)/license-gen keypair

.PHONY: test
test: ## Run unit tests (no DB)
	$(GO) test -race -count=1 $(PKG)

.PHONY: test-integration
test-integration: ## Run integration tests against local Postgres (restos_v4_test, isolated from dev)
	$(GO) test -tags=integration -count=1 $(PKG)

# Удобный alias для CI/локалки: всегда против test-DB.
TEST_DSN ?= host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable
.PHONY: test-all
test-all: ## Unit + integration tests against restos_v4_test
	RESTOS_TEST_DSN="$(TEST_DSN)" $(GO) test -tags=integration -count=1 $(PKG)

.PHONY: bench
bench: ## Run perf bench (10k orders, p99 GET /orders < 50ms)
	$(GO) test -tags=bench -run TestPerf -count=1 -v ./internal/transport/http/...

.PHONY: test-cover
test-cover: ## Run tests with coverage
	$(GO) test -race -coverprofile=coverage.out $(PKG)
	$(GO) tool cover -func=coverage.out | tail -1

.PHONY: lint
lint: ## golangci-lint (must be installed locally)
	@command -v golangci-lint >/dev/null || { echo "golangci-lint not installed: see https://golangci-lint.run/usage/install/"; exit 1; }
	golangci-lint run

.PHONY: vet
vet: ## go vet
	$(GO) vet $(PKG)

.PHONY: fmt
fmt: ## gofmt -s -w
	gofmt -s -w .

.PHONY: api-validate
api-validate: ## Validate OpenAPI spec syntax (requires redocly or swagger-cli)
	@if command -v redocly >/dev/null; then \
		redocly lint api/openapi.yaml; \
	elif command -v swagger-cli >/dev/null; then \
		swagger-cli validate api/openapi.yaml; \
	else \
		echo "Install one of: 'npm i -g @redocly/cli' or 'npm i -g @apidevtools/swagger-cli'"; \
		exit 1; \
	fi

.PHONY: api-gen
api-gen: ## (Optional) Generate types via oapi-codegen
	@command -v oapi-codegen >/dev/null || { echo "go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest"; exit 1; }
	oapi-codegen -package openapi -generate types,chi-server -o internal/transport/http/openapi/openapi.gen.go api/openapi.yaml || true

.PHONY: ts-client
ts-client: ## Generate TypeScript types in ../lib/api/generated.ts from OpenAPI
	@command -v npx >/dev/null || { echo "Install Node.js for npx"; exit 1; }
	npx -y openapi-typescript@7 api/openapi.yaml -o ../lib/api/generated.ts
	@echo "→ ../lib/api/generated.ts updated"

.PHONY: update-golden
update-golden: ## Refresh ESC/POS snapshot fixtures (explicit only)
	UPDATE_GOLDEN=1 $(GO) test ./internal/escpos/... -count=1

.PHONY: clean
clean:
	rm -rf $(BIN_DIR) coverage.out
