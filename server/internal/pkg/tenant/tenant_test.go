package tenant

import (
	"context"
	"errors"
	"testing"
)

func TestRoundtrip(t *testing.T) {
	ctx := WithRestaurant(context.Background(), "rest-1")
	got, ok := RestaurantID(ctx)
	if !ok || got != "rest-1" {
		t.Fatalf("got %q ok=%v", got, ok)
	}
}

func TestMustMissing(t *testing.T) {
	_, err := MustRestaurantID(context.Background())
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("expected ErrMissing, got %v", err)
	}
}

func TestEmptyStringTreatedAsMissing(t *testing.T) {
	ctx := WithRestaurant(context.Background(), "")
	if _, ok := RestaurantID(ctx); ok {
		t.Fatal("empty string should be treated as missing")
	}
}
