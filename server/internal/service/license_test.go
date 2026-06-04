package service

import (
	"testing"
	"time"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// TestLicense_GracePeriods — три ресторана с разными per-key настройками,
// все с expires_at=вчера. computeState должен трактовать каждый по своим
// колонкам, а не по глобальным константам.
func TestLicense_GracePeriods(t *testing.T) {
	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	yesterday := now.AddDate(0, 0, -1)

	cases := []struct {
		name        string
		graceDays   int
		warningDays int
		want        State
	}{
		// 0+0: hard lock сразу после expires (новый клиент).
		{"hard_lock_0_0", 0, 0, StateLocked},
		// 7+7: вчера → ещё в grace (день 1 из 7).
		{"grace_7_7", 7, 7, StateGrace},
		// 14+14: вчера → ещё в grace.
		{"grace_14_14", 14, 14, StateGrace},
		// 1+0: вчера → grace окончился ровно, warning=0 → locked.
		// (вчера 12:00 + 1d = сегодня 12:00, сейчас = сегодня 12:00, NOT before → fallthrough → locked).
		// Чтобы тест был стабилен, добавим явный микро-сдвиг — locked.
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := models.Restaurant{
				LicenseExpiresAt:   &yesterday,
				LicenseGraceDays:   tc.graceDays,
				LicenseWarningDays: tc.warningDays,
			}
			got := computeState(r, now)
			if got != tc.want {
				t.Errorf("graceDays=%d warningDays=%d: got state=%q, want %q",
					tc.graceDays, tc.warningDays, got, tc.want)
			}
		})
	}
}

// TestLicense_StateBoundaries — точные границы переходов active→grace→warning→locked.
func TestLicense_StateBoundaries(t *testing.T) {
	exp := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	r := models.Restaurant{
		LicenseExpiresAt:   &exp,
		LicenseGraceDays:   7,
		LicenseWarningDays: 7,
	}
	cases := []struct {
		offset time.Duration
		want   State
	}{
		{-1 * time.Hour, StateActive},
		{1 * time.Hour, StateGrace},
		{7*24*time.Hour - time.Hour, StateGrace},
		{8 * 24 * time.Hour, StateWarning},
		{14*24*time.Hour - time.Hour, StateWarning},
		{15 * 24 * time.Hour, StateLocked},
	}
	for _, tc := range cases {
		got := computeState(r, exp.Add(tc.offset))
		if got != tc.want {
			t.Errorf("offset=%v: got %q, want %q", tc.offset, got, tc.want)
		}
	}
}
