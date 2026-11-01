PORT ?= 8000
SLEEPER_USER ?= evanestes

.PHONY: help serve test verify-scoring

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

serve: ## Serve the page locally at http://localhost:$(PORT)
	python3 -m http.server $(PORT)

test: ## Run unit tests (Node built-in runner, no dependencies)
	node --test test/*.test.js

verify-scoring: ## Compare our league scoring against Sleeper's live per-player points
	node scripts/verify-scoring.mjs $(SLEEPER_USER)
