package main

import (
	"crypto/ed25519"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restos/restos-v4/server/internal/pkg/license"
)

// TestLicenseGen_CLI — сборка бинаря + генерация keypair + issue с
// --grace-days/--warning-days, потом парс токена и проверка десериализации.
func TestLicenseGen_CLI(t *testing.T) {
	tmp := t.TempDir()
	bin := filepath.Join(tmp, "license-gen")

	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	// keypair.
	out, err := exec.Command(bin, "keypair").Output()
	if err != nil {
		t.Fatalf("keypair: %v", err)
	}
	var privB64 string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, "PRIVATE_KEY=") {
			privB64 = strings.TrimPrefix(line, "PRIVATE_KEY=")
		}
	}
	if privB64 == "" {
		t.Fatalf("PRIVATE_KEY not in output: %s", out)
	}

	// issue с grace=14 warning=7.
	cmd := exec.Command(bin, "issue",
		"--priv", privB64,
		"--rid", "00000000-0000-0000-0000-000000000001",
		"--days", "30",
		"--grace-days", "14",
		"--warning-days", "7",
		"--edition", "pro",
	)
	cmd.Env = append(os.Environ(), "LICENSE_PRIVATE_KEY=")
	tok, err := cmd.Output()
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	token := strings.TrimSpace(string(tok))
	if token == "" {
		t.Fatal("empty token")
	}

	// Parse и проверка полей. Public-ключ извлекается из приватного.
	priv, err := license.DecodePrivateKey(privB64)
	if err != nil {
		t.Fatal(err)
	}
	edPub := priv.Public().(ed25519.PublicKey)
	p, err := license.Parse(token, edPub)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p.GraceDays != 14 || p.WarningDays != 7 {
		t.Errorf("got grace=%d warning=%d, want 14/7", p.GraceDays, p.WarningDays)
	}
	if p.Edition != license.EditionPro {
		t.Errorf("edition: got %q, want pro", p.Edition)
	}
}
