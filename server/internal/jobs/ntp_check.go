// Package jobs — фоновые задачи.
//
// ntp_check — каждые 6 часов опрашивает NTP-сервер (UDP 123) и сравнивает
// системное время с эталоном. Если delta > 1 час → log warning + сохраняем
// в shared-структуру ClockStatus (читается HTTP-эндпоинтом /license/clock-status).
//
// НЕ корректируем system time автоматически (нужны admin/root права).
// Эта инфа — только сигнал клиенту: показать banner «время на машине
// сдвинуто на N минут, проверьте часы».
package jobs

import (
	"context"
	"encoding/binary"
	"net"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// ClockStatus — публичный snapshot последней NTP-проверки.
type ClockStatus struct {
	LastCheckAt   time.Time     `json:"last_check_at"`
	NTPServer     string        `json:"ntp_server"`
	Offset        time.Duration `json:"offset"`         // ntp_time - system_time
	OffsetSeconds float64       `json:"offset_seconds"` // для frontend (json не умеет Duration)
	Drift         bool          `json:"drift"`          // |offset| > threshold
	Error         string        `json:"error,omitempty"`
}

// NTPChecker — singleton, хранит последний результат проверки.
type NTPChecker struct {
	mu       sync.RWMutex
	last     ClockStatus
	servers  []string
	interval time.Duration
	thresh   time.Duration
}

// DefaultNTPCheckInterval — 6 часов.
const DefaultNTPCheckInterval = 6 * time.Hour

// DefaultNTPDriftThreshold — 1 час. При большем offset считаем clock-drift'ом.
const DefaultNTPDriftThreshold = 1 * time.Hour

// NewNTPChecker создаёт checker с default-настройками.
func NewNTPChecker() *NTPChecker {
	return &NTPChecker{
		servers:  []string{"pool.ntp.org", "time.google.com", "time.cloudflare.com"},
		interval: DefaultNTPCheckInterval,
		thresh:   DefaultNTPDriftThreshold,
	}
}

// Status возвращает копию последней проверки.
func (n *NTPChecker) Status() ClockStatus {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.last
}

// Run блокирующе тикает раз в N часов до ctx.Done(). Первая проверка —
// сразу (warm-up), чтобы /license/clock-status вернул не-zero.
func (n *NTPChecker) Run(ctx context.Context) {
	log.Info().Dur("interval", n.interval).Msg("ntp checker: started")
	n.tick(ctx)
	t := time.NewTicker(n.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("ntp checker: stopped")
			return
		case <-t.C:
			n.tick(ctx)
		}
	}
}

// tick — один проход, пытается опросить каждый сервер по очереди.
func (n *NTPChecker) tick(ctx context.Context) {
	var status ClockStatus
	status.LastCheckAt = time.Now().UTC()

	for _, srv := range n.servers {
		ntpTime, err := queryNTP(ctx, srv, 3*time.Second)
		if err != nil {
			status.Error = err.Error()
			status.NTPServer = srv
			continue
		}
		offset := ntpTime.Sub(time.Now())
		status.NTPServer = srv
		status.Offset = offset
		status.OffsetSeconds = offset.Seconds()
		status.Error = ""
		if absDuration(offset) > n.thresh {
			status.Drift = true
			log.Warn().
				Str("ntp", srv).
				Dur("offset", offset).
				Msg("ntp checker: significant clock drift detected")
		} else {
			log.Info().
				Str("ntp", srv).
				Dur("offset", offset).
				Msg("ntp checker: clock OK")
		}
		break // успешный ответ, выходим из цикла серверов
	}

	n.mu.Lock()
	n.last = status
	n.mu.Unlock()
}

// queryNTP — минимальный SNTP-клиент. Отправляет 48-байтный пакет на
// UDP:123 и парсит ответ. Возвращает время сервера в UTC.
//
// Формат NTP packet см. RFC 5905. Нам нужен только Transmit Timestamp
// (bytes 40..47) — 64-bit fixed point с эпохой 1900-01-01.
func queryNTP(ctx context.Context, server string, timeout time.Duration) (time.Time, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "udp", server+":123")
	if err != nil {
		return time.Time{}, err
	}
	defer conn.Close()

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return time.Time{}, err
	}

	// NTP v4, client mode (0x1B = 00 011 011).
	req := make([]byte, 48)
	req[0] = 0x1B
	if _, err := conn.Write(req); err != nil {
		return time.Time{}, err
	}
	resp := make([]byte, 48)
	if _, err := conn.Read(resp); err != nil {
		return time.Time{}, err
	}

	// Transmit Timestamp: bytes 40..47.
	secs := binary.BigEndian.Uint32(resp[40:44])
	frac := binary.BigEndian.Uint32(resp[44:48])
	// NTP epoch = 1900-01-01; Unix epoch = 1970-01-01.
	const ntpUnixDelta = 2208988800
	if secs < ntpUnixDelta {
		return time.Time{}, errNTPBadResp
	}
	unixSec := int64(secs) - ntpUnixDelta
	nsec := int64(float64(frac) * 1e9 / (1 << 32))
	return time.Unix(unixSec, nsec).UTC(), nil
}

var errNTPBadResp = ntpErr("ntp: unexpected response timestamp")

type ntpErr string

func (e ntpErr) Error() string { return string(e) }

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
