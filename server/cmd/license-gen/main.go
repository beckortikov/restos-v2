// license-gen — CLI для генерации Ed25519 keypair и выписки license-токенов.
//
// Использование:
//
//	# 1. Сгенерировать keypair (один раз для всей фермы лицензий):
//	license-gen keypair
//	  → выведет PUBLIC_KEY=... и PRIVATE_KEY=... (base64).
//	  PUBLIC_KEY кладём в production restos-server через --license-public-key.
//	  PRIVATE_KEY храним В СЕКРЕТЕ у издателя (Owner Dashboard / SaaS billing).
//
//	# 2. Выписать токен на 1 год для ресторана:
//	license-gen issue --priv $PRIVATE_KEY --rid <restaurant_uuid> --days 365 [--edition pro]
//	  → выведет токен (base64.base64), который клиент вводит в форме активации.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/license"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "keypair":
		cmdKeypair()
	case "issue":
		cmdIssue(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, strings.TrimSpace(`
Usage:
  license-gen keypair
  license-gen issue --priv <base64> --rid <uuid> --days <N> [--edition start|business|pro]
`))
}

func cmdKeypair() {
	pub, priv, err := license.GenerateKeypair()
	if err != nil {
		fail("keypair: %v", err)
	}
	fmt.Printf("PUBLIC_KEY=%s\n", license.EncodeKey(pub))
	fmt.Printf("PRIVATE_KEY=%s\n", license.EncodeKey(priv))
}

func cmdIssue(args []string) {
	fs := flag.NewFlagSet("issue", flag.ExitOnError)
	priv := fs.String("priv", "", "base64 Ed25519 private key (or env LICENSE_PRIVATE_KEY)")
	rid := fs.String("rid", "", "restaurant UUID")
	days := fs.Int("days", 365, "license duration in days")
	edition := fs.String("edition", "start", "edition: start|business|pro")
	_ = fs.Parse(args)

	if *priv == "" {
		*priv = os.Getenv("LICENSE_PRIVATE_KEY")
	}
	if *priv == "" {
		fail("--priv (or LICENSE_PRIVATE_KEY env) is required")
	}
	if *rid == "" {
		fail("--rid is required")
	}
	if *days <= 0 {
		fail("--days must be > 0")
	}

	privKey, err := license.DecodePrivateKey(*priv)
	if err != nil {
		fail("bad private key: %v", err)
	}

	now := time.Now().UTC()
	payload := license.Payload{
		Version:      license.CurrentVersion,
		RestaurantID: *rid,
		IssuedAt:     now,
		ExpiresAt:    now.AddDate(0, 0, *days),
		Edition:      license.Edition(*edition),
	}
	tok, err := license.Sign(privKey, payload)
	if err != nil {
		fail("sign: %v", err)
	}
	fmt.Println(tok)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "license-gen: "+format+"\n", args...)
	os.Exit(1)
}
