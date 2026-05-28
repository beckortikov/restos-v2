package pgsupervisor

import (
	"bytes"

	"github.com/rs/zerolog/log"
)

// pgLogger — io.Writer-адаптер: stderr Postgres → zerolog.
// embedded-postgres пишет логи pgctl/postgres напрямую в Logger().
type pgLogger struct{}

func newPGLogger() *pgLogger { return &pgLogger{} }

func (l *pgLogger) Write(p []byte) (int, error) {
	for _, line := range bytes.Split(bytes.TrimRight(p, "\n"), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		log.Debug().Str("src", "postgres").Msg(string(line))
	}
	return len(p), nil
}
