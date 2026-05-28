package license

import (
	"errors"
	"testing"
	"time"
)

func TestSignParseRoundtrip(t *testing.T) {
	pub, priv, err := GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	in := Payload{
		RestaurantID: "rest-1",
		IssuedAt:     time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		ExpiresAt:    time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC),
		Edition:      EditionPro,
	}
	tok, err := Sign(priv, in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Parse(tok, pub)
	if err != nil {
		t.Fatal(err)
	}
	if out.RestaurantID != in.RestaurantID || !out.ExpiresAt.Equal(in.ExpiresAt) || out.Edition != in.Edition {
		t.Errorf("roundtrip mismatch: %+v vs %+v", in, out)
	}
}

func TestParseTamperedSignature(t *testing.T) {
	pub, priv, _ := GenerateKeypair()
	tok, _ := Sign(priv, Payload{RestaurantID: "x", ExpiresAt: time.Now().Add(time.Hour)})
	// Находим разделитель и портим ПЕРВЫЙ символ сигнатуры на другой (гарантированно
	// меняем байты). Замена X→X без эффекта — рандомная flake.
	dot := -1
	for i, c := range tok {
		if c == '.' {
			dot = i
			break
		}
	}
	if dot < 0 || dot+1 >= len(tok) {
		t.Fatal("no signature in token")
	}
	orig := tok[dot+1]
	repl := byte('A')
	if orig == 'A' {
		repl = 'B'
	}
	bad := tok[:dot+1] + string(repl) + tok[dot+2:]
	if _, err := Parse(bad, pub); !errors.Is(err, ErrBadSignature) && !errors.Is(err, ErrBadFormat) {
		t.Errorf("expected ErrBadSignature/Format, got %v", err)
	}
}

func TestParseWrongKey(t *testing.T) {
	_, priv, _ := GenerateKeypair()
	otherPub, _, _ := GenerateKeypair()
	tok, _ := Sign(priv, Payload{RestaurantID: "x", ExpiresAt: time.Now().Add(time.Hour)})
	if _, err := Parse(tok, otherPub); !errors.Is(err, ErrBadSignature) {
		t.Errorf("expected ErrBadSignature, got %v", err)
	}
}

func TestValidateExpired(t *testing.T) {
	pub, priv, _ := GenerateKeypair()
	tok, _ := Sign(priv, Payload{
		RestaurantID: "x",
		ExpiresAt:    time.Now().Add(-time.Hour),
	})
	now := time.Now()
	if _, err := Validate(tok, pub, now); !errors.Is(err, ErrExpired) {
		t.Errorf("expected ErrExpired, got %v", err)
	}
}

func TestKeyEncoding(t *testing.T) {
	pub, priv, _ := GenerateKeypair()
	pubB64 := EncodeKey(pub)
	privB64 := EncodeKey(priv)
	pub2, err := DecodePublicKey(pubB64)
	if err != nil || string(pub2) != string(pub) {
		t.Errorf("pub roundtrip: %v", err)
	}
	priv2, err := DecodePrivateKey(privB64)
	if err != nil || string(priv2) != string(priv) {
		t.Errorf("priv roundtrip: %v", err)
	}
}
