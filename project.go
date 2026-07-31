package main

import "net/http"

type modelMode int

const (
	modelPassthrough modelMode = iota
	modelKilo
	modelOpenCode
)

type projectSpec struct {
	name                  string
	displayName           string
	upstream              string
	probePath             string
	modelPath             string
	probeHeaders          http.Header
	forwardHeaders        []string
	prefixes              []string
	postPaths             map[string]struct{}
	gatewayAuth           bool
	upstreamAuthorization string
	defaultClientHeader   string
	directFallback        bool
	modelMode             modelMode
	ownedBy               string
	extraModels           []string
	specialModels         map[string]string
}

func currentProject() projectSpec {
	return projectSpec{
		name:        "kilocode-free-gate",
		displayName: "Kilo Code",
		upstream:    "https://api.kilo.ai/api/gateway",
		probePath:   "/models",
		modelPath:   "/models",
		probeHeaders: http.Header{
			"Accept": []string{"application/json"},
		},
		forwardHeaders: []string{
			"content-type",
			"accept",
			"anthropic-version",
			"anthropic-beta",
		},
		prefixes: []string{"openai", "anthropic"},
		postPaths: map[string]struct{}{
			"/v1/chat/completions": {},
			"/v1/messages":         {},
		},
		gatewayAuth:    true,
		directFallback: false,
		modelMode:      modelKilo,
		ownedBy:        "kilocode",
		specialModels: map[string]string{
			"kilo-auto/free":  "kilo-auto",
			"openrouter/free": "openrouter-free",
		},
	}
}
