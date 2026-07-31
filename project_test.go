package main

import "testing"

func TestKiloRoutes(t *testing.T) {
	project := currentProject()
	for _, raw := range []string{
		"/openai/v1/chat/completions",
		"/openai/v1/models",
		"/anthropic/v1/messages",
	} {
		if _, ok := normalizePath(project, raw); !ok {
			t.Fatalf("expected route %s to be accepted", raw)
		}
	}
	if _, ok := normalizePath(project, "/codex/v1/responses"); ok {
		t.Fatal("Kilo must not expose the Codex route")
	}
	if !project.gatewayAuth {
		t.Fatal("Kilo must preserve GATEWAY_KEY authentication")
	}
}
